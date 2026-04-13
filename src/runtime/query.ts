import type { ModelRecord } from '../../common/types.js';
import type { ModelRegistry } from '../../common/registry.js';
import type { DataReader, IndexReader } from '../../common/provider.js';
import { QueryError } from '../../common/errors.js';
import {
  HydratedEntity,
  type HydrationContext,
  type QueryExecuteOptions,
} from './HydratedEntity.js';
import {
  ComputeBuilder,
  isComputeMetricToken,
  mergeComputeTokens,
  type ComputeMetricToken,
} from './compute-builder.js';
import { GroupInstance } from './group-instance.js';
import {
  collectDescendantIdsFromSeed,
  collectRecursiveRelationIdsBFS,
} from './recursive-relate.js';
import {
  resolveRelationOnRegistry,
  targetModelName,
  type ResolvedRelation,
} from './relation-resolve.js';
import { normalizeOperator, type RecordPredicate } from './query-filter.js';
import {
  FilterBuilder,
  PredicateComposer,
  compileSegments,
  mergeMatchAnyIntoSegment,
} from './filter-builder.js';
import {
  clonePredicateNode,
  evaluatePredicate,
  predicateMatcher,
  serializePredicate,
  tryExtractSingleIdEq,
  treeHasCallback,
  type PredicateNode,
} from './predicate-tree.js';
import { QueryEngine, type EvaluateResult } from './query-engine.js';
import {
  Aggregator,
  AggregatorEngine,
  AnalysisResult,
  expandBuiltinAggregateSpec,
  resolveGroupKeyValues,
  type AggregateInputEntry,
  type AggregateOp,
  type AnalysisMetricMetadata,
  type CustomReducerSpec,
  type GroupKeyContext,
} from './transform-engine.js';

export type { LocalFilterState } from './query-filter.js';
export type {
  PredicateNode,
  AtomNode,
  GroupNode,
  CallbackNode,
  PredicateStandardOperator,
  PredicateAtomOperator,
  PredicateEvaluateContext,
  PredicateFailureKind,
} from './predicate-tree.js';
export type { EvaluateResult } from './query-engine.js';
export type {
  AggregateOp,
  AggregateInputEntry,
  AggregationProtocolOp,
  AnalysisReport,
  AnalysisFlatRow,
  AnalysisRunMetadata,
  AnalysisMetricMetadata,
  AnalysisBucketMetadataRow,
  AnalysisTraceability,
  AnalysisTraceabilityBucket,
  AnalysisTraceabilityMetric,
  CustomReducerSpec,
  TraceableNull,
  PivotLeafNode,
  ParsedGroupDimension,
} from './transform-engine.js';
export {
  isAnalysisReport,
  isAnalysisResult,
  DataPivot,
  PivotTable,
  PivotHydratedRecursiveBuilder,
  PIVOT_UNLINKED_KEY,
  PIVOT_LEAF_SYMBOL,
  isPivotLeafNode,
  resolveHydratedPivotSegment,
  parseGroupDimension,
  readFieldPathSync,
  pivotSegmentKey,
  Aggregator,
  AggregatorEngine,
  AggregationProtocol,
  BucketAggregator,
  AnalysisResult,
  buildAnalysisRunMetadata,
  buildAnalysisTraceability,
  expandBuiltinAggregateSpec,
  isMetricsLeafShape,
  StatAccumulator,
  TRACEABLE_REASON_ALL_MISSING,
  traceableNull,
  isTraceableNull,
  isStatMissing,
  coerceFiniteNumber,
} from './transform-engine.js';

/** @deprecated 使用 {@link FilterBuilder} */
export const RelateFilterBuilder = FilterBuilder;

export type QueryStartSpec =
  | { readonly kind: 'all' }
  | { readonly kind: 'ids'; readonly ids: readonly string[] };

interface HopPlan {
  readonly relationName: string;
  readonly sourcePredicate: PredicateNode;
  readonly targetPredicate: PredicateNode;
  /** 自关联 / 多级寻址：BFS 扩展，每层仅累计 ID，最后统一 `getByIds` */
  readonly recursive?: { readonly maxDepth: number };
}

/** 分页执行结果：`execute()` 在设置 **`limit`**（链或 options）时返回本结构。 */
export interface Paginated<T> {
  readonly items: T;
  readonly total: number;
  /** 0-based */
  readonly page: number;
  readonly limit: number;
  readonly pageCount: number;
}

export function isPaginatedExecuteResult(x: unknown): x is Paginated<unknown> {
  return (
    typeof x === 'object' &&
    x !== null &&
    'items' in x &&
    'total' in x &&
    'page' in x &&
    'limit' in x &&
    'pageCount' in x
  );
}

/** 查询计划快照 v2：谓词树（JSON 可序列化部分见 `serializePredicate`） */
export interface QueryPlanASTv2 {
  readonly version: 2;
  readonly originModel: string;
  readonly start: QueryStartSpec;
  readonly hops: ReadonlyArray<{
    readonly relationName: string;
    readonly source: Record<string, unknown>;
    readonly target: Record<string, unknown>;
    readonly recursive?: { readonly maxDepth: number };
  }>;
  readonly trailing: Record<string, unknown>;
}

type OriginLoadHint =
  | { readonly kind: 'by_uuid'; readonly id: string }
  | { readonly kind: 'by_business_id'; readonly value: unknown };

function tryOptimizedOriginLoad(root: PredicateNode): OriginLoadHint | undefined {
  const atom = tryExtractSingleIdEq(root);
  if (!atom) {
    return undefined;
  }
  if (atom.field === '_id') {
    return { kind: 'by_uuid', id: String(atom.value) };
  }
  return { kind: 'by_business_id', value: atom.value };
}

function filterRecordsWithTrace(
  records: ModelRecord[],
  root: PredicateNode,
): { passed: ModelRecord[]; firstFailure?: EvaluateResult } {
  const passed: ModelRecord[] = [];
  let firstFailure: EvaluateResult | undefined;
  for (const rec of records) {
    const ev = QueryEngine.evaluate(rec, root);
    if (ev.ok) {
      passed.push(rec);
    } else if (!firstFailure) {
      firstFailure = ev;
    }
  }
  return { passed, firstFailure };
}

/**
 * 流式查询链：段内 AND、段间 OR；谓词任意深度嵌套。
 * 未配置 **`groupBy` / `pivot`** 时 {@link execute} 返回 {@link HydratedEntity}[]；配置后返回 {@link AnalysisResult}。
 */
export class QueryChain<
  M extends Record<string, unknown> = Record<string, unknown>,
  Mode extends 'rows' | 'analysis' = 'rows',
> {
  private readonly segments: PredicateNode[][] = [[]];
  private readonly hops: HopPlan[] = [];
  private readonly originModel: string;
  private readonly start: QueryStartSpec;
  private analysisGroupBy: string[] | null = null;
  private analysisCompute: Record<string, AggregateInputEntry> | null = null;
  private readonly analysisCustom: Record<string, CustomReducerSpec> = {};
  private paginationPartial: { page?: number; limit?: number } | null = null;
  private wrapGroupsFlag = false;

  constructor(
    private readonly registry: ModelRegistry,
    private readonly indexReader: IndexReader,
    private readonly dataReader: DataReader,
    startModel: string,
    start: QueryStartSpec,
  ) {
    this.originModel = startModel;
    this.start = start;
  }

  getQueryPlan(): QueryPlanASTv2 {
    return this._buildRawQuery();
  }

  private _buildRawQuery(): QueryPlanASTv2 {
    return {
      version: 2,
      originModel: this.originModel,
      start: this.start,
      hops: this.hops.map((h) => ({
        relationName: h.relationName,
        source: serializePredicate(h.sourcePredicate),
        target: serializePredicate(h.targetPredicate),
        ...(h.recursive ? { recursive: { maxDepth: h.recursive.maxDepth } } : {}),
      })),
      trailing: serializePredicate(this.compiledRoot()),
    };
  }

  private currentSegment(): PredicateNode[] {
    return this.segments[this.segments.length - 1]!;
  }

  private compiledRoot(): PredicateNode {
    return compileSegments(this.segments);
  }

  is<K extends keyof M & string>(field: K, value: M[K]): this {
    this.currentSegment().push({
      type: 'atom',
      field,
      op: 'eq',
      value: value as unknown,
    });
    return this;
  }

  not<K extends keyof M & string>(field: K, value: M[K]): this {
    this.currentSegment().push({
      type: 'atom',
      field,
      op: 'neq',
      value: value as unknown,
    });
    return this;
  }

  gt<K extends keyof M & string>(field: K, value: unknown): this {
    this.currentSegment().push({ type: 'atom', field, op: 'gt', value });
    return this;
  }

  lt<K extends keyof M & string>(field: K, value: unknown): this {
    this.currentSegment().push({ type: 'atom', field, op: 'lt', value });
    return this;
  }

  greaterThan<K extends keyof M & string>(field: K, value: unknown): this {
    return this.gt(field, value);
  }

  lessThan<K extends keyof M & string>(field: K, value: unknown): this {
    return this.lt(field, value);
  }

  contains<K extends keyof M & string>(field: K, substring: string): this {
    this.currentSegment().push({ type: 'atom', field, op: 'like', value: substring });
    return this;
  }

  inside<K extends keyof M & string>(field: K, values: readonly unknown[]): this {
    this.currentSegment().push({ type: 'atom', field, op: 'in', value: [...values] });
    return this;
  }

  between<K extends keyof M & string>(field: K, min: unknown, max: unknown): this {
    this.currentSegment().push({ type: 'atom', field, op: 'between', value: [min, max] });
    return this;
  }

  /** 闭包内用 {@link FilterBuilder} 累积条件，合并为当前段内一个 AND 子树 */
  matchAll(fn: (b: FilterBuilder<M>) => void): this {
    const b = new FilterBuilder<M>();
    fn(b);
    if (!b.isEmpty()) {
      this.currentSegment().push(b.toPredicateNode());
    }
    return this;
  }

  /** 将闭包返回的多个节点依次 AND 到当前段（可与 `PredicateComposer.and/or` 嵌套配合） */
  matchAllNodes(fn: (p: PredicateComposer<M>) => readonly PredicateNode[]): this {
    for (const n of fn(new PredicateComposer<M>())) {
      this.currentSegment().push(n);
    }
    return this;
  }

  /** `(prefix ∧ b₁) ∨ (prefix ∧ b₂) ∨ …`，`prefix` 为当前段已有节点 */
  matchAny(fn: (p: PredicateComposer<M>) => readonly PredicateNode[]): this {
    mergeMatchAnyIntoSegment(this.segments, fn(new PredicateComposer<M>()));
    return this;
  }

  where(field: string, operator: string, value: unknown): this {
    const op = normalizeOperator(operator);
    this.currentSegment().push({ type: 'atom', field, op, value });
    return this;
  }

  and(field: string, operator: string, value: unknown): this {
    return this.where(field, operator, value);
  }

  or(): this {
    this.segments.push([]);
    return this;
  }

  filter(fn: RecordPredicate): this {
    this.currentSegment().push({
      type: 'callback',
      fn,
      label: 'filter',
    });
    return this;
  }

  /**
   * 多维分析：按字段路径分组（多级 → 嵌套树）。路径首段若在注册表上为关系名，则解析为该关系**首个**目标行上的后续字段（如 `in_zone.level`）。
   */
  groupBy(fields: readonly string[]): QueryChain<M, 'analysis'> {
    if (fields.length === 0) {
      throw new QueryError('groupBy() requires at least one dimension field.');
    }
    this.analysisGroupBy = [...fields];
    return this as unknown as QueryChain<M, 'analysis'>;
  }

  /**
   * 定义透视维度顺序（与 {@link groupBy} 等价）；配合 {@link aggregate} 与 {@link execute} 得到 {@link AnalysisResult}。
   */
  pivot(keys: readonly string[]): QueryChain<M, 'analysis'> {
    if (keys.length === 0) {
      throw new QueryError('pivot() requires at least one dimension field.');
    }
    this.analysisGroupBy = [...keys];
    return this as unknown as QueryChain<M, 'analysis'>;
  }

  /**
   * 合并内置聚合指标。支持 **`{ population: ['sum', 'avg'] }`**（多算子时输出键为 **`sum_population`**、**`avg_population`** 等），
   * 或与 {@link Aggregator} 链式配置；与已有 **`compute`** 结果**按源字段键合并**，键冲突抛错。
   */
  aggregate(config: Record<string, AggregateInputEntry> | Aggregator): this {
    const inc: Record<string, AggregateInputEntry> =
      config instanceof Aggregator
        ? Object.fromEntries(
            Object.entries(config.toMetricsRecord()).map(([k, v]) => [k, v as AggregateOp]),
          )
        : { ...config };
    const cur = { ...(this.analysisCompute ?? {}) };
    for (const [k, v] of Object.entries(inc)) {
      if (k in cur) {
        throw new QueryError(
          `aggregate(): field key "${k}" already exists — use compute() to replace the full builtin spec, or use a different field.`,
        );
      }
      if (k in this.analysisCustom) {
        throw new QueryError(`aggregate(): key "${k}" conflicts with customReduce().`);
      }
      cur[k] = v;
    }
    this.analysisCompute = cur;
    return this;
  }

  /**
   * 在每个分组桶内累加指标；**整表替换**内置算子映射。未调用 **`compute` / `aggregate`** 且无 **`customReduce`** 时默认为 **`{ _count: 'count' }`**。
   * 键为**行上字段名**；值可为单个 {@link AggregateOp} 或算子数组（同 {@link aggregate} 展开规则）。
   */
  compute(spec: Record<string, AggregateInputEntry>): this;
  /**
   * 语义化写法：`compute((f) => [f.sum('x'), f.avg('x')])`，内部转为与对象式 **`compute`** 相同的协议。
   */
  compute(fn: (b: ComputeBuilder) => readonly ComputeMetricToken[]): this;
  compute(
    specOrFn:
      | Record<string, AggregateInputEntry>
      | ((b: ComputeBuilder) => readonly ComputeMetricToken[]),
  ): this {
    if (typeof specOrFn === 'function') {
      const b = new ComputeBuilder();
      const arr = specOrFn(b);
      if (!Array.isArray(arr)) {
        throw new QueryError('compute(callback): callback must return an array of metric tokens.');
      }
      for (const x of arr) {
        if (!isComputeMetricToken(x)) {
          throw new QueryError(
            'compute(callback): invalid token — use ComputeBuilder methods (sum, avg, max, min, variance).',
          );
        }
      }
      this.analysisCompute = mergeComputeTokens(arr);
      return this;
    }
    this.analysisCompute = { ...specOrFn };
    return this;
  }

  /**
   * 自定义桶内折叠：**`reduce(prev, current) → next`**，与 {@link compute} 的内置算子可混用（输出键不可重复）。
   * 每一行按处理顺序调用一次（无 hop 且可流式时顺序为 `.mld` 行序；否则为末端行集数组顺序）。
   */
  customReduce(outputKey: string, spec: CustomReducerSpec): this {
    this.analysisCustom[outputKey] = spec;
    return this;
  }

  relate<Target extends Record<string, unknown> = Record<string, unknown>>(
    relationName: string,
    targetSetup?: (b: FilterBuilder<Target>) => void,
  ): this {
    const sourcePredicate = clonePredicateNode(this.compiledRoot());
    let targetPredicate: PredicateNode = { type: 'group', logic: 'AND', children: [] };
    if (targetSetup) {
      const b = new FilterBuilder<Target>();
      targetSetup(b);
      targetPredicate = b.isEmpty()
        ? { type: 'group', logic: 'AND', children: [] }
        : b.toPredicateNode();
    }
    this.hops.push({
      relationName,
      sourcePredicate,
      targetPredicate,
    });
    this.segments.length = 0;
    this.segments.push([]);
    return this;
  }

  /**
   * 自关联 / 管网：**BFS** 按层扩展 ID，全局 **seen** 防环；最后一并 **`getByIds`** 拉属性。
   * **`depth` / `maxDepth`**：最多前进的**关系跳数**（默认 32，上限 10000）。
   */
  relateRecursive<Target extends Record<string, unknown> = Record<string, unknown>>(
    relationName: string,
    options?: { readonly depth?: number; readonly maxDepth?: number },
    targetSetup?: (b: FilterBuilder<Target>) => void,
  ): this {
    const raw = options?.depth ?? options?.maxDepth ?? 32;
    const maxDepth = Math.floor(raw);
    if (maxDepth < 0 || maxDepth > 10_000) {
      throw new QueryError('relateRecursive: depth must be in [0, 10000].');
    }
    const sourcePredicate = clonePredicateNode(this.compiledRoot());
    let targetPredicate: PredicateNode = { type: 'group', logic: 'AND', children: [] };
    if (targetSetup) {
      const b = new FilterBuilder<Target>();
      targetSetup(b);
      targetPredicate = b.isEmpty()
        ? { type: 'group', logic: 'AND', children: [] }
        : b.toPredicateNode();
    }
    this.hops.push({
      relationName,
      sourcePredicate,
      targetPredicate,
      recursive: { maxDepth },
    });
    this.segments.length = 0;
    this.segments.push([]);
    return this;
  }

  /** 0-based 页码；需配合 **`limit()`** 或 **`execute({ limit })`** 才启用分页。 */
  page(index: number): this {
    const p = Math.max(0, Math.floor(index));
    this.paginationPartial = { ...this.paginationPartial, page: p };
    return this;
  }

  /** 每页条数；设置后 **`execute()`** 在过滤（及聚合）之后切片并返回 {@link Paginated}。 */
  limit(size: number): this {
    const lim = Math.max(1, Math.floor(size));
    this.paginationPartial = { ...this.paginationPartial, limit: lim };
    return this;
  }

  /**
   * 分组结果以 {@link GroupInstance} 返回（**`.getData()` / `.getEntities()` / `.query()`**）；
   * 须已配置 **`groupBy` / `pivot`**（或在 **`execute({ wrapGroups: true })`** 中指定）。
   */
  wrapGroups(): this {
    this.wrapGroupsFlag = true;
    return this;
  }

  /**
   * 无 **`groupBy` / `pivot`** 时返回 {@link HydratedEntity}[]；已配置透视维度时返回 {@link AnalysisResult} 或 {@link GroupInstance}[]；
   * 设置 **`limit`**（链上 **`.limit()`** 或 **`execute({ limit })`**）时在过滤 / 聚合之后分页，并返回 {@link Paginated}。
   *
   * 返回类型在源码中写作 **`Promise<any>`**，以便现有调用方在不显式分页时仍按数组 / {@link AnalysisResult} 使用；启用分页时请用 {@link isPaginatedExecuteResult} 收窄。
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 无分页与有分页形态不同，避免破坏既有调用方类型推断
  async execute(options?: QueryExecuteOptions): Promise<any> {
    const limitOpt = options?.limit ?? this.paginationPartial?.limit;
    const pageOpt = options?.page ?? this.paginationPartial?.page ?? 0;
    const doPage = limitOpt !== undefined && limitOpt !== null;
    const limit = doPage ? Math.max(1, Math.floor(limitOpt as number)) : 0;
    const pageIdx = Math.max(0, Math.floor(pageOpt));
    const wrapGroups = options?.wrapGroups ?? this.wrapGroupsFlag;

    if (wrapGroups && (this.analysisGroupBy === null || this.analysisGroupBy.length === 0)) {
      throw new QueryError('wrapGroups requires groupBy(...) or pivot(...).');
    }

    if (this.analysisGroupBy !== null && this.analysisGroupBy.length > 0) {
      if (options?.includeRelates) {
        throw new QueryError(
          'Pivot / groupBy analysis does not support includeRelates in this version.',
        );
      }

      if (wrapGroups) {
        const allGroups = await this.buildAllGroupInstances();
        if (doPage) {
          const total = allGroups.length;
          const off = pageIdx * limit;
          return this.wrapPaginated(allGroups.slice(off, off + limit), total, pageIdx, limit);
        }
        return allGroups as unknown as Mode extends 'analysis'
          ? AnalysisResult | GroupInstance[]
          : HydratedEntity[];
      }

      const { map, meta } = await this.executeAggregation();
      const ar = new AnalysisResult(this.analysisGroupBy, map, meta);
      if (doPage) {
        const total = ar.bucketCount;
        return this.wrapPaginated(ar.sliceBuckets(pageIdx, limit), total, pageIdx, limit);
      }
      return ar as unknown as Mode extends 'analysis'
        ? AnalysisResult | GroupInstance[]
        : HydratedEntity[];
    }

    if (options?.includeRelates) {
      const rows = await this.executeWithRelates();
      if (doPage) {
        const total = rows.length;
        const off = pageIdx * limit;
        return this.wrapPaginated(rows.slice(off, off + limit), total, pageIdx, limit);
      }
      return rows as unknown as Mode extends 'analysis'
        ? AnalysisResult | GroupInstance[]
        : HydratedEntity[];
    }

    const flat = await this.executeFlat();
    if (doPage) {
      const total = flat.length;
      const off = pageIdx * limit;
      return this.wrapPaginated(flat.slice(off, off + limit), total, pageIdx, limit);
    }
    return flat as unknown as Mode extends 'analysis'
      ? AnalysisResult | GroupInstance[]
      : HydratedEntity[];
  }

  private wrapPaginated<T>(items: T, total: number, page: number, lim: number): Paginated<T> {
    return {
      items,
      total,
      page,
      limit: lim,
      pageCount: lim > 0 ? Math.ceil(total / lim) : 0,
    };
  }

  /**
   * 等价于在已配置 **`groupBy` / `pivot`** 时调用 {@link execute}；返回 {@link AnalysisResult} 或 {@link GroupInstance}[]。
   * 若链上启用了分页（**`limit`**），本方法只返回 **`items`**，不返回 {@link Paginated} 外壳。
   */
  async analyze(): Promise<AnalysisResult | GroupInstance[]> {
    if (this.analysisGroupBy === null || this.analysisGroupBy.length === 0) {
      throw new QueryError('analyze() requires at least one groupBy(...) or pivot(...) field.');
    }
    const r = await this.execute();
    if (isPaginatedExecuteResult(r)) {
      return r.items as AnalysisResult | GroupInstance[];
    }
    return r as AnalysisResult | GroupInstance[];
  }

  /**
   * 分析管道：**先**按谓词树过滤行，**再**解析分组键，**最后**写入桶内聚合（流式路径对每条扫描记录同样顺序执行）。
   */
  private async executeAggregation(): Promise<{
    map: Map<string, Record<string, unknown>>;
    meta: Map<string, Record<string, AnalysisMetricMetadata>>;
  }> {
    const groupBy = this.analysisGroupBy!;
    const custom = { ...this.analysisCustom };
    let rawEntries: Record<string, AggregateInputEntry> = { ...(this.analysisCompute ?? {}) };
    if (Object.keys(rawEntries).length === 0 && Object.keys(custom).length === 0) {
      rawEntries = { _count: 'count' };
    }
    const { spec, sourceFieldByOutputKey } = expandBuiltinAggregateSpec(rawEntries);
    for (const k of Object.keys(spec)) {
      if (k in custom) {
        throw new QueryError(
          `Aggregate output key "${k}" cannot appear in both compute()/aggregate() and customReduce().`,
        );
      }
    }
    const engine = new AggregatorEngine(spec, custom, sourceFieldByOutputKey);
    const relationTargetCache = new Map<string, ModelRecord | undefined>();
    const gctx: GroupKeyContext = {
      registry: this.registry,
      indexReader: this.indexReader,
      dataReader: this.dataReader,
      relationTargetCache,
    };

    const root = this.compiledRoot();
    const matcher = predicateMatcher(root);

    const canStream =
      this.hops.length === 0 &&
      typeof this.dataReader.scanModelRecords === 'function' &&
      !treeHasCallback(root);

    if (canStream) {
      await this.dataReader.scanModelRecords!(this.originModel, async (rec) => {
        if (!matcher(rec)) {
          return;
        }
        const keys = await resolveGroupKeyValues(rec, this.originModel, groupBy, gctx);
        engine.ingestRow(keys, rec as Record<string, unknown>);
      });
    } else {
      const { modelName, records } = await this.fetchTerminalRecordsForAnalysis();
      for (const rec of records) {
        const keys = await resolveGroupKeyValues(rec, modelName, groupBy, gctx);
        engine.ingestRow(keys, rec as Record<string, unknown>);
      }
    }

    return {
      map: engine.finalizeBucketMap(),
      meta: engine.finalizeBucketMetadataMap(),
    };
  }

  private async fetchTerminalRecordsForAnalysis(): Promise<{
    modelName: string;
    records: ModelRecord[];
  }> {
    if (this.hops.length === 0) {
      let records = await this.loadOriginRecordsNoHop();
      records = records.filter(predicateMatcher(this.compiledRoot()));
      return { modelName: this.originModel, records };
    }

    let model = this.originModel;
    let records = await this.loadOriginRecords(this.hops[0]!.sourcePredicate);
    records = records.filter(predicateMatcher(this.hops[0]!.sourcePredicate));
    if (records.length === 0) {
      return { modelName: model, records };
    }

    for (let i = 0; i < this.hops.length; i++) {
      const hop = this.hops[i]!;
      if (i > 0) {
        records = records.filter(predicateMatcher(hop.sourcePredicate));
        if (records.length === 0) {
          return { modelName: model, records };
        }
      }

      const resolved = resolveRelationOnRegistry(this.registry, hop.relationName, model);
      const nextModel = targetModelName(resolved);
      if (hop.recursive) {
        const allIds = await collectRecursiveRelationIdsBFS(
          this.indexReader,
          resolved,
          records,
          hop.recursive.maxDepth,
        );
        records = await this.dataReader.getByIds(nextModel, [...allIds]);
        records = records.filter(predicateMatcher(hop.targetPredicate));
        if (records.length === 0) {
          return { modelName: nextModel, records: [] };
        }
        model = nextModel;
        continue;
      }

      const nextIds = await this.collectNextIds(resolved, records);
      if (nextIds.length === 0) {
        return { modelName: nextModel, records: [] };
      }

      records = await this.dataReader.getByIds(nextModel, nextIds);
      records = records.filter(predicateMatcher(hop.targetPredicate));
      if (records.length === 0) {
        return { modelName: nextModel, records: [] };
      }
      model = nextModel;
    }

    const tail = this.compiledRoot();
    records = records.filter(predicateMatcher(tail));
    return { modelName: model, records };
  }

  private ctx(): HydrationContext {
    return {
      registry: this.registry,
      indexReader: this.indexReader,
      dataReader: this.dataReader,
    };
  }

  private async loadOriginRecords(sourcePredicate: PredicateNode): Promise<ModelRecord[]> {
    if (this.start.kind === 'ids') {
      if (this.start.ids.length === 0) {
        return [];
      }
      return this.dataReader.getByIds(this.originModel, [...this.start.ids]);
    }

    const root = sourcePredicate;
    if (!treeHasCallback(root)) {
      const hint = tryOptimizedOriginLoad(root);
      if (hint?.kind === 'by_uuid') {
        const rows = await this.dataReader.getByIds(this.originModel, [hint.id]);
        const m = predicateMatcher(root);
        return rows.filter(m);
      }
      if (hint?.kind === 'by_business_id' && this.dataReader.findFirstByFieldEq) {
        const hit = await this.dataReader.findFirstByFieldEq(this.originModel, 'id', hint.value);
        if (!hit) {
          return [];
        }
        return QueryEngine.matches(hit, root) ? [hit] : [];
      }
    }

    return this.dataReader.getAll(this.originModel);
  }

  private async loadOriginRecordsNoHop(): Promise<ModelRecord[]> {
    return this.loadOriginRecords(this.compiledRoot());
  }

  private async executeFlat(): Promise<HydratedEntity[]> {
    const c = this.ctx();

    if (this.hops.length === 0) {
      let records = await this.loadOriginRecordsNoHop();
      const root = this.compiledRoot();
      records = records.filter(predicateMatcher(root));
      return records.map((r) => new HydratedEntity(r, this.originModel, c));
    }

    let model = this.originModel;
    let records = await this.loadOriginRecords(this.hops[0]!.sourcePredicate);
    records = records.filter(predicateMatcher(this.hops[0]!.sourcePredicate));
    if (records.length === 0) {
      return [];
    }

    for (let i = 0; i < this.hops.length; i++) {
      const hop = this.hops[i]!;
      if (i > 0) {
        records = records.filter(predicateMatcher(hop.sourcePredicate));
        if (records.length === 0) {
          return [];
        }
      }

      const resolved = resolveRelationOnRegistry(this.registry, hop.relationName, model);
      const nextModel = targetModelName(resolved);
      if (hop.recursive) {
        const allIds = await collectRecursiveRelationIdsBFS(
          this.indexReader,
          resolved,
          records,
          hop.recursive.maxDepth,
        );
        records = await this.dataReader.getByIds(nextModel, [...allIds]);
        records = records.filter(predicateMatcher(hop.targetPredicate));
        if (records.length === 0) {
          return [];
        }
        model = nextModel;
        continue;
      }

      const nextIds = await this.collectNextIds(resolved, records);
      if (nextIds.length === 0) {
        return [];
      }

      records = await this.dataReader.getByIds(nextModel, nextIds);
      records = records.filter(predicateMatcher(hop.targetPredicate));
      if (records.length === 0) {
        return [];
      }
      model = nextModel;
    }

    const tail = this.compiledRoot();
    records = records.filter(predicateMatcher(tail));
    return records.map((r) => new HydratedEntity(r, model, c));
  }

  private async executeWithRelates(): Promise<HydratedEntity[]> {
    const c = this.ctx();

    if (this.hops.length === 0) {
      let records = await this.loadOriginRecordsNoHop();
      records = records.filter(predicateMatcher(this.compiledRoot()));
      return records.map((r) => new HydratedEntity(r, this.originModel, c));
    }

    const model = this.originModel;
    let records = await this.loadOriginRecords(this.hops[0]!.sourcePredicate);
    records = records.filter(predicateMatcher(this.hops[0]!.sourcePredicate));
    if (records.length === 0) {
      return [];
    }

    const roots = records.map((r) => new HydratedEntity(r, model, c));
    let frontier: HydratedEntity[] = roots;
    let frontierModel = model;

    for (let hi = 0; hi < this.hops.length; hi++) {
      const hop = this.hops[hi]!;
      const resolved = resolveRelationOnRegistry(this.registry, hop.relationName, frontierModel);
      const nextModel = targetModelName(resolved);
      const targetRoot = hop.targetPredicate;
      const nextFrontier: HydratedEntity[] = [];

      for (const entity of frontier) {
        const srcRec = entity.getData();

        if (hi > 0) {
          const srcEv = evaluatePredicate(srcRec, hop.sourcePredicate);
          if (!srcEv.ok) {
            entity._setRelate(hop.relationName, []);
            entity._setDiagnostic(hop.relationName, {
              reason: 'FILTERED_OUT_WHERE',
              message: `Source on "${frontierModel}" did not match filters before "${hop.relationName}": ${formatFailureLine(srcEv)}.`,
              failedPredicate: srcEv.failedAt ? serializePredicate(srcEv.failedAt) : undefined,
            });
            continue;
          }
        }

        const id = srcRec._id;

        if (hop.recursive) {
          const descSet = await collectDescendantIdsFromSeed(
            this.indexReader,
            resolved,
            id,
            hop.recursive.maxDepth,
          );
          const idsList = [...descSet];
          const childRecords =
            idsList.length === 0 ? [] : await this.dataReader.getByIds(nextModel, idsList);
          const orphan = childRecords.length < idsList.length;
          if (orphan) {
            const got = new Set(childRecords.map((r) => r._id));
            const missing = idsList.filter((lid) => !got.has(lid));
            entity._setDiagnostic(hop.relationName, {
              reason: 'FILTERED_OUT_ORPHAN',
              message: `Recursive "${hop.relationName}": expected ${idsList.length} row(s) in "${nextModel}.mld", got ${childRecords.length}; missing _id: ${missing.join(', ')}.`,
            });
          }
          const { passed, firstFailure } = filterRecordsWithTrace(childRecords, targetRoot);
          if (passed.length === 0) {
            if (!orphan) {
              entity._setDiagnostic(hop.relationName, {
                reason: 'FILTERED_OUT_WHERE',
                message: `All recursive "${hop.relationName}" rows were removed by target filters${firstFailure?.failedAt ? `: ${formatFailureLine(firstFailure)}` : ''}.`,
                failedPredicate: firstFailure?.failedAt
                  ? serializePredicate(firstFailure.failedAt)
                  : undefined,
              });
            }
            entity._setRelate(hop.relationName, []);
            continue;
          }
          const children = passed.map((r) => new HydratedEntity(r, nextModel, c));
          entity._setRelate(hop.relationName, children);
          nextFrontier.push(...children);
          continue;
        }

        const linked = await this.linkedIds(resolved, id);

        if (linked.length === 0) {
          entity._setRelate(hop.relationName, []);
          entity._setDiagnostic(hop.relationName, {
            reason: 'NO_LINK_IN_INDEX',
            message: `No edges in .rid for "${frontierModel}" _id "${id}" via "${hop.relationName}".`,
          });
          continue;
        }

        const childRecords = await this.dataReader.getByIds(nextModel, linked);
        const orphan = childRecords.length < linked.length;

        if (orphan) {
          const missing = linked.filter((lid) => !childRecords.some((rec) => rec._id === lid));
          entity._setDiagnostic(hop.relationName, {
            reason: 'FILTERED_OUT_ORPHAN',
            message: `Index listed ${linked.length} id(s) for "${hop.relationName}" but only ${childRecords.length} row(s) in "${nextModel}.mld"; missing _id: ${missing.join(', ')}.`,
          });
        }

        const { passed, firstFailure } = filterRecordsWithTrace(childRecords, targetRoot);
        if (passed.length === 0) {
          if (!orphan) {
            entity._setDiagnostic(hop.relationName, {
              reason: 'FILTERED_OUT_WHERE',
              message: `All linked "${nextModel}" rows were removed by target filters on "${hop.relationName}"${firstFailure?.failedAt ? `: ${formatFailureLine(firstFailure)}` : ''}.`,
              failedPredicate: firstFailure?.failedAt
                ? serializePredicate(firstFailure.failedAt)
                : undefined,
            });
          }
          entity._setRelate(hop.relationName, []);
          continue;
        }

        const children = passed.map((r) => new HydratedEntity(r, nextModel, c));
        entity._setRelate(hop.relationName, children);
        nextFrontier.push(...children);
      }

      frontier = nextFrontier;
      frontierModel = nextModel;
    }

    return roots;
  }

  private async linkedIds(resolved: ResolvedRelation, id: string): Promise<string[]> {
    return resolved.direction === 'forward'
      ? this.indexReader.getForward(resolved.definition, id)
      : this.indexReader.getReverse(resolved.definition, id);
  }

  private async collectNextIds(
    resolved: ResolvedRelation,
    records: ModelRecord[],
  ): Promise<string[]> {
    const nextSet = new Set<string>();
    for (const rec of records) {
      const linked = await this.linkedIds(resolved, rec._id);
      for (const linkedId of linked) {
        nextSet.add(linkedId);
      }
    }
    return [...nextSet];
  }

  private resolvedTerminalModelName(): string {
    let model = this.originModel;
    for (const hop of this.hops) {
      const resolved = resolveRelationOnRegistry(this.registry, hop.relationName, model);
      model = targetModelName(resolved);
    }
    return model;
  }

  private async collectMembersByBucketKey(): Promise<Map<string, HydratedEntity[]>> {
    const groupBy = this.analysisGroupBy!;
    const members = new Map<string, HydratedEntity[]>();
    const relationTargetCache = new Map<string, ModelRecord | undefined>();
    const gctx: GroupKeyContext = {
      registry: this.registry,
      indexReader: this.indexReader,
      dataReader: this.dataReader,
      relationTargetCache,
    };
    const root = this.compiledRoot();
    const matcher = predicateMatcher(root);

    const push = (keyTuple: string, rec: ModelRecord, modelName: string) => {
      const list = members.get(keyTuple) ?? [];
      list.push(new HydratedEntity(rec, modelName, this.ctx()));
      members.set(keyTuple, list);
    };
    const keyStr = (vals: unknown[]) => JSON.stringify(vals);

    const canStream =
      this.hops.length === 0 &&
      typeof this.dataReader.scanModelRecords === 'function' &&
      !treeHasCallback(root);

    if (canStream) {
      await this.dataReader.scanModelRecords!(this.originModel, async (rec) => {
        if (!matcher(rec)) {
          return;
        }
        const keys = await resolveGroupKeyValues(rec, this.originModel, groupBy, gctx);
        push(keyStr(keys), rec, this.originModel);
      });
    } else {
      const { modelName, records } = await this.fetchTerminalRecordsForAnalysis();
      for (const rec of records) {
        const keys = await resolveGroupKeyValues(rec, modelName, groupBy, gctx);
        push(keyStr(keys), rec, modelName);
      }
    }
    return members;
  }

  private async buildAllGroupInstances(): Promise<GroupInstance[]> {
    const { map } = await this.executeAggregation();
    const membersMap = await this.collectMembersByBucketKey();
    const terminalModel = this.resolvedTerminalModelName();
    const orderedKeys = [...map.keys()].sort((a, b) => a.localeCompare(b));
    return orderedKeys.map((k) => {
      const dimVals = JSON.parse(k) as unknown[];
      return new GroupInstance(
        this.analysisGroupBy!,
        dimVals,
        map.get(k)!,
        membersMap.get(k) ?? [],
        terminalModel,
        this.ctx(),
        newGroupQueryChainForGroup,
      );
    });
  }
}

function newGroupQueryChainForGroup(
  registry: ModelRegistry,
  indexReader: IndexReader,
  dataReader: DataReader,
  originModel: string,
  ids: readonly string[],
): QueryChain {
  return new QueryChain(registry, indexReader, dataReader, originModel, {
    kind: 'ids',
    ids: [...ids],
  });
}

function formatFailureLine(ev: EvaluateResult): string {
  if (ev.ok || !ev.failedAt) {
    return '';
  }
  const n = ev.failedAt;
  if (n.type === 'atom') {
    return `atom ${n.field} ${n.op} ${JSON.stringify(n.value)}`;
  }
  if (n.type === 'callback') {
    return n.label ? `callback(${n.label})` : 'callback';
  }
  return `${n.logic} group`;
}

export type { QueryExecuteOptions } from './HydratedEntity.js';
export {
  ComputeBuilder,
  isComputeMetricToken,
  mergeComputeTokens,
  type ComputeMetricToken,
} from './compute-builder.js';
export { GroupInstance, isGroupInstance } from './group-instance.js';
export {
  collectDescendantIdsFromSeed,
  collectRecursiveRelationIdsBFS,
} from './recursive-relate.js';
export {
  FilterBuilder,
  PredicateComposer,
  mergeMatchAnyIntoSegment,
  compileSegments,
} from './filter-builder.js';
export { QueryEngine, mergeDiskRowsWithAuthoringBuffer } from './query-engine.js';

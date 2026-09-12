import type { ModelRecord, ModelRegistry, DataReader, IndexReader } from '@mode-db/common';
import type { QueryOrderEntry } from '@mode-db/shared';
import { QueryError } from '@mode-db/common';
import type { HydratedEntity } from './HydratedEntity.js';
import { evaluatePredicate, type PredicateNode } from './predicate-tree.js';
import {
  BucketAggregator,
  isTraceableNull,
  type AggregationProtocolOp,
  type BucketMetricSnapshot,
} from './stat-accumulator.js';
import {
  resolveRelationOnRegistry,
  targetModelName,
  type ResolvedRelation,
} from './relation-resolve.js';
import { parseGroupDimension, readFieldPathSync, pivotSegmentKey } from './group-dimension.js';
import {
  PivotHydratedRecursiveBuilder,
  PIVOT_UNLINKED_KEY,
  PIVOT_LEAF_SYMBOL,
  isPivotLeafNode,
  resolveHydratedPivotSegment,
} from './pivot-from-hydrated.js';

export {
  parseGroupDimension,
  readFieldPathSync,
  pivotSegmentKey,
  type ParsedGroupDimension,
} from './group-dimension.js';
export {
  PivotHydratedRecursiveBuilder,
  PIVOT_UNLINKED_KEY,
  PIVOT_LEAF_SYMBOL,
  isPivotLeafNode,
  resolveHydratedPivotSegment,
  type PivotLeafNode,
} from './pivot-from-hydrated.js';

export type { TraceableNull, AggregationProtocolOp } from './stat-accumulator.js';
export {
  StatAccumulator,
  BucketAggregator,
  AggregationProtocol,
  TRACEABLE_REASON_ALL_MISSING,
  traceableNull,
  isTraceableNull,
  isStatMissing,
  coerceFiniteNumber,
} from './stat-accumulator.js';

/** 支持的聚合算子（与 {@link AggregationProtocol} 一致，按桶内流式累加）。 */
export type AggregateOp = AggregationProtocolOp;

/** `aggregate` / `compute` 中单字段可配置多个算子：`{ population: ['sum', 'avg'] }`。 */
export type AggregateInputEntry = AggregateOp | readonly AggregateOp[];

/**
 * 将 `{ field: op | op[] }` 展开为输出键 → 算子，并记录每键对应的源字段（行上取值列）。
 * 多算子时输出键为 **`{op}_{field}`**（如 **`sum_population`**、**`variance_population`**）；单算子仍用 **`field`** 作输出键。
 */
export function expandBuiltinAggregateSpec(raw: Readonly<Record<string, AggregateInputEntry>>): {
  spec: Record<string, AggregateOp>;
  sourceFieldByOutputKey: Record<string, string>;
} {
  const spec: Record<string, AggregateOp> = {};
  const sourceFieldByOutputKey: Record<string, string> = {};
  for (const [field, entry] of Object.entries(raw)) {
    const ops: AggregateOp[] = Array.isArray(entry) ? [...entry] : [entry];
    const useCompoundKey = ops.length > 1;
    for (const op of ops) {
      const outKey = useCompoundKey ? `${op}_${field}` : field;
      if (Object.prototype.hasOwnProperty.call(spec, outKey)) {
        throw new QueryError(
          `expandBuiltinAggregateSpec: duplicate output key "${outKey}" for field "${field}".`,
        );
      }
      spec[outKey] = op;
      sourceFieldByOutputKey[outKey] = field;
    }
  }
  return { spec, sourceFieldByOutputKey };
}

/** 单桶单指标溯源；与 {@link BucketMetricSnapshot} 字段一致，`customReduce` 无缺失统计。 */
export interface AnalysisMetricMetadata {
  readonly outputKey: string;
  readonly sourceField: string;
  readonly op: AggregateOp | 'customReduce';
  readonly validSampleCount: number;
  readonly missingSampleCount: number;
  readonly resultHint?: string;
}

export interface AnalysisBucketMetadataRow {
  readonly dimensionValues: readonly unknown[];
  readonly metrics: Readonly<Record<string, AnalysisMetricMetadata>>;
}

/**
 * {@link AnalysisResult.getMetadata}：管道阶段说明 + 各桶指标的有效/缺失样本与结果溯源。
 */
export interface AnalysisRunMetadata {
  /** 执行顺序：谓词过滤 → 分组键解析 → 桶内聚合 */
  readonly pipeline: 'filter_then_group_then_aggregate';
  readonly dimensionKeys: readonly string[];
  readonly buckets: readonly AnalysisBucketMetadataRow[];
  readonly note: string;
}

/** {@link AnalysisResult.getTraceability}：单桶内各指标的缺口与样本统计（便于审计 UI）。 */
export interface AnalysisTraceabilityMetric {
  readonly outputKey: string;
  readonly sourceField: string;
  readonly op: AggregateOp | 'customReduce';
  readonly validSampleCount: number;
  readonly missingSampleCount: number;
  readonly resultHint?: string;
}

export interface AnalysisTraceabilityBucket {
  readonly dimensionValues: readonly unknown[];
  /** 路径上是否出现 {@link PIVOT_UNLINKED_KEY}（无边、目标行缺字段等，与递归透视语义一致） */
  readonly unlinkedOrBrokenPath: boolean;
  readonly metrics: Readonly<Record<string, AnalysisTraceabilityMetric>>;
}

/**
 * 拓扑断裂、字段缺失、过滤后的「数据缺口」视图：在 {@link AnalysisRunMetadata} 之上标注
 * **unlinkedOrBrokenPath** 并按桶列出各指标的缺失样本与结果溯源。
 */
export interface AnalysisTraceability {
  readonly pipeline: AnalysisRunMetadata['pipeline'];
  readonly dimensionKeys: readonly string[];
  readonly buckets: readonly AnalysisTraceabilityBucket[];
  readonly summary: {
    readonly bucketsWithUnlinkedPath: number;
    readonly bucketsWithMetricGaps: number;
  };
  readonly note: string;
}

export function buildAnalysisTraceability(meta: AnalysisRunMetadata): AnalysisTraceability {
  let unlinkedBuckets = 0;
  let gapBuckets = 0;
  const buckets: AnalysisTraceabilityBucket[] = meta.buckets.map((b) => {
    const unlinkedOrBrokenPath = b.dimensionValues.some(
      (v) => v === PIVOT_UNLINKED_KEY || String(v) === PIVOT_UNLINKED_KEY,
    );
    if (unlinkedOrBrokenPath) {
      unlinkedBuckets += 1;
    }
    const metrics: Record<string, AnalysisTraceabilityMetric> = {};
    let hasGap = false;
    for (const [k, m] of Object.entries(b.metrics)) {
      metrics[k] = {
        outputKey: m.outputKey,
        sourceField: m.sourceField,
        op: m.op,
        validSampleCount: m.validSampleCount,
        missingSampleCount: m.missingSampleCount,
        resultHint: m.resultHint,
      };
      if (m.missingSampleCount > 0 || m.resultHint !== undefined) {
        hasGap = true;
      }
    }
    if (hasGap) {
      gapBuckets += 1;
    }
    return { dimensionValues: b.dimensionValues, unlinkedOrBrokenPath, metrics };
  });
  return {
    pipeline: meta.pipeline,
    dimensionKeys: meta.dimensionKeys,
    buckets,
    summary: {
      bucketsWithUnlinkedPath: unlinkedBuckets,
      bucketsWithMetricGaps: gapBuckets,
    },
    note: meta.note,
  };
}

/**
 * 自定义桶内折叠：对桶内每一行按顺序调用 **`reduce`**。
 * - **首行**：`prev` 为 **`initial`**（若省略则为 **`undefined`**），`current` 为该行的取值。
 * - **后续行**：`prev` 为上一行的返回值，`current` 为当前行取值。
 *
 * @example 指数加权（闭包捕获 α，行为与行顺序一致；流式场景下顺序即 `.mld` 或末端行集顺序）
 * ```ts
 * const alpha = 0.35;
 * chain.customReduce('ema', {
 *   reduce: (prev, cur) => {
 *     const x = Number(cur);
 *     if (Number.isNaN(x)) return prev;
 *     if (prev === undefined || prev === null) return x;
 *     return alpha * x + (1 - alpha) * (prev as number);
 *   },
 *   valueField: 'growthRate',
 * });
 * ```
 */
export interface CustomReducerSpec {
  /**
   * 在**第一行**传入 **`reduce`** 时的 `prev`；省略则首行 `prev === undefined`。
   */
  readonly initial?: unknown;
  /**
   * `current` 默认取自行上 **`valueField`**；省略 **`valueField`** 时默认与 {@link QueryChain.customReduce} 的输出键相同。
   */
  readonly reduce: (prev: unknown, current: unknown) => unknown;
  readonly valueField?: string;
}

export interface AnalysisReport {
  readonly kind: 'analysis';
  readonly shape: 'tree' | 'flat';
  readonly tree?: Record<string, unknown>;
  readonly rows?: readonly AnalysisFlatRow[];
}

/** 扁平行：维度列与聚合列合并为单行对象（Excel / 表格绑定）。 */
export type AnalysisFlatRow = Record<string, unknown>;

export function isAnalysisReport(x: unknown): x is AnalysisReport {
  return (
    typeof x === 'object' &&
    x !== null &&
    (x as AnalysisReport).kind === 'analysis' &&
    ((x as AnalysisReport).shape === 'tree' || (x as AnalysisReport).shape === 'flat')
  );
}

function relationTargetCacheKey(sourceId: string, relation: string): string {
  return `${sourceId}::${relation}`;
}

async function resolveFirstTargetRecord(
  registry: ModelRegistry,
  indexReader: IndexReader,
  dataReader: DataReader,
  modelName: string,
  record: ModelRecord,
  relation: string,
  cache: Map<string, ModelRecord | undefined> | undefined,
): Promise<ModelRecord | undefined> {
  const ck = relationTargetCacheKey(record._id, relation);
  if (cache?.has(ck)) {
    return cache.get(ck);
  }

  let resolved: ResolvedRelation;
  try {
    resolved = resolveRelationOnRegistry(registry, relation, modelName);
  } catch {
    cache?.set(ck, undefined);
    return undefined;
  }

  const nextModel = targetModelName(resolved);
  const id = record._id;
  const linked =
    resolved.direction === 'forward'
      ? await indexReader.getForward(resolved.definition, id)
      : await indexReader.getReverse(resolved.definition, id);

  if (linked.length === 0) {
    cache?.set(ck, undefined);
    return undefined;
  }

  const rows = await dataReader.getByIds(nextModel, linked);
  const picked = rows.sort((a, b) => a._id.localeCompare(b._id))[0];
  cache?.set(ck, picked);
  return picked;
}

export interface GroupKeyContext {
  readonly registry: ModelRegistry;
  readonly indexReader: IndexReader;
  readonly dataReader: DataReader;
  /** 单次 analyze 内缓存：sourceId::relation → 首个目标行 */
  readonly relationTargetCache?: Map<string, ModelRecord | undefined>;
}

export async function resolveGroupKeyValues(
  record: ModelRecord,
  modelName: string,
  groupFields: readonly string[],
  ctx: GroupKeyContext,
): Promise<unknown[]> {
  const row = record as Record<string, unknown>;
  const out: unknown[] = [];

  for (const f of groupFields) {
    const parsed = parseGroupDimension(f, ctx.registry, modelName);
    if (parsed.kind === 'direct') {
      out.push(row[parsed.field]);
      continue;
    }

    const tgt = await resolveFirstTargetRecord(
      ctx.registry,
      ctx.indexReader,
      ctx.dataReader,
      modelName,
      record,
      parsed.relation,
      ctx.relationTargetCache,
    );
    if (!tgt) {
      out.push(PIVOT_UNLINKED_KEY);
      continue;
    }
    const v = readFieldPathSync(tgt as Record<string, unknown>, parsed.pathOnTarget);
    if (v === undefined || v === null) {
      out.push(PIVOT_UNLINKED_KEY);
    } else {
      out.push(v);
    }
  }

  return out;
}

function stableKeyTuple(values: readonly unknown[]): string {
  return JSON.stringify(values);
}

class CustomMetricSlot {
  private acc!: unknown;
  private rowCount = 0;
  private readonly hasInitial: boolean;

  constructor(
    private readonly outputKey: string,
    private readonly spec: CustomReducerSpec,
  ) {
    this.hasInitial = Object.prototype.hasOwnProperty.call(this.spec, 'initial');
  }

  get ingestedRowCount(): number {
    return this.rowCount;
  }

  addRow(row: Record<string, unknown>): void {
    const vf = this.spec.valueField ?? this.outputKey;
    const current = row[vf];
    if (this.rowCount === 0) {
      const prev = this.hasInitial ? this.spec.initial : undefined;
      this.acc = this.spec.reduce(prev, current);
      this.rowCount = 1;
    } else {
      this.acc = this.spec.reduce(this.acc, current);
      this.rowCount += 1;
    }
  }

  finalize(): unknown {
    return this.rowCount === 0 ? undefined : this.acc;
  }

  metadataSnapshot(): AnalysisMetricMetadata {
    const vf = this.spec.valueField ?? this.outputKey;
    return {
      outputKey: this.outputKey,
      sourceField: vf,
      op: 'customReduce',
      validSampleCount: this.rowCount,
      missingSampleCount: 0,
    };
  }
}

function snapshotToAnalysisMeta(s: BucketMetricSnapshot): AnalysisMetricMetadata {
  return {
    outputKey: s.outputKey,
    sourceField: s.sourceField,
    op: s.op,
    validSampleCount: s.validSampleCount,
    missingSampleCount: s.missingSampleCount,
    resultHint: s.resultHint,
  };
}

class BucketState {
  private readonly builtin: BucketAggregator;
  private readonly custom = new Map<string, CustomMetricSlot>();

  constructor(
    builtinSpec: Readonly<Record<string, AggregateOp>>,
    customSpec: Readonly<Record<string, CustomReducerSpec>>,
    sourceFieldByOutputKey?: Readonly<Record<string, string>>,
  ) {
    this.builtin = new BucketAggregator(builtinSpec, sourceFieldByOutputKey);
    for (const [outKey, cspec] of Object.entries(customSpec)) {
      this.custom.set(outKey, new CustomMetricSlot(outKey, cspec));
    }
  }

  addRow(row: Record<string, unknown>): void {
    this.builtin.ingest(row);
    for (const slot of this.custom.values()) {
      slot.addRow(row);
    }
  }

  finalize(): Record<string, unknown> {
    const out = this.builtin.finalize();
    for (const [field, slot] of this.custom) {
      out[field] = slot.finalize();
    }
    return out;
  }

  buildMetricMetadata(): Record<string, AnalysisMetricMetadata> {
    const snap = this.builtin.buildMetricSnapshots();
    const out: Record<string, AnalysisMetricMetadata> = {};
    for (const [k, v] of Object.entries(snap)) {
      out[k] = snapshotToAnalysisMeta(v);
    }
    for (const [k, slot] of this.custom) {
      out[k] = slot.metadataSnapshot();
    }
    return out;
  }
}

/**
 * 多桶流式聚合：按分组键维护多个 {@link BucketAggregator}，每行只落入一个桶并增量更新，不物化全表。
 */
export class AggregatorEngine {
  private readonly buckets = new Map<string, BucketState>();
  private readonly builtinSpec: Readonly<Record<string, AggregateOp>>;
  private readonly customSpec: Readonly<Record<string, CustomReducerSpec>>;
  private readonly sourceFieldByOutputKey?: Readonly<Record<string, string>>;

  constructor(
    builtinSpec: Readonly<Record<string, AggregateOp>>,
    customSpec: Readonly<Record<string, CustomReducerSpec>> = {},
    sourceFieldByOutputKey?: Readonly<Record<string, string>>,
  ) {
    this.builtinSpec = builtinSpec;
    this.customSpec = customSpec;
    this.sourceFieldByOutputKey = sourceFieldByOutputKey;
  }

  ingestRow(keyValues: readonly unknown[], row: Record<string, unknown>): void {
    const k = stableKeyTuple(keyValues);
    let b = this.buckets.get(k);
    if (!b) {
      b = new BucketState(this.builtinSpec, this.customSpec, this.sourceFieldByOutputKey);
      this.buckets.set(k, b);
    }
    b.addRow(row);
  }

  /** 每个桶的最终聚合值（键为 stableKeyTuple 结果）。 */
  finalizeBucketMap(): Map<string, Record<string, unknown>> {
    const m = new Map<string, Record<string, unknown>>();
    for (const [k, b] of this.buckets) {
      m.set(k, b.finalize());
    }
    return m;
  }

  /** 与 {@link finalizeBucketMap} 同键：各桶各指标的样本/缺失/溯源。 */
  finalizeBucketMetadataMap(): Map<string, Record<string, AnalysisMetricMetadata>> {
    const m = new Map<string, Record<string, AnalysisMetricMetadata>>();
    for (const [k, b] of this.buckets) {
      m.set(k, b.buildMetricMetadata());
    }
    return m;
  }
}

function isPlainMetricLeafValue(v: unknown): boolean {
  if (v === null) {
    return true;
  }
  if (typeof v !== 'object') {
    return true;
  }
  return isTraceableNull(v);
}

/** 嵌套树叶子：仅含指标标量 / {@link TraceableNull}，无子分组对象。 */
export function isMetricsLeafShape(obj: unknown): boolean {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return false;
  }
  return Object.values(obj as Record<string, unknown>).every(isPlainMetricLeafValue);
}

/**
 * 多维分组结果塑形：嵌套对象（按 groupBy 顺序）或拍平行表。
 */
export class DataPivot {
  constructor(private readonly groupFields: readonly string[]) {}

  get fields(): readonly string[] {
    return this.groupFields;
  }

  nestTree(
    bucketKeys: readonly unknown[][],
    bucketAggregates: readonly Record<string, unknown>[],
  ): Record<string, unknown> {
    const root: Record<string, unknown> = {};
    for (let i = 0; i < bucketKeys.length; i++) {
      const path = bucketKeys[i]!;
      const agg = bucketAggregates[i]!;
      let cur: Record<string, unknown> = root;
      for (let j = 0; j < path.length; j++) {
        const seg = path[j]!;
        const key = keyToString(seg);
        if (j === path.length - 1) {
          cur[key] = { ...agg };
        } else {
          const next = cur[key];
          if (
            next === undefined ||
            typeof next !== 'object' ||
            next === null ||
            isMetricsLeafShape(next)
          ) {
            cur[key] = {};
          }
          cur = cur[key] as Record<string, unknown>;
        }
      }
    }
    return root;
  }

  toFlatTable(
    bucketKeys: readonly unknown[][],
    bucketAggregates: readonly Record<string, unknown>[],
  ): AnalysisFlatRow[] {
    const names = this.groupFields;
    return bucketKeys.map((vals, i) => {
      const row: Record<string, unknown> = {};
      for (let j = 0; j < names.length; j++) {
        row[names[j]!] = vals[j];
      }
      Object.assign(row, bucketAggregates[i]!);
      return row;
    });
  }
}

/**
 * 透视表：按维度键递归折叠桶路径为嵌套结构，或展开为矩阵行（与 {@link DataPivot} 等价逻辑）。
 *
 * 自 {@link HydratedEntity} 递归建树（叶子上为 {@link BucketAggregator} / {@link StatAccumulator}）见
 * {@link PivotHydratedRecursiveBuilder}、{@link PivotTable.createHydratedBuilder}。
 */
export class PivotTable {
  /** 关系断链时用于嵌套键（与 {@link PIVOT_UNLINKED_KEY} 相同）。 */
  static readonly UNLINKED_SEGMENT = PIVOT_UNLINKED_KEY;

  /** 叶节点上聚合器标记（与 {@link PIVOT_LEAF_SYMBOL} 相同）。 */
  static readonly LEAF_SYMBOL = PIVOT_LEAF_SYMBOL;

  static readonly isPivotLeafNode = isPivotLeafNode;

  /** 解析实体上某一维度；无边或空子实体时为 {@link PIVOT_UNLINKED_KEY}。 */
  static resolveHydratedSegment = resolveHydratedPivotSegment;

  /**
   * 从已水合实体递归下钻并流式累加，返回 `{ 维1: { 维2: { 指标… } } }`（叶上为扁平指标键）。
   */
  static async nestedTreeFromHydrated(
    entities: readonly HydratedEntity[],
    dimensionKeys: readonly string[],
    originModelName: string,
    registry: ModelRegistry,
    metricSpec: Readonly<Record<string, AggregateOp>>,
  ): Promise<Record<string, unknown>> {
    const b = new PivotHydratedRecursiveBuilder(
      dimensionKeys,
      originModelName,
      registry,
      metricSpec,
    );
    await b.ingestAll(entities);
    return b.finalizeNestedTree();
  }

  /** 构造可多次 {@link PivotHydratedRecursiveBuilder.ingestEntity} 的递归透视构建器。 */
  static createHydratedBuilder(
    dimensionKeys: readonly string[],
    originModelName: string,
    registry: ModelRegistry,
    metricSpec: Readonly<Record<string, AggregateOp>>,
  ): PivotHydratedRecursiveBuilder {
    return new PivotHydratedRecursiveBuilder(dimensionKeys, originModelName, registry, metricSpec);
  }

  constructor(private readonly dimensionKeys: readonly string[]) {}

  get keys(): readonly string[] {
    return this.dimensionKeys;
  }

  /** 递归嵌套：`{ [k1]: { [k2]: { sum_x: …, … } } }`（叶为指标键值，无 `aggregates` 包一层） */
  toNestedTree(
    orderedPaths: readonly unknown[][],
    bucketAggregates: readonly Record<string, unknown>[],
  ): Record<string, unknown> {
    return new DataPivot(this.dimensionKeys).nestTree(orderedPaths, bucketAggregates);
  }

  /** 平铺：维度列 + 指标列合并为单行对象数组 */
  toMatrix(
    orderedPaths: readonly unknown[][],
    bucketAggregates: readonly Record<string, unknown>[],
  ): AnalysisFlatRow[] {
    return new DataPivot(this.dimensionKeys).toFlatTable(orderedPaths, bucketAggregates);
  }
}

/**
 * 查询侧流式聚合配置：链式 `.sum('x').avg('y')`，协议常量见 {@link AggregationProtocol}，再交给 {@link QueryChain.aggregate}。
 */
export class Aggregator {
  private readonly metrics: Record<string, AggregateOp> = {};

  sum(field: string): this {
    this.metrics[field] = 'sum';
    return this;
  }

  avg(field: string): this {
    this.metrics[field] = 'avg';
    return this;
  }

  /** 桶内行数；默认输出键 `_count` */
  count(outputKey = '_count'): this {
    this.metrics[outputKey] = 'count';
    return this;
  }

  max(field: string): this {
    this.metrics[field] = 'max';
    return this;
  }

  min(field: string): this {
    this.metrics[field] = 'min';
    return this;
  }

  /** 总体方差 σ² = M2/n（Welford）；样本全缺失时为 {@link traceableNull} */
  variance(field: string): this {
    this.metrics[field] = 'variance';
    return this;
  }

  stdDev(field: string): this {
    this.metrics[field] = 'stdDev';
    return this;
  }

  countDistinct(field: string): this {
    this.metrics[field] = 'countDistinct';
    return this;
  }

  sumDistinct(field: string): this {
    this.metrics[field] = 'sumDistinct';
    return this;
  }

  avgDistinct(field: string): this {
    this.metrics[field] = 'avgDistinct';
    return this;
  }

  minDistinct(field: string): this {
    this.metrics[field] = 'minDistinct';
    return this;
  }

  maxDistinct(field: string): this {
    this.metrics[field] = 'maxDistinct';
    return this;
  }

  toMetricsRecord(): Record<string, AggregateOp> {
    return { ...this.metrics };
  }
}

function keyToString(v: unknown): string {
  return pivotSegmentKey(v);
}

export function buildAnalysisReport(
  pivot: DataPivot,
  shape: 'tree' | 'flat',
  bucketFinal: Map<string, Record<string, unknown>>,
): AnalysisReport {
  const pt = new PivotTable(pivot.fields);
  const orderedKeys = orderedKeysFromBucketMap(bucketFinal);
  const aggs = orderedKeys.map((vals) => bucketFinal.get(stableKeyTuple(vals)) ?? {});
  if (shape === 'tree') {
    return {
      kind: 'analysis',
      shape: 'tree',
      tree: pt.toNestedTree(orderedKeys, aggs),
    };
  }
  return {
    kind: 'analysis',
    shape: 'flat',
    rows: pt.toMatrix(orderedKeys, aggs),
  };
}

function orderedKeysFromBucketMap(aggMap: Map<string, Record<string, unknown>>): unknown[][] {
  const keys = [...aggMap.keys()].sort((a, b) => a.localeCompare(b));
  return keys.map((k) => JSON.parse(k) as unknown[]);
}

function compareAnalysisOrderValues(left: unknown, right: unknown): number {
  if (Object.is(left, right)) {
    return 0;
  }
  if (left === null || left === undefined) {
    return 1;
  }
  if (right === null || right === undefined) {
    return -1;
  }
  if (typeof left === 'number' && typeof right === 'number') {
    return left - right;
  }
  if (typeof left === 'boolean' && typeof right === 'boolean') {
    return Number(left) - Number(right);
  }
  return String(left).localeCompare(String(right), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

export function buildAnalysisRunMetadata(
  dimensionKeys: readonly string[],
  bucketMap: Map<string, Record<string, unknown>>,
  metaMap: Map<string, Record<string, AnalysisMetricMetadata>>,
): AnalysisRunMetadata {
  const sortedKeys = [...bucketMap.keys()].sort((a, b) => a.localeCompare(b));
  const buckets: AnalysisBucketMetadataRow[] = sortedKeys.map((k) => ({
    dimensionValues: JSON.parse(k) as unknown[],
    metrics: metaMap.get(k) ?? {},
  }));
  return {
    pipeline: 'filter_then_group_then_aggregate',
    dimensionKeys,
    buckets,
    note: 'Execution order: (1) apply QueryChain predicate tree to each candidate row, (2) resolve pivot/group key tuple for rows that pass, (3) stream each surviving row into its bucket aggregators. The streaming scan uses the same ordering per record.',
  };
}

/**
 * 多维分析管道输出：延迟生成 {@link asTree} / {@link asMatrix} / {@link asFlatTable} / {@link getTraceability}（同一桶图，多视图无重复计算键序）。
 */
export class AnalysisResult {
  private readonly metaMap: Map<string, Record<string, AnalysisMetricMetadata>>;
  private readonly bucketOrder: readonly string[];

  constructor(
    readonly dimensionKeys: readonly string[],
    private readonly bucketMap: Map<string, Record<string, unknown>>,
    metaMap?: Map<string, Record<string, AnalysisMetricMetadata>>,
    bucketOrder?: readonly string[],
  ) {
    this.metaMap = metaMap ?? new Map();
    this.bucketOrder = bucketOrder
      ? bucketOrder.filter((key) => bucketMap.has(key))
      : [...bucketMap.keys()].sort((a, b) => a.localeCompare(b));
  }

  /** 分组桶数量（排序分页用）。 */
  get bucketCount(): number {
    return this.bucketMap.size;
  }

  filterBuckets(predicate: PredicateNode): AnalysisResult {
    const newBucket = new Map<string, Record<string, unknown>>();
    const newMeta = new Map<string, Record<string, AnalysisMetricMetadata>>();
    const keptKeys: string[] = [];
    for (const key of this.bucketOrder) {
      const aggregates = this.bucketMap.get(key);
      if (!aggregates) {
        continue;
      }
      const dimensions = JSON.parse(key) as unknown[];
      const row: Record<string, unknown> = { ...aggregates };
      this.dimensionKeys.forEach((dimensionKey, index) => {
        row[dimensionKey] = dimensions[index];
      });
      if (!evaluatePredicate(row as ModelRecord, predicate).ok) {
        continue;
      }
      newBucket.set(key, aggregates);
      newMeta.set(key, this.metaMap.get(key) ?? {});
      keptKeys.push(key);
    }
    return new AnalysisResult(this.dimensionKeys, newBucket, newMeta, keptKeys);
  }

  /**
   * 按桶键字典序切片，返回新的 {@link AnalysisResult}（元数据同步子集）。
   * 用于分页：在过滤与聚合**之后**对桶列表分页。
   */
  sliceBuckets(pageIndex: number, limit: number): AnalysisResult {
    const safeLimit = Math.max(1, Math.floor(limit));
    const page = Math.max(0, Math.floor(pageIndex));
    const orderedKeys = this.bucketOrder;
    const off = page * safeLimit;
    const sliceKeys = orderedKeys.slice(off, off + safeLimit);
    const newBucket = new Map<string, Record<string, unknown>>();
    const newMeta = new Map<string, Record<string, AnalysisMetricMetadata>>();
    for (const k of sliceKeys) {
      const agg = this.bucketMap.get(k);
      if (agg !== undefined) {
        newBucket.set(k, agg);
      }
      newMeta.set(k, this.metaMap.get(k) ?? {});
    }
    return new AnalysisResult(this.dimensionKeys, newBucket, newMeta, sliceKeys);
  }

  sliceBucketsAfter(
    anchor: string | undefined,
    limit: number,
  ): { result: AnalysisResult; nextAnchor?: string } {
    const safeLimit = Math.max(1, Math.floor(limit));
    const anchorIndex = anchor === undefined ? -1 : this.bucketOrder.indexOf(anchor);
    if (anchor !== undefined && anchorIndex < 0) {
      throw new QueryError('Cursor anchor is no longer present in the aggregation result.');
    }
    const sliceKeys = this.bucketOrder.slice(anchorIndex + 1, anchorIndex + 1 + safeLimit);
    const newBucket = new Map<string, Record<string, unknown>>();
    const newMeta = new Map<string, Record<string, AnalysisMetricMetadata>>();
    for (const key of sliceKeys) {
      const aggregates = this.bucketMap.get(key);
      if (aggregates !== undefined) {
        newBucket.set(key, aggregates);
      }
      newMeta.set(key, this.metaMap.get(key) ?? {});
    }
    const hasMore = anchorIndex + 1 + sliceKeys.length < this.bucketOrder.length;
    return {
      result: new AnalysisResult(this.dimensionKeys, newBucket, newMeta, sliceKeys),
      ...(hasMore && sliceKeys.length > 0 ? { nextAnchor: sliceKeys.at(-1)! } : {}),
    };
  }

  sortBuckets(orderBy: readonly QueryOrderEntry[]): AnalysisResult {
    if (orderBy.length === 0 || this.bucketOrder.length < 2) {
      return this;
    }
    const rows = this.bucketOrder.map((key, index) => ({
      key,
      index,
      dimensions: JSON.parse(key) as unknown[],
      aggregates: this.bucketMap.get(key) ?? {},
    }));
    rows.sort((left, right) => {
      for (const order of orderBy) {
        const dimensionIndex = this.dimensionKeys.indexOf(order.field);
        const leftValue =
          dimensionIndex >= 0 ? left.dimensions[dimensionIndex] : left.aggregates[order.field];
        const rightValue =
          dimensionIndex >= 0 ? right.dimensions[dimensionIndex] : right.aggregates[order.field];
        const leftMissing = leftValue === null || leftValue === undefined;
        const rightMissing = rightValue === null || rightValue === undefined;
        if (leftMissing !== rightMissing) {
          return leftMissing ? 1 : -1;
        }
        const compared = compareAnalysisOrderValues(leftValue, rightValue);
        if (compared !== 0) {
          return order.direction === 'desc' ? -compared : compared;
        }
      }
      return left.index - right.index;
    });
    return new AnalysisResult(
      this.dimensionKeys,
      this.bucketMap,
      this.metaMap,
      rows.map((row) => row.key),
    );
  }

  asTree(): Record<string, unknown> {
    const ordered = this.bucketOrder.map((key) => JSON.parse(key) as unknown[]);
    const aggs = ordered.map((vals) => this.bucketMap.get(stableKeyTuple(vals)) ?? {});
    return new PivotTable(this.dimensionKeys).toNestedTree(ordered, aggs);
  }

  asMatrix(): readonly AnalysisFlatRow[] {
    const ordered = this.bucketOrder.map((key) => JSON.parse(key) as unknown[]);
    const aggs = ordered.map((vals) => this.bucketMap.get(stableKeyTuple(vals)) ?? {});
    return new PivotTable(this.dimensionKeys).toMatrix(ordered, aggs);
  }

  /** 与 {@link asMatrix} 相同：适合 Excel / 表格组件的扁平行。 */
  asFlatTable(): readonly AnalysisFlatRow[] {
    return this.asMatrix();
  }

  /** 各桶有效/缺失样本数与 {@link TraceableNull} 等结果溯源。 */
  getMetadata(): AnalysisRunMetadata {
    return buildAnalysisRunMetadata(this.dimensionKeys, this.bucketMap, this.metaMap);
  }

  /** 数据缺口与拓扑断裂视图（在 {@link getMetadata} 上增加路径级 **unlinked** 与汇总计数）。 */
  getTraceability(): AnalysisTraceability {
    return buildAnalysisTraceability(this.getMetadata());
  }

  /** 兼容旧 {@link AnalysisReport} / {@link isAnalysisReport} */
  toAnalysisReport(shape: 'tree' | 'flat'): AnalysisReport {
    return shape === 'tree'
      ? { kind: 'analysis', shape: 'tree', tree: this.asTree() }
      : { kind: 'analysis', shape: 'flat', rows: [...this.asFlatTable()] };
  }
}

export function isAnalysisResult(x: unknown): x is AnalysisResult {
  return x instanceof AnalysisResult;
}

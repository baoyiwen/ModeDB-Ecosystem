/**
 * Client-side query plan builder + {@link RemoteExecuteSnapshot} for wire transport.
 * Fluent surface aligns with what the WebSocket host replays; no local storage or registry.
 */

export class WireQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WireQueryError';
  }
}

/** 聚合算子字符串（与宿主机桶内聚合协议一致）。 */
export type AggregateOp = 'sum' | 'avg' | 'min' | 'max' | 'count' | 'variance' | 'stdDev';

/** `aggregate` / `compute` 中单字段可配置多个算子。 */
export type AggregateInputEntry = AggregateOp | readonly AggregateOp[];

/** Options merged with snapshot `execute` when issuing a remote `execute` RPC. */
export interface QueryExecuteOptions {
  readonly includeRelates?: boolean;
  readonly page?: number;
  readonly limit?: number;
  readonly wrapGroups?: boolean;
}

export type WireRow = Record<string, unknown>;
export type RecordPredicate = (rec: WireRow) => boolean;

export type PredicateStandardOperator = 'eq' | 'neq' | 'gt' | 'lt' | 'like' | 'in';
export type PredicateAtomOperator = PredicateStandardOperator | 'gte' | 'lte' | 'between';

export interface AtomNode {
  readonly type: 'atom';
  readonly field: string;
  readonly op: PredicateAtomOperator;
  readonly value: unknown;
}

export interface GroupNode {
  readonly type: 'group';
  readonly logic: 'AND' | 'OR';
  readonly children: readonly PredicateNode[];
}

export interface CallbackNode {
  readonly type: 'callback';
  readonly fn: RecordPredicate;
  readonly label?: string;
}

export type PredicateNode = AtomNode | GroupNode | CallbackNode;

export function atomNode(field: string, op: ScalarOperator, value: unknown): AtomNode {
  return { type: 'atom', field, op: op as PredicateAtomOperator, value };
}

export function groupNode(logic: 'AND' | 'OR', children: readonly PredicateNode[]): GroupNode {
  return { type: 'group', logic, children };
}

export function clonePredicateNode(node: PredicateNode): PredicateNode {
  if (node.type === 'atom') {
    return { ...node };
  }
  if (node.type === 'callback') {
    return { type: 'callback', fn: node.fn, label: node.label };
  }
  return {
    type: 'group',
    logic: node.logic,
    children: node.children.map(clonePredicateNode),
  };
}

export function serializePredicate(node: PredicateNode): Record<string, unknown> {
  if (node.type === 'atom') {
    return { type: 'atom', field: node.field, op: node.op, value: node.value };
  }
  if (node.type === 'callback') {
    return { type: 'callback', label: node.label ?? '(fn)' };
  }
  return {
    type: 'group',
    logic: node.logic,
    children: node.children.map((c) => serializePredicate(c)),
  };
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

export function deserializePredicate(obj: Record<string, unknown>): PredicateNode {
  const t = obj.type;
  if (t === 'atom') {
    return {
      type: 'atom',
      field: String(obj.field),
      op: obj.op as PredicateAtomOperator,
      value: obj.value,
    };
  }
  if (t === 'callback') {
    throw new Error(
      `deserializePredicate: callback nodes cannot be restored from JSON (label=${String(obj.label ?? '')}).`,
    );
  }
  if (t === 'group') {
    const logic = obj.logic === 'OR' ? 'OR' : 'AND';
    const raw = obj.children;
    if (!Array.isArray(raw)) {
      throw new Error('deserializePredicate: group.children must be an array.');
    }
    const children = raw.map((c) => {
      if (!isRecord(c)) {
        throw new Error('deserializePredicate: invalid child in group.');
      }
      return deserializePredicate(c);
    });
    return { type: 'group', logic, children };
  }
  throw new Error(`deserializePredicate: unknown node type ${String(t)}`);
}

export function treeHasCallback(node: PredicateNode): boolean {
  if (node.type === 'callback') {
    return true;
  }
  if (node.type === 'atom') {
    return false;
  }
  return node.children.some(treeHasCallback);
}

export type ScalarOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'in' | 'between';

const OP_ALIASES: Record<string, ScalarOperator> = {
  '=': 'eq',
  '==': 'eq',
  '!=': 'neq',
  '<>': 'neq',
  '>': 'gt',
  '>=': 'gte',
  '<': 'lt',
  '<=': 'lte',
};

export function normalizeOperator(op: string): ScalarOperator {
  const k = op.trim().toLowerCase();
  if (k in OP_ALIASES) {
    return OP_ALIASES[k]!;
  }
  if (
    k === 'eq' ||
    k === 'neq' ||
    k === 'gt' ||
    k === 'gte' ||
    k === 'lt' ||
    k === 'lte' ||
    k === 'like' ||
    k === 'in' ||
    k === 'between'
  ) {
    return k;
  }
  throw new Error(`Unsupported query operator: "${op}"`);
}

export type FilterBuilderInput<M extends Record<string, unknown> = Record<string, unknown>> =
  | PredicateNode
  | FilterBuilder<M>;

function toPredicateNode<M extends Record<string, unknown>>(
  x: FilterBuilderInput<M>,
): PredicateNode {
  return x instanceof FilterBuilder ? x.toPredicateNode() : x;
}

export class PredicateComposer<M extends Record<string, unknown> = Record<string, unknown>> {
  is<K extends keyof M & string>(field: K, value: M[K]): PredicateNode {
    return atomNode(field, 'eq', value as unknown);
  }

  not<K extends keyof M & string>(field: K, value: M[K]): PredicateNode {
    return atomNode(field, 'neq', value as unknown);
  }

  gt<K extends keyof M & string>(field: K, value: unknown): PredicateNode {
    return atomNode(field, 'gt', value);
  }

  lt<K extends keyof M & string>(field: K, value: unknown): PredicateNode {
    return atomNode(field, 'lt', value);
  }

  greaterThan<K extends keyof M & string>(field: K, value: unknown): PredicateNode {
    return this.gt(field, value);
  }

  lessThan<K extends keyof M & string>(field: K, value: unknown): PredicateNode {
    return this.lt(field, value);
  }

  contains<K extends keyof M & string>(field: K, substring: string): PredicateNode {
    return atomNode(field, 'like', substring);
  }

  inside<K extends keyof M & string>(field: K, values: readonly unknown[]): PredicateNode {
    return atomNode(field, 'in', [...values]);
  }

  between<K extends keyof M & string>(field: K, min: unknown, max: unknown): PredicateNode {
    return atomNode(field, 'between', [min, max]);
  }

  where(field: string, operator: string, value: unknown): PredicateNode {
    const op = normalizeOperator(operator);
    return atomNode(field, op, value);
  }

  and(...children: PredicateNode[]): PredicateNode {
    return groupNode('AND', children);
  }

  or(...children: PredicateNode[]): PredicateNode {
    return groupNode('OR', children);
  }
}

export class FilterBuilder<M extends Record<string, unknown> = Record<string, unknown>> {
  private readonly acc: PredicateNode[] = [];

  static compose<
    M2 extends Record<string, unknown> = Record<string, unknown>,
  >(): PredicateComposer<M2> {
    return new PredicateComposer<M2>();
  }

  is<K extends keyof M & string>(field: K, value: M[K]): this {
    this.acc.push(atomNode(field, 'eq', value as unknown));
    return this;
  }

  not<K extends keyof M & string>(field: K, value: M[K]): this {
    this.acc.push(atomNode(field, 'neq', value as unknown));
    return this;
  }

  gt<K extends keyof M & string>(field: K, value: unknown): this {
    this.acc.push(atomNode(field, 'gt', value));
    return this;
  }

  lt<K extends keyof M & string>(field: K, value: unknown): this {
    this.acc.push(atomNode(field, 'lt', value));
    return this;
  }

  greaterThan<K extends keyof M & string>(field: K, value: unknown): this {
    return this.gt(field, value);
  }

  lessThan<K extends keyof M & string>(field: K, value: unknown): this {
    return this.lt(field, value);
  }

  contains<K extends keyof M & string>(field: K, substring: string): this {
    this.acc.push(atomNode(field, 'like', substring));
    return this;
  }

  inside<K extends keyof M & string>(field: K, values: readonly unknown[]): this {
    this.acc.push(atomNode(field, 'in', [...values]));
    return this;
  }

  between<K extends keyof M & string>(field: K, min: unknown, max: unknown): this {
    this.acc.push(atomNode(field, 'between', [min, max]));
    return this;
  }

  where(field: string, operator: string, value: unknown): this {
    const op = normalizeOperator(operator);
    this.acc.push(atomNode(field, op, value));
    return this;
  }

  and(...inputs: FilterBuilderInput<M>[]): this {
    this.acc.push(groupNode('AND', inputs.map(toPredicateNode)));
    return this;
  }

  or(...inputs: FilterBuilderInput<M>[]): this {
    this.acc.push(groupNode('OR', inputs.map(toPredicateNode)));
    return this;
  }

  filter(fn: RecordPredicate, label?: string): this {
    this.acc.push({ type: 'callback', fn, label });
    return this;
  }

  isEmpty(): boolean {
    return this.acc.length === 0;
  }

  toPredicateNode(): PredicateNode {
    if (this.acc.length === 0) {
      return groupNode('AND', []);
    }
    if (this.acc.length === 1) {
      return this.acc[0]!;
    }
    return groupNode('AND', [...this.acc]);
  }
}

export function mergeMatchAnyIntoSegment(
  segments: PredicateNode[][],
  branches: readonly PredicateNode[],
): void {
  if (branches.length === 0) {
    return;
  }
  const cur = segments[segments.length - 1]!;
  const prefix = [...cur];
  cur.length = 0;
  cur.push(
    groupNode(
      'OR',
      branches.map((b) => groupNode('AND', [...prefix, b])),
    ),
  );
}

export function compileSegments(segments: PredicateNode[][]): PredicateNode {
  if (segments.length === 0) {
    return groupNode('AND', []);
  }
  if (segments.length === 1) {
    const s = segments[0]!;
    if (s.length === 0) {
      return groupNode('AND', []);
    }
    if (s.length === 1) {
      return s[0]!;
    }
    return groupNode('AND', s);
  }
  return groupNode(
    'OR',
    segments.map((s) => {
      if (s.length === 0) {
        return groupNode('AND', []);
      }
      if (s.length === 1) {
        return s[0]!;
      }
      return groupNode('AND', s);
    }),
  );
}

const COMPUTE_METRIC_TAG = 'mode_db_compute_metric' as const;

export type ComputeMetricToken = {
  readonly __tag: typeof COMPUTE_METRIC_TAG;
  readonly field: string;
  readonly op: AggregateOp;
};

function makeToken(field: string, op: AggregateOp): ComputeMetricToken {
  return { __tag: COMPUTE_METRIC_TAG, field, op };
}

export function isComputeMetricToken(x: unknown): x is ComputeMetricToken {
  return (
    typeof x === 'object' &&
    x !== null &&
    (x as ComputeMetricToken).__tag === COMPUTE_METRIC_TAG &&
    typeof (x as ComputeMetricToken).field === 'string' &&
    typeof (x as ComputeMetricToken).op === 'string'
  );
}

export class ComputeBuilder {
  sum(field: string): ComputeMetricToken {
    return makeToken(field, 'sum');
  }

  avg(field: string): ComputeMetricToken {
    return makeToken(field, 'avg');
  }

  max(field: string): ComputeMetricToken {
    return makeToken(field, 'max');
  }

  min(field: string): ComputeMetricToken {
    return makeToken(field, 'min');
  }

  variance(field: string): ComputeMetricToken {
    return makeToken(field, 'variance');
  }
}

export function mergeComputeTokens(
  tokens: readonly ComputeMetricToken[],
): Record<string, AggregateInputEntry> {
  const byField = new Map<string, AggregateOp[]>();
  for (const t of tokens) {
    const list = byField.get(t.field) ?? [];
    list.push(t.op);
    byField.set(t.field, list);
  }
  const out: Record<string, AggregateInputEntry> = {};
  for (const [field, ops] of byField) {
    out[field] = ops.length === 1 ? ops[0]! : ops;
  }
  return out;
}

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

  variance(field: string): this {
    this.metrics[field] = 'variance';
    return this;
  }

  stdDev(field: string): this {
    this.metrics[field] = 'stdDev';
    return this;
  }

  toMetricsRecord(): Record<string, AggregateOp> {
    return { ...this.metrics };
  }
}

export interface CustomReducerSpec {
  readonly initial?: unknown;
  readonly reduce: (prev: unknown, current: unknown) => unknown;
  readonly valueField?: string;
}

export type QueryStartSpec =
  | { readonly kind: 'all' }
  | { readonly kind: 'ids'; readonly ids: readonly string[] };

/**
 * 序列化后的单跳 JSON。`branches` 为从**本跳目标**分叉出的嵌套子链（每个分支本身又是一棵跳树），
 * 用于表达「同一起点的数据网」——多个 `group`/`relate` 子链可并存于同一父实体之下。
 */
export interface WireHopJSON {
  readonly relationName: string;
  readonly source: Record<string, unknown>;
  readonly target: Record<string, unknown>;
  readonly recursive?: RecursiveHopSpec;
  readonly lateral?: boolean;
  readonly branches?: ReadonlyArray<WireHopJSON>;
}

export interface QueryPlanASTv2 {
  readonly version: 2;
  readonly originModel: string;
  readonly start: QueryStartSpec;
  readonly hops: ReadonlyArray<WireHopJSON>;
  readonly trailing: Record<string, unknown>;
}

/** 遍历方向（影响展平默认顺序）：`bfs` 广度优先，`dfs` 深度优先。 */
export type TreeTraversalStrategy = 'bfs' | 'dfs';

/**
 * 递归 / 自关联跳的执行规格。
 * - **`tree: false`**（默认）：平铺收纳全部后代（{@link relateRecursive} 行为）。
 * - **`tree: true`**：构建真正的嵌套子树（{@link children} 行为），每个节点的直接子节点挂在自身之下。
 */
export interface RecursiveHopSpec {
  readonly maxDepth: number;
  readonly tree?: boolean;
  readonly strategy?: TreeTraversalStrategy;
}

export function queryPlanHasSerializedCallback(plan: QueryPlanASTv2): boolean {
  const walk = (node: Record<string, unknown>): boolean => {
    if (node.type === 'callback') {
      return true;
    }
    if (node.type === 'group' && Array.isArray(node.children)) {
      return node.children.some((c) => isRecord(c) && walk(c));
    }
    return false;
  };
  if (walk(plan.trailing)) {
    return true;
  }
  for (const h of plan.hops) {
    if (walk(h.source as Record<string, unknown>) || walk(h.target as Record<string, unknown>)) {
      return true;
    }
  }
  return false;
}

export interface RemoteExecuteSnapshot {
  readonly plan: QueryPlanASTv2;
  readonly execute: {
    readonly limit?: number;
    readonly page?: number;
    readonly includeRelates?: boolean;
    readonly wrapGroups?: boolean;
  };
  readonly analysis: {
    readonly groupBy: readonly string[] | null;
    readonly compute: Readonly<Record<string, AggregateInputEntry>> | null;
  };
}

export interface RemoteSnapshotChainState {
  readonly analysisCustom: Readonly<Record<string, CustomReducerSpec>>;
  readonly wrapGroupsFlag: boolean;
  readonly analysisGroupBy: readonly string[] | null;
  readonly paginationPartial: { readonly page?: number; readonly limit?: number } | null;
  readonly analysisCompute: Readonly<Record<string, AggregateInputEntry>> | null;
}

export function finalizeRemoteExecuteSnapshot(
  plan: QueryPlanASTv2,
  options: QueryExecuteOptions | undefined,
  chainState: RemoteSnapshotChainState,
): RemoteExecuteSnapshot {
  if (queryPlanHasSerializedCallback(plan)) {
    throw new WireQueryError(
      'Remote execute cannot serialize filter() callbacks; remove filter() for wire transport.',
    );
  }
  if (Object.keys(chainState.analysisCustom).length > 0) {
    throw new WireQueryError('Remote execute does not support customReduce().');
  }
  if (chainState.wrapGroupsFlag) {
    const gb = chainState.analysisGroupBy;
    if (gb === null || gb.length === 0) {
      throw new WireQueryError('wrapGroups requires groupBy(...) or pivot(...).');
    }
  }
  const limitOpt = options?.limit ?? chainState.paginationPartial?.limit;
  const pageOpt = options?.page ?? chainState.paginationPartial?.page ?? 0;
  const wrapGroups = options?.wrapGroups ?? chainState.wrapGroupsFlag;
  const execute: RemoteExecuteSnapshot['execute'] = {
    ...(limitOpt !== undefined && limitOpt !== null ? { limit: limitOpt } : {}),
    page: pageOpt,
    ...(options?.includeRelates !== undefined ? { includeRelates: options.includeRelates } : {}),
    ...(wrapGroups ? { wrapGroups: true } : {}),
  };
  return {
    plan,
    execute,
    analysis: {
      groupBy: chainState.analysisGroupBy,
      compute: chainState.analysisCompute,
    },
  };
}

interface HopPlan {
  readonly relationName: string;
  readonly sourcePredicate: PredicateNode;
  readonly targetPredicate: PredicateNode;
  readonly recursive?: RecursiveHopSpec;
  readonly lateral?: boolean;
  readonly branches?: readonly HopPlan[];
}

/** 序列化递归跳规格（仅写出存在的字段，保持 wire JSON 精简）。 */
function serializeRecursiveHop(spec: RecursiveHopSpec): RecursiveHopSpec {
  return {
    maxDepth: spec.maxDepth,
    ...(spec.tree ? { tree: true } : {}),
    ...(spec.strategy ? { strategy: spec.strategy } : {}),
  };
}

/** 递归序列化单跳（含 `branches` 子链），保持 wire JSON 精简。 */
function serializeHopPlan(h: HopPlan): WireHopJSON {
  return {
    relationName: h.relationName,
    source: serializePredicate(h.sourcePredicate),
    target: serializePredicate(h.targetPredicate),
    ...(h.recursive ? { recursive: serializeRecursiveHop(h.recursive) } : {}),
    ...(h.lateral ? { lateral: true } : {}),
    ...(h.branches && h.branches.length > 0 ? { branches: h.branches.map(serializeHopPlan) } : {}),
  };
}

/**
 * Wire-only fluent chain for building {@link RemoteExecuteSnapshot}
 * (predicate / hop / analysis surface aligned with the host); does not execute locally.
 */
export class WireQueryChain<
  M extends Record<string, unknown> = Record<string, unknown>,
  _Mode extends 'rows' | 'analysis' = 'rows',
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

  constructor(startModel: string, start: QueryStartSpec) {
    this.originModel = startModel;
    this.start = start;
  }

  getQueryPlan(): QueryPlanASTv2 {
    return this._buildRawQuery();
  }

  getRemoteExecuteSnapshot(options?: QueryExecuteOptions): RemoteExecuteSnapshot {
    const plan = this._buildRawQuery();
    return finalizeRemoteExecuteSnapshot(plan, options, {
      analysisCustom: this.analysisCustom,
      wrapGroupsFlag: this.wrapGroupsFlag,
      analysisGroupBy: this.analysisGroupBy,
      paginationPartial: this.paginationPartial,
      analysisCompute: this.analysisCompute,
    });
  }

  private _buildRawQuery(): QueryPlanASTv2 {
    return {
      version: 2,
      originModel: this.originModel,
      start: this.start,
      hops: this.hops.map(serializeHopPlan),
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

  matchAll(fn: (b: FilterBuilder<M>) => void): this {
    const b = new FilterBuilder<M>();
    fn(b);
    if (!b.isEmpty()) {
      this.currentSegment().push(b.toPredicateNode());
    }
    return this;
  }

  matchAllNodes(fn: (p: PredicateComposer<M>) => readonly PredicateNode[]): this {
    for (const n of fn(new PredicateComposer<M>())) {
      this.currentSegment().push(n);
    }
    return this;
  }

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

  groupBy(fields: readonly string[]): WireQueryChain<M, 'analysis'> {
    if (fields.length === 0) {
      throw new WireQueryError('groupBy() requires at least one dimension field.');
    }
    this.analysisGroupBy = [...fields];
    return this as unknown as WireQueryChain<M, 'analysis'>;
  }

  pivot(keys: readonly string[]): WireQueryChain<M, 'analysis'> {
    if (keys.length === 0) {
      throw new WireQueryError('pivot() requires at least one dimension field.');
    }
    this.analysisGroupBy = [...keys];
    return this as unknown as WireQueryChain<M, 'analysis'>;
  }

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
        throw new WireQueryError(
          `aggregate(): field key "${k}" already exists — use compute() to replace the full builtin spec, or use a different field.`,
        );
      }
      if (k in this.analysisCustom) {
        throw new WireQueryError(`aggregate(): key "${k}" conflicts with customReduce().`);
      }
      cur[k] = v;
    }
    this.analysisCompute = cur;
    return this;
  }

  compute(spec: Record<string, AggregateInputEntry>): this;
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
        throw new WireQueryError(
          'compute(callback): callback must return an array of metric tokens.',
        );
      }
      for (const x of arr) {
        if (!isComputeMetricToken(x)) {
          throw new WireQueryError(
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

  customReduce(outputKey: string, spec: CustomReducerSpec): this {
    this.analysisCustom[outputKey] = spec;
    return this;
  }

  /**
   * 在**本跳目标**上构建嵌套子链（分支）：回调内用一条全新链描述从目标出发的关系/过滤，
   * 捕获其 hop 序列作为分支返回。多个分支可并存于同一父实体下，构成「同一起点的数据网」。
   */
  private buildSubBranches<Target extends Record<string, unknown>>(
    build: (sub: WireQueryChain<Target>) => void,
  ): readonly HopPlan[] {
    const sub = new WireQueryChain<Target>(this.originModel, this.start);
    build(sub);
    return (sub as unknown as { hops: HopPlan[] }).hops;
  }

  relate<Target extends Record<string, unknown> = Record<string, unknown>>(
    relationName: string,
    targetSetup?: (b: FilterBuilder<Target>) => void,
    build?: (sub: WireQueryChain<Target>) => void,
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
    const branches = build ? this.buildSubBranches(build) : undefined;
    this.hops.push({
      relationName,
      sourcePredicate,
      targetPredicate,
      ...(branches && branches.length > 0 ? { branches } : {}),
    });
    this.segments.length = 0;
    this.segments.push([]);
    return this;
  }

  /**
   * 横向附加（**保持主体**）：沿关系把目标实体挂到当前主体行的关系槽位下，但**不推进**主体游标。
   * 与 {@link relate} 同级，区别在于 `group` 之后查询主体仍是当前模型，可继续 `group` 或再 `relate`（`relate` 才改变主体）。
   * 适用于 N:N 层级（如 `sys_layers` 的组/页）等「附加视图」。结果为 origin 根的嵌套树（与 `includeRelates` 一致）。
   *
   * 传入 **`build`** 可在目标上继续构建嵌套子链；配合多次 `group` 即可从同一起点拉出**多条链 / 数据网**。
   */
  group<Target extends Record<string, unknown> = Record<string, unknown>>(
    relationName: string,
    targetSetup?: (b: FilterBuilder<Target>) => void,
    build?: (sub: WireQueryChain<Target>) => void,
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
    const branches = build ? this.buildSubBranches(build) : undefined;
    this.hops.push({
      relationName,
      sourcePredicate,
      targetPredicate,
      lateral: true,
      ...(branches && branches.length > 0 ? { branches } : {}),
    });
    this.segments.length = 0;
    this.segments.push([]);
    return this;
  }

  relateRecursive<Target extends Record<string, unknown> = Record<string, unknown>>(
    relationName: string,
    options?: { readonly depth?: number; readonly maxDepth?: number },
    targetSetup?: (b: FilterBuilder<Target>) => void,
  ): this {
    const raw = options?.depth ?? options?.maxDepth ?? 32;
    const maxDepth = Math.floor(raw);
    if (maxDepth < 0 || maxDepth > 10_000) {
      throw new WireQueryError('relateRecursive: depth must be in [0, 10000].');
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

  /**
   * 自关联**树形**查询：沿同一关系向下展开为嵌套子树，子节点直接挂在对应实体之下。
   * 结果实体提供 **`flatten()`**（展平为有序数组；一对一链即「上下游」强顺序）与 **`toTree()`**（嵌套 JSON）。
   *
   * @param relationName - 自关联的正向关系名（如 `children`）。
   * @param options.depth - 最大展开层数（关系跳数），默认 `10000`（近似全量），范围 `[1, 10000]`。
   * @param options.strategy - 遍历方向，影响展平默认顺序：`bfs` 广度 / `dfs` 深度（默认 `dfs`）。
   */
  children<Target extends Record<string, unknown> = Record<string, unknown>>(
    relationName: string,
    options?: {
      readonly depth?: number;
      readonly strategy?: TreeTraversalStrategy;
      readonly target?: (b: FilterBuilder<Target>) => void;
      readonly build?: (sub: WireQueryChain<Target>) => void;
    },
  ): this {
    const raw = options?.depth ?? 10_000;
    const maxDepth = Math.floor(raw);
    if (maxDepth < 1 || maxDepth > 10_000) {
      throw new WireQueryError('children: depth must be in [1, 10000].');
    }
    const sourcePredicate = clonePredicateNode(this.compiledRoot());
    let targetPredicate: PredicateNode = { type: 'group', logic: 'AND', children: [] };
    if (options?.target) {
      const b = new FilterBuilder<Target>();
      options.target(b);
      targetPredicate = b.isEmpty()
        ? { type: 'group', logic: 'AND', children: [] }
        : b.toPredicateNode();
    }
    const branches = options?.build ? this.buildSubBranches(options.build) : undefined;
    this.hops.push({
      ...(branches && branches.length > 0 ? { branches } : {}),
      relationName,
      sourcePredicate,
      targetPredicate,
      recursive: { maxDepth, tree: true, strategy: options?.strategy ?? 'dfs' },
    });
    this.segments.length = 0;
    this.segments.push([]);
    return this;
  }

  page(index: number): this {
    const p = Math.max(0, Math.floor(index));
    this.paginationPartial = { ...this.paginationPartial, page: p };
    return this;
  }

  limit(size: number): this {
    const lim = Math.max(1, Math.floor(size));
    this.paginationPartial = { ...this.paginationPartial, limit: lim };
    return this;
  }

  wrapGroups(): this {
    this.wrapGroupsFlag = true;
    return this;
  }

  async execute(_options?: QueryExecuteOptions): Promise<unknown> {
    throw new WireQueryError(
      'WireQueryChain does not execute locally — use RemoteQueryChain with a remote session.',
    );
  }
}

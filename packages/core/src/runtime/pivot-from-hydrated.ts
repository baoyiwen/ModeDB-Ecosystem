import type { ModelRegistry } from '@mode-db/common';
import type { HydratedEntity } from './HydratedEntity.js';
import { BucketAggregator, type AggregationProtocolOp } from './stat-accumulator.js';
import { parseGroupDimension, readFieldPathSync, pivotSegmentKey } from './group-dimension.js';

/** 关系链路断开（无边、未注册、筛空等）时使用的嵌套分组键。 */
export const PIVOT_UNLINKED_KEY = '__unlinked__';

/** 标记叶子节点上的 {@link BucketAggregator}（避免与普通对象键冲突）。 */
export const PIVOT_LEAF_SYMBOL = Symbol.for('modedb-ecosystem.pivotLeaf');

export type PivotLeafNode = { readonly [PIVOT_LEAF_SYMBOL]: BucketAggregator };

export function isPivotLeafNode(n: unknown): n is PivotLeafNode {
  return (
    typeof n === 'object' &&
    n !== null &&
    !Array.isArray(n) &&
    PIVOT_LEAF_SYMBOL in n &&
    (n as PivotLeafNode)[PIVOT_LEAF_SYMBOL] instanceof BucketAggregator
  );
}

/**
 * 从 {@link HydratedEntity} 解析某一维度的分组值；关系无法得到目标行时返回 {@link PIVOT_UNLINKED_KEY}。
 */
export async function resolveHydratedPivotSegment(
  entity: HydratedEntity,
  dimensionKey: string,
  originModelName: string,
  registry: ModelRegistry,
): Promise<unknown> {
  const parsed = parseGroupDimension(dimensionKey, registry, originModelName);
  if (parsed.kind === 'direct') {
    return (entity.materializeRow() as Record<string, unknown>)[parsed.field];
  }

  await entity.explainRelate(parsed.relation);
  const children = entity.getRelate(parsed.relation);
  if (children.length === 0) {
    return PIVOT_UNLINKED_KEY;
  }

  const sorted = [...children].sort((a, b) =>
    String(a.materializeRow()._id).localeCompare(String(b.materializeRow()._id)),
  );
  const first = sorted[0]!;
  const data = first.materializeRow() as Record<string, unknown>;
  const v = readFieldPathSync(data, parsed.pathOnTarget);
  if (v === undefined || v === null) {
    return PIVOT_UNLINKED_KEY;
  }
  return v;
}

function ensureLeafAggregator(
  root: Record<string, unknown>,
  segments: readonly string[],
  metricSpec: Readonly<Record<string, AggregationProtocolOp>>,
): BucketAggregator {
  let cur: Record<string, unknown> = root;
  for (let d = 0; d < segments.length; d++) {
    const seg = segments[d]!;
    const last = d === segments.length - 1;
    if (last) {
      const ex = cur[seg];
      if (isPivotLeafNode(ex)) {
        return ex[PIVOT_LEAF_SYMBOL];
      }
      const agg = new BucketAggregator(metricSpec);
      cur[seg] = { [PIVOT_LEAF_SYMBOL]: agg } as PivotLeafNode;
      return agg;
    }
    let next = cur[seg];
    if (next === undefined || !isPlainBranch(next)) {
      cur[seg] = {};
      next = cur[seg];
    }
    cur = next as Record<string, unknown>;
  }
  throw new Error('pivot: empty dimension keys');
}

function isPlainBranch(n: unknown): n is Record<string, unknown> {
  return typeof n === 'object' && n !== null && !Array.isArray(n) && !isPivotLeafNode(n);
}

function materializeNestedTree(node: unknown): unknown {
  if (node === null || typeof node !== 'object') {
    return node;
  }
  if (isPivotLeafNode(node)) {
    return { ...node[PIVOT_LEAF_SYMBOL].finalize() };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    out[k] = materializeNestedTree(v);
  }
  return out;
}

/**
 * 递归透视：对 {@link HydratedEntity[]} 按维度键下钻，叶子上挂载 {@link BucketAggregator}（内含 {@link StatAccumulator}），
 * 得到 `{ 年: { 国: { 指标键: 值, … } } }` 式嵌套结构（与 {@link AnalysisResult.asTree} 叶形一致）。
 */
export class PivotHydratedRecursiveBuilder {
  private readonly root: Record<string, unknown> = {};

  constructor(
    private readonly dimensionKeys: readonly string[],
    private readonly originModelName: string,
    private readonly registry: ModelRegistry,
    private readonly metricSpec: Readonly<Record<string, AggregationProtocolOp>>,
  ) {}

  /** 解析维度 → 递归建路径 → 在叶子上对当前行做流式 ingest。 */
  async ingestEntity(entity: HydratedEntity): Promise<void> {
    const segments: string[] = [];
    for (const dk of this.dimensionKeys) {
      const raw = await resolveHydratedPivotSegment(
        entity,
        dk,
        this.originModelName,
        this.registry,
      );
      segments.push(pivotSegmentKey(raw));
    }
    const leaf = ensureLeafAggregator(this.root, segments, this.metricSpec);
    leaf.ingest(entity.materializeRow() as Record<string, unknown>);
  }

  async ingestAll(entities: readonly HydratedEntity[]): Promise<void> {
    for (const e of entities) {
      await this.ingestEntity(e);
    }
  }

  /** 内部树（叶节点带 {@link PIVOT_LEAF_SYMBOL}），便于调试或取 {@link BucketAggregator}。 */
  getRawRoot(): Record<string, unknown> {
    return this.root;
  }

  /**
   * 将叶子上的 {@link BucketAggregator} 物化为扁平指标对象（与 {@link AnalysisResult.asTree} 叶形一致）。
   */
  finalizeNestedTree(): Record<string, unknown> {
    return materializeNestedTree(this.root) as Record<string, unknown>;
  }

  /** 在已解析的维度路径上取得叶桶（路径值为 {@link pivotSegmentKey} 后的字符串序列）。 */
  getLeafAggregatorAtPath(pathSegments: readonly string[]): BucketAggregator | undefined {
    let cur: unknown = this.root;
    for (let i = 0; i < pathSegments.length; i++) {
      const s = pathSegments[i]!;
      if (!isPlainBranch(cur)) {
        return undefined;
      }
      cur = (cur as Record<string, unknown>)[s];
    }
    return isPivotLeafNode(cur) ? cur[PIVOT_LEAF_SYMBOL] : undefined;
  }
}

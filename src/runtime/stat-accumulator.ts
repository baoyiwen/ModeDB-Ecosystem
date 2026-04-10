/**
 * 流式单变量统计：SUM / MIN / MAX / AVG / 总体方差与标准差（**Welford** 增量算法，σ² = M2/n），
 * 适合大数据集单行扫描，避免先全量加载再两趟计算。
 *
 * **缺失**：`null` / `undefined`、非有限数、不可解析为有限数的字符串均记 **`missingCount`**，
 * 不进入样本量 **n**，不参与 AVG / VARIANCE / STDDEV；关联 **NO_LINK** 等导致字段为 `undefined` 时同理。
 */

/** 可序列化的「无结果」占位，便于前端/日志溯源。 */
export interface TraceableNull {
  readonly kind: 'traceable_null';
  readonly reason: string;
}

export const TRACEABLE_REASON_ALL_MISSING = 'all_missing';

export function traceableNull(reason: string): TraceableNull {
  return { kind: 'traceable_null', reason };
}

export function isTraceableNull(x: unknown): x is TraceableNull {
  return (
    typeof x === 'object' &&
    x !== null &&
    (x as TraceableNull).kind === 'traceable_null' &&
    typeof (x as TraceableNull).reason === 'string'
  );
}

/** 聚合计算协议（与查询链 {@link AggregateOp} 字符串一致）。 */
export const AggregationProtocol = {
  SUM: 'sum',
  AVG: 'avg',
  MIN: 'min',
  MAX: 'max',
  COUNT: 'count',
  VARIANCE: 'variance',
  STDDEV: 'stdDev',
} as const;

export type AggregationProtocolOp = (typeof AggregationProtocol)[keyof typeof AggregationProtocol];

/** `null` / `undefined` 为缺失；`NaN`、非有限数视为无效（同缺失）。`0` 有效。 */
export function isStatMissing(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true;
  }
  if (typeof value === 'number') {
    return !Number.isFinite(value);
  }
  return false;
}

/**
 * 将业务值转为有限数字；无法转换则 `undefined`（按缺失处理）。
 */
export function coerceFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * 单字段流式累加器：**Welford** 在线更新均值与二阶矩 **M2**，总体方差 **σ² = M2/n**。
 * 遍历时调用 {@link add}，缺失样本仅增加 {@link missingCount}。
 */
export class StatAccumulator {
  private n = 0;
  private mean = 0;
  private m2 = 0;
  private sum = 0;
  private min = Number.POSITIVE_INFINITY;
  private max = Number.NEGATIVE_INFINITY;
  private _missingCount = 0;

  /**
   * 纳入一条原始观测：`null` / `undefined`、NO_LINK 导致的缺失、非有限数等计入 {@link missingCount}，不更新统计矩。
   */
  add(value: unknown): void {
    if (isStatMissing(value)) {
      this._missingCount += 1;
      return;
    }
    const x = typeof value === 'number' ? value : coerceFiniteNumber(value);
    if (x === undefined) {
      this._missingCount += 1;
      return;
    }
    this.observeFinite(x);
  }

  /** 已判定为有限实数时直接更新（内部与高级用法）。 */
  observeFinite(x: number): void {
    this.n += 1;
    this.sum += x;
    this.min = Math.min(this.min, x);
    this.max = Math.max(this.max, x);
    const delta = x - this.mean;
    this.mean += delta / this.n;
    const delta2 = x - this.mean;
    this.m2 += delta * delta2;
  }

  /**
   * @deprecated 使用 {@link add}；语义相同。
   */
  observeValue(value: unknown): void {
    this.add(value);
  }

  /**
   * @deprecated 使用 {@link observeFinite}；调用方须保证 `x` 为有限数。
   */
  observe(x: number): void {
    this.observeFinite(x);
  }

  /** 有效数值样本数（参与 SUM/AVG/方差等）。 */
  get validCount(): number {
    return this.n;
  }

  /** 缺失或无效观测条数（含 `null`、`undefined`、NaN、不可解析数字）。 */
  get missingCount(): number {
    return this._missingCount;
  }

  get populationVariance(): number | undefined {
    return this.n === 0 ? undefined : this.m2 / this.n;
  }

  get populationStdDev(): number | undefined {
    const v = this.populationVariance;
    return v === undefined ? undefined : Math.sqrt(v);
  }

  get arithmeticMean(): number | undefined {
    return this.n === 0 ? undefined : this.mean;
  }

  get sumTotal(): number | undefined {
    return this.n === 0 ? undefined : this.sum;
  }

  get minValue(): number | undefined {
    return this.n === 0 ? undefined : this.min;
  }

  get maxValue(): number | undefined {
    return this.n === 0 ? undefined : this.max;
  }
}

function missingNumericResult(): TraceableNull {
  return traceableNull(TRACEABLE_REASON_ALL_MISSING);
}

/** 单桶内某输出指标的样本与缺失统计（供 {@link AnalysisResult.getMetadata}）。 */
export interface BucketMetricSnapshot {
  readonly outputKey: string;
  readonly sourceField: string;
  readonly op: AggregationProtocolOp;
  readonly validSampleCount: number;
  readonly missingSampleCount: number;
  /** 聚合结果为 {@link TraceableNull} 时的 reason 等 */
  readonly resultHint?: string;
}

/** 内置协议下单指标槽（COUNT 仅用行计数，其余走 {@link StatAccumulator}）。 */
class BuiltinMetricSlot {
  private readonly acc: StatAccumulator | null;
  private bucketRowCount = 0;

  constructor(
    readonly outputKey: string,
    readonly sourceField: string,
    readonly op: AggregationProtocolOp,
  ) {
    this.acc = op === 'count' ? null : new StatAccumulator();
  }

  addRowValue(value: unknown): void {
    if (this.op === 'count') {
      this.bucketRowCount += 1;
      return;
    }
    this.acc!.add(value);
  }

  get missingCount(): number {
    return this.acc?.missingCount ?? 0;
  }

  /** 数值指标背后的累加器；`COUNT` 为 `null`。 */
  getUnderlyingAccumulator(): StatAccumulator | null {
    return this.acc;
  }

  finalize(): unknown {
    switch (this.op) {
      case 'count':
        return this.bucketRowCount;
      case 'sum':
        return this.acc!.validCount === 0 ? missingNumericResult() : this.acc!.sumTotal;
      case 'avg':
        return this.acc!.validCount === 0 ? missingNumericResult() : this.acc!.arithmeticMean;
      case 'min':
        return this.acc!.validCount === 0 ? missingNumericResult() : this.acc!.minValue;
      case 'max':
        return this.acc!.validCount === 0 ? missingNumericResult() : this.acc!.maxValue;
      case 'variance':
        return this.acc!.validCount === 0 ? missingNumericResult() : this.acc!.populationVariance;
      case 'stdDev': {
        if (this.acc!.validCount === 0) {
          return missingNumericResult();
        }
        return this.acc!.populationStdDev;
      }
      default: {
        const _x: never = this.op;
        return _x;
      }
    }
  }

  metricSnapshot(): BucketMetricSnapshot {
    const value = this.finalize();
    let resultHint: string | undefined;
    if (isTraceableNull(value)) {
      resultHint = value.reason;
    }
    if (this.op === 'count') {
      return {
        outputKey: this.outputKey,
        sourceField: this.sourceField,
        op: this.op,
        validSampleCount: this.bucketRowCount,
        missingSampleCount: 0,
        resultHint,
      };
    }
    return {
      outputKey: this.outputKey,
      sourceField: this.sourceField,
      op: this.op,
      validSampleCount: this.acc!.validCount,
      missingSampleCount: this.acc!.missingCount,
      resultHint,
    };
  }
}

/**
 * **底层流式聚合引擎（单桶）**：按协议对多指标增量更新，不保留原始行。
 * 多桶场景由 {@link AggregatorEngine}（transform-engine）按分组键维护多个 `BucketAggregator`。
 */
export class BucketAggregator {
  private readonly slots = new Map<string, BuiltinMetricSlot>();

  /**
   * @param sourceFieldByOutputKey 输出键 → 行上取值字段；省略时输出键即源字段名。
   */
  constructor(
    builtinSpec: Readonly<Record<string, AggregationProtocolOp>>,
    sourceFieldByOutputKey?: Readonly<Record<string, string>>,
  ) {
    for (const [outKey, op] of Object.entries(builtinSpec)) {
      const src = sourceFieldByOutputKey?.[outKey] ?? outKey;
      this.slots.set(outKey, new BuiltinMetricSlot(outKey, src, op));
    }
  }

  /** 每调用一次表示落入该桶一行：`COUNT` 按行 +1，其余指标从 `row[sourceField]` 取值。 */
  ingest(row: Record<string, unknown>): void {
    for (const [, slot] of this.slots) {
      if (slot.op === 'count') {
        slot.addRowValue(undefined);
      } else {
        slot.addRowValue(row[slot.sourceField]);
      }
    }
  }

  /** 各输出键的最终聚合值（与查询引擎 finalize 一致）。 */
  finalize(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [field, slot] of this.slots) {
      out[field] = slot.finalize();
    }
    return out;
  }

  /**
   * 各数值指标对应的 {@link StatAccumulator.missingCount}（`COUNT` 指标不包含在内，值为 0）。
   */
  missingCountsByField(): Record<string, number> {
    const o: Record<string, number> = {};
    for (const [field, slot] of this.slots) {
      o[field] = slot.missingCount;
    }
    return o;
  }

  /**
   * 叶子节点上各指标的 {@link StatAccumulator}（`COUNT` 对应 `null`）。
   */
  statAccumulatorsByField(): Record<string, StatAccumulator | null> {
    const o: Record<string, StatAccumulator | null> = {};
    for (const [field, slot] of this.slots) {
      o[field] = slot.getUnderlyingAccumulator();
    }
    return o;
  }

  /** 各内置指标的样本量、缺失量与结果溯源（与 {@link finalize} 一致语义）。 */
  buildMetricSnapshots(): Record<string, BucketMetricSnapshot> {
    const o: Record<string, BucketMetricSnapshot> = {};
    for (const [outKey, slot] of this.slots) {
      o[outKey] = slot.metricSnapshot();
    }
    return o;
  }
}

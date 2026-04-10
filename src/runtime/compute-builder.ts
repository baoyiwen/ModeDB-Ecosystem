import type { AggregateInputEntry, AggregateOp } from './transform-engine.js';

const COMPUTE_METRIC_TAG = 'mode_db_compute_metric' as const;

/**
 * {@link QueryChain.compute} 闭包返回的指标令牌；由 {@link ComputeBuilder} 生成。
 */
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

/**
 * 语义化聚合 API，在闭包内生成令牌数组，由 {@link QueryChain.compute} 转为内置协议。
 *
 * @example
 * ```ts
 * .compute((f) => [f.sum('population'), f.avg('population'), f.variance('gdp')])
 * ```
 */
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

/** 将 {@link ComputeMetricToken}[] 合并为 {@link AggregateInputEntry} 映射（同字段多算子 → 数组）。 */
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

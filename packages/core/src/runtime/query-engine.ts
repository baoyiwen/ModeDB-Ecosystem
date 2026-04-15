import { isDeletedRecord, type ModelRecord } from '@mode-db/common';
import {
  evaluatePredicate,
  formatEvaluateFailure,
  type EvaluateResult,
  type PredicateEvaluateContext,
  type PredicateNode,
} from './predicate-tree.js';
import type { FieldMatchContext } from './query-filter.js';

/**
 * Merge on-disk rows with the authoring write-behind map (`_id` → row). Buffer wins on duplicate `_id`.
 * Rows carrying `__deleted: true` are stripped from the result so deleted data never surfaces in queries.
 */
export function mergeDiskRowsWithAuthoringBuffer(
  diskRows: readonly ModelRecord[],
  pendingById: ReadonlyMap<string, ModelRecord>,
): ModelRecord[] {
  if (pendingById.size === 0) {
    return [...diskRows];
  }
  const byId = new Map<string, ModelRecord>();
  const order: string[] = [];
  for (const r of diskRows) {
    byId.set(r._id, r);
    order.push(r._id);
  }
  for (const r of pendingById.values()) {
    if (!byId.has(r._id)) {
      order.push(r._id);
    }
    byId.set(r._id, r);
  }
  return order.filter((id) => !isDeletedRecord(byId.get(id)!)).map((id) => byId.get(id)!);
}

/**
 * 查询谓词递归引擎：对单行数据递归求值；**AND 短路**、**OR 短路**与 {@link evaluatePredicate} 一致。
 *
 * **读写一致性（Authoring）：** 行集在 `QueryChain.execute` / `executeFlat` 中先经 `DataReader`（如
 * `MergedDataReader`）合并磁盘与缓冲，再对本类 {@link evaluate} / {@link execute} 做谓词过滤；聚合同理基于合并后行集。
 */
export class QueryEngine {
  static evaluate(
    data: ModelRecord,
    node: PredicateNode,
    fieldCtx?: FieldMatchContext,
  ): EvaluateResult {
    return evaluatePredicate(data, node, undefined, fieldCtx);
  }

  /**
   * 与 {@link evaluate} 相同；命名与「整条查询执行」对齐。合并视图由 `DataReader` 提供后再谓词求值。
   */
  static execute(
    data: ModelRecord,
    node: PredicateNode,
    fieldCtx?: FieldMatchContext,
  ): EvaluateResult {
    return evaluatePredicate(data, node, undefined, fieldCtx);
  }

  /**
   * 求值并写入 `ctx`：`failedAt` / `failureKind`（属性不匹配、回调假、OR 全假）。
   * 调用前可置 `ctx.failedAt = undefined` 等以复用对象。
   */
  static evaluateInto(
    data: ModelRecord,
    node: PredicateNode,
    ctx: PredicateEvaluateContext,
    fieldCtx?: FieldMatchContext,
  ): EvaluateResult {
    ctx.failedAt = undefined;
    ctx.failureKind = undefined;
    return evaluatePredicate(data, node, ctx, fieldCtx);
  }

  static matches(data: ModelRecord, node: PredicateNode, fieldCtx?: FieldMatchContext): boolean {
    return evaluatePredicate(data, node, undefined, fieldCtx).ok;
  }

  static explainFailure(data: ModelRecord, node: PredicateNode): string {
    const ev = evaluatePredicate(data, node);
    return formatEvaluateFailure(ev);
  }
}

export type { EvaluateResult, PredicateEvaluateContext } from './predicate-tree.js';

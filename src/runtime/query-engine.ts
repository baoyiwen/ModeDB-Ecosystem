import type { ModelRecord } from '../../common/types.js';
import {
  evaluatePredicate,
  formatEvaluateFailure,
  type EvaluateResult,
  type PredicateEvaluateContext,
  type PredicateNode,
} from './predicate-tree.js';

/**
 * 查询谓词递归引擎：对单行数据递归求值；**AND 短路**、**OR 短路**与 {@link evaluatePredicate} 一致。
 *
 * **读写一致性（Authoring）：** `QueryChain.execute()` 通过 `DataReader` 取行；`AuthoringEngine.createRuntime`
 * 与 `ModelDBClient.fromContext` 使用的读取器会合并磁盘与未刷盘缓冲，故 `insert` 后即使尚未刷盘，
 * 同进程查询也能看到新行。本类只对**单行**做谓词求值，合并发生在读取层。
 */
export class QueryEngine {
  static evaluate(data: ModelRecord, node: PredicateNode): EvaluateResult {
    return evaluatePredicate(data, node);
  }

  /**
   * 求值并写入 `ctx`：`failedAt` / `failureKind`（属性不匹配、回调假、OR 全假）。
   * 调用前可置 `ctx.failedAt = undefined` 等以复用对象。
   */
  static evaluateInto(
    data: ModelRecord,
    node: PredicateNode,
    ctx: PredicateEvaluateContext,
  ): EvaluateResult {
    ctx.failedAt = undefined;
    ctx.failureKind = undefined;
    return evaluatePredicate(data, node, ctx);
  }

  static matches(data: ModelRecord, node: PredicateNode): boolean {
    return evaluatePredicate(data, node).ok;
  }

  static explainFailure(data: ModelRecord, node: PredicateNode): string {
    const ev = evaluatePredicate(data, node);
    return formatEvaluateFailure(ev);
  }
}

export type { EvaluateResult, PredicateEvaluateContext } from './predicate-tree.js';

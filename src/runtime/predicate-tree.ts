/**
 * 谓词协议（Predicate protocol）
 *
 * - **标准算子** {@link PredicateStandardOperator}：`eq` / `neq` / `gt` / `lt` / `like` / `in`。
 * - **{@link AtomNode}**：字段 + 算子 + 值；算子可含扩展 **`gte` / `lte` / `between`**（与 `QueryChain.where` 一致）。
 * - **{@link GroupNode}**：`AND` / `OR` 与任意深度的 `children`。
 * - **{@link CallbackNode}**：行级自定义函数（如 `filter`），不参与 JSON 完整序列化。
 *
 * **{@link PredicateNode}** = `AtomNode | GroupNode | CallbackNode`（IR 超集；序列化/教学场景可视为 Atom|Group）。
 */
import type { ModelRecord } from '@mode-db/common';
import { matchesAtomic, type ScalarOperator, type FieldMatchContext } from './query-filter.js';

/** 语义化查询核心算子（与 FilterBuilder 主 API 对齐） */
export type PredicateStandardOperator = 'eq' | 'neq' | 'gt' | 'lt' | 'like' | 'in';

/** 叶子节点可用算子 = 标准算子 + 引擎扩展（gte/lte/between） */
export type PredicateAtomOperator = PredicateStandardOperator | 'gte' | 'lte' | 'between';

/** 叶子：单字段比较 */
export interface AtomNode {
  readonly type: 'atom';
  readonly field: string;
  readonly op: PredicateAtomOperator;
  readonly value: unknown;
}

/** 可嵌套的逻辑组 */
export interface GroupNode {
  readonly type: 'group';
  readonly logic: 'AND' | 'OR';
  readonly children: readonly PredicateNode[];
}

/** 自定义行级谓词（无法序列化 fn） */
export interface CallbackNode {
  readonly type: 'callback';
  readonly fn: (rec: ModelRecord) => boolean;
  readonly label?: string;
}

export type PredicateNode = AtomNode | GroupNode | CallbackNode;

/** 谓词求值失败类别（属性不匹配 / 回调假 / OR 全假） */
export type PredicateFailureKind = 'ATTRIBUTE_MISMATCH' | 'CALLBACK_FALSE' | 'OR_UNSATISFIED';

/** 可选输出：在递归 evaluate 过程中写入失败节点与原因类别 */
export interface PredicateEvaluateContext {
  failedAt?: PredicateNode;
  failureKind?: PredicateFailureKind;
}

export interface EvaluateResult {
  readonly ok: boolean;
  /** 若 `ok` 为 false：导致失败的最具体节点（AND 取首个失败子节点；OR 全部失败时取该 OR 组） */
  readonly failedAt?: PredicateNode;
  readonly failureKind?: PredicateFailureKind;
}

function failureKindFor(node: PredicateNode): PredicateFailureKind {
  if (node.type === 'atom') {
    return 'ATTRIBUTE_MISMATCH';
  }
  if (node.type === 'callback') {
    return 'CALLBACK_FALSE';
  }
  return 'OR_UNSATISFIED';
}

export function atomNode(field: string, op: ScalarOperator, value: unknown): AtomNode {
  return { type: 'atom', field, op: op as PredicateAtomOperator, value };
}

export function groupNode(logic: 'AND' | 'OR', children: readonly PredicateNode[]): GroupNode {
  return { type: 'group', logic, children };
}

export function callbackNode(fn: (rec: ModelRecord) => boolean, label?: string): CallbackNode {
  return { type: 'callback', fn, label };
}

/**
 * 递归求值；支持任意深度 AND/OR 嵌套。
 *
 * **AND 短路**：从左到右依次求子节点；**一旦出现 false，立即返回该失败结果，不再求值后续兄弟**（必须全真才为真）。
 * **OR 短路**：一旦出现 true，立即返回成功，不再求值后续兄弟。
 */
export function evaluatePredicate(
  data: ModelRecord,
  node: PredicateNode,
  ctx?: PredicateEvaluateContext,
  fieldCtx?: FieldMatchContext,
): EvaluateResult {
  const finish = (r: EvaluateResult): EvaluateResult => {
    if (ctx && !r.ok && r.failedAt) {
      ctx.failedAt = r.failedAt;
      ctx.failureKind = r.failureKind ?? failureKindFor(r.failedAt);
    }
    return r;
  };

  switch (node.type) {
    case 'atom': {
      const ok = matchesAtomic(
        data,
        {
          field: node.field,
          operator: node.op as ScalarOperator,
          value: node.value,
        },
        fieldCtx,
      );
      if (ok) {
        return { ok: true };
      }
      const fk = failureKindFor(node);
      return finish({ ok: false, failedAt: node, failureKind: fk });
    }
    case 'callback': {
      const ok = node.fn(data);
      if (ok) {
        return { ok: true };
      }
      const fk = failureKindFor(node);
      return finish({ ok: false, failedAt: node, failureKind: fk });
    }
    case 'group': {
      if (node.children.length === 0) {
        return { ok: true };
      }
      if (node.logic === 'AND') {
        for (const c of node.children) {
          const r = evaluatePredicate(data, c, ctx, fieldCtx);
          if (!r.ok) {
            return r;
          }
        }
        return { ok: true };
      }
      for (const c of node.children) {
        const r = evaluatePredicate(data, c, ctx, fieldCtx);
        if (r.ok) {
          return { ok: true };
        }
      }
      return finish({
        ok: false,
        failedAt: node,
        failureKind: 'OR_UNSATISFIED',
      });
    }
    default: {
      const _x: never = node;
      return _x;
    }
  }
}

export function predicateMatcher(
  node: PredicateNode,
  fieldCtx?: FieldMatchContext,
): (rec: ModelRecord) => boolean {
  return (rec) => evaluatePredicate(rec, node, undefined, fieldCtx).ok;
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

/** 深度优先序列化（callback 仅保留占位） */
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

/**
 * 反序列化 {@link serializePredicate} 的 JSON；**`callback` 占位无法还原函数**，将抛错。
 */
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

export function formatPredicateNode(node: PredicateNode): string {
  if (node.type === 'atom') {
    return `${node.field} ${node.op} ${JSON.stringify(node.value)}`;
  }
  if (node.type === 'callback') {
    return node.label ? `callback(${node.label})` : 'callback()';
  }
  return `${node.logic}(${node.children.length})`;
}

export function formatEvaluateFailure(ev: EvaluateResult): string {
  if (ev.ok || !ev.failedAt) {
    return '';
  }
  return `failed at ${formatPredicateNode(ev.failedAt)}`;
}

/** 树中是否包含 callback（用于 _id/id 优化短路） */
export function treeHasCallback(node: PredicateNode): boolean {
  if (node.type === 'callback') {
    return true;
  }
  if (node.type === 'atom') {
    return false;
  }
  return node.children.some(treeHasCallback);
}

/** 整棵树等价于单个 `_id`/`id` 的 eq 且树中无 callback 时返回该 atom */
export function tryExtractSingleIdEq(node: PredicateNode): AtomNode | undefined {
  if (treeHasCallback(node)) {
    return undefined;
  }
  if (node.type === 'atom' && node.op === 'eq' && (node.field === '_id' || node.field === 'id')) {
    return node;
  }
  if (node.type === 'group' && node.logic === 'AND' && node.children.length === 1) {
    return tryExtractSingleIdEq(node.children[0]!);
  }
  return undefined;
}

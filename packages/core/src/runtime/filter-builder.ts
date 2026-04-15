import type { ModelRecord } from '@mode-db/common';
import { atomNode, callbackNode, groupNode, type PredicateNode } from './predicate-tree.js';
import { normalizeOperator } from './query-filter.js';

export type FilterBuilderInput<M extends Record<string, unknown> = Record<string, unknown>> =
  | PredicateNode
  | FilterBuilder<M>;

function toPredicateNode<M extends Record<string, unknown>>(
  x: FilterBuilderInput<M>,
): PredicateNode {
  return x instanceof FilterBuilder ? x.toPredicateNode() : x;
}

/**
 * 无状态组合器：每个方法返回 {@link PredicateNode}，用于 `matchAllNodes` / `matchAny` 或独立拼装子树。
 */
export class PredicateComposer<M extends Record<string, unknown> = Record<string, unknown>> {
  is<K extends keyof M & string>(field: K, value: M[K]): PredicateNode {
    return atomNode(field, 'eq', value as unknown);
  }

  not<K extends keyof M & string>(field: K, value: M[K]): PredicateNode {
    return atomNode(field, 'neq', value as unknown);
  }

  /** 大于 `gt` */
  gt<K extends keyof M & string>(field: K, value: unknown): PredicateNode {
    return atomNode(field, 'gt', value);
  }

  /** 小于 `lt` */
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

/**
 * 谓词工具类：链式累积为子树（{@link toPredicateNode}），或通过 {@link FilterBuilder.compose} 得到无状态组合器以**单独**生成节点。
 */
export class FilterBuilder<M extends Record<string, unknown> = Record<string, unknown>> {
  private readonly acc: PredicateNode[] = [];

  /**
   * 返回绑定行类型 `M` 的 {@link PredicateComposer}，用于不写 `new FilterBuilder` 即可得到独立 {@link PredicateNode}。
   *
   * @example
   * ```ts
   * type Row = { status: string; power: number };
   * const p = FilterBuilder.compose<Row>();
   * const n = p.and(p.is('status', 'ok'), p.gt('power', 10));
   * ```
   */
  static compose<
    M extends Record<string, unknown> = Record<string, unknown>,
  >(): PredicateComposer<M> {
    return new PredicateComposer<M>();
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

  filter(fn: (rec: ModelRecord) => boolean, label?: string): this {
    this.acc.push(callbackNode(fn, label));
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

/** 将「当前 AND 段」与多条 OR 分支做分配：`(prefix ∧ b₁) ∨ (prefix ∧ b₂) ∨ …` */
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

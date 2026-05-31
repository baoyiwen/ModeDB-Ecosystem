/** 引擎 `sys_relation.selfCardinality` 存储值。 */
export const RELATION_CARDINALITY_ONE = 'one';
export const RELATION_CARDINALITY_MANY = 'many';

export type RelationCardinality =
  | typeof RELATION_CARDINALITY_ONE
  | typeof RELATION_CARDINALITY_MANY;

/** 将任意历史值规范为 `one` | `many`（默认一对多 → `many`）。 */
export function normalizeRelationCardinality(value: string | undefined): RelationCardinality {
  if (value === RELATION_CARDINALITY_ONE) {
    return RELATION_CARDINALITY_ONE;
  }
  return RELATION_CARDINALITY_MANY;
}

/** 一对多（source 实例 → 多个 target）。 */
export function isOneToManyCardinality(value: string | undefined): boolean {
  return normalizeRelationCardinality(value) === RELATION_CARDINALITY_MANY;
}

/** 多对一（多个 source → 一个 target）。 */
export function isManyToOneCardinality(value: string | undefined): boolean {
  return normalizeRelationCardinality(value) === RELATION_CARDINALITY_ONE;
}

export function relationCardinalityUiKey(
  value: string | undefined,
): 'relationCardinalityOneToMany' | 'relationCardinalityManyToOne' {
  return isManyToOneCardinality(value)
    ? 'relationCardinalityManyToOne'
    : 'relationCardinalityOneToMany';
}

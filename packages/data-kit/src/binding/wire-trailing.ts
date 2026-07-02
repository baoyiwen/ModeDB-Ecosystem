import { atomNode, groupNode, serializePredicate, type PredicateNode } from '@mode-db/shared';

/** Minimal drill filter shape for wire trailing serialization. */
export interface TrailingDrillStep {
  readonly dimension: string;
  readonly value: unknown;
}

/** Wire-safe empty trailing predicate (`AND` with no children). */
export const WIRE_EMPTY_TRAILING = serializePredicate(groupNode('AND', []));

/** Serializes drill filters into a wire-safe `plan.trailing` object. */
export function wireTrailingFromDrill(path: readonly TrailingDrillStep[]): Record<string, unknown> {
  if (path.length === 0) {
    return WIRE_EMPTY_TRAILING;
  }
  const atoms = path.map((step) => atomNode(step.dimension, 'eq', step.value));
  const node: PredicateNode = atoms.length === 1 ? atoms[0]! : groupNode('AND', atoms);
  return serializePredicate(node);
}

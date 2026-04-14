import type { RelationDefinition, ModelRegistry } from '@mode-db/common';
import { RelationNotFoundError } from '@mode-db/common';

export type ResolvedDirection = 'forward' | 'reverse';

export interface ResolvedRelation {
  readonly definition: RelationDefinition;
  readonly direction: ResolvedDirection;
}

/**
 * Resolve a relation label against a model and its inheritance chain (same rules as {@link QueryChain}).
 */
export function resolveRelationOnRegistry(
  registry: ModelRegistry,
  relationName: string,
  modelName: string,
): ResolvedRelation {
  const chain = registry.getInheritanceChain(modelName);

  for (const ancestor of chain) {
    const relations = registry.getRelationsOf(ancestor);

    for (const rel of relations) {
      if (rel.source === ancestor && rel.forward === relationName) {
        return { definition: rel, direction: 'forward' };
      }
      if (rel.target === ancestor && rel.reverse === relationName) {
        return { definition: rel, direction: 'reverse' };
      }
    }
  }

  throw new RelationNotFoundError(relationName, modelName);
}

export function targetModelName(resolved: ResolvedRelation): string {
  return resolved.direction === 'forward' ? resolved.definition.target : resolved.definition.source;
}

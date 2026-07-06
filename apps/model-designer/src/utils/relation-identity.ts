import type { EngineRelationEdge } from '../types/engine-schema.js';
import {
  normalizeRelationCardinality,
  RELATION_CARDINALITY_MANY,
  RELATION_CARDINALITY_ONE,
  type RelationCardinality,
} from '../config/relation-cardinality.js';

export type RelationLogicWire = 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many';

function relationScopeKey(sourceModelId: string, targetModelId: string): string {
  if (sourceModelId === targetModelId) {
    return `self:${sourceModelId}`;
  }
  return [sourceModelId, targetModelId].sort().join('::');
}

export function relationScopeOf(
  rel: Pick<EngineRelationEdge, 'source_model_id' | 'target_model_id'>,
): string {
  return relationScopeKey(rel.source_model_id, rel.target_model_id);
}

export function relationNamesUsedInScope(
  relations: readonly EngineRelationEdge[],
  sourceModelId: string,
  targetModelId: string,
  exceptRelationId?: string,
): Set<string> {
  const scope = relationScopeKey(sourceModelId, targetModelId);
  const used = new Set<string>();
  for (const rel of relations) {
    if (rel.id === exceptRelationId || relationScopeOf(rel) !== scope) {
      continue;
    }
    if (rel.forward_name) {
      used.add(rel.forward_name);
    }
    if (rel.reverse_name) {
      used.add(rel.reverse_name);
    }
  }
  return used;
}

export function relationSourceCardinality(rel: EngineRelationEdge): RelationCardinality {
  if (rel.source_cardinality) {
    return normalizeRelationCardinality(rel.source_cardinality);
  }
  if (rel.self_cardinality === RELATION_CARDINALITY_ONE) {
    return RELATION_CARDINALITY_MANY;
  }
  return RELATION_CARDINALITY_ONE;
}

export function relationTargetCardinality(rel: EngineRelationEdge): RelationCardinality {
  if (rel.target_cardinality) {
    return normalizeRelationCardinality(rel.target_cardinality);
  }
  return normalizeRelationCardinality(rel.self_cardinality);
}

export function relationLogicFromCardinality(rel: EngineRelationEdge): RelationLogicWire {
  const source = relationSourceCardinality(rel);
  const target = relationTargetCardinality(rel);
  if (source === RELATION_CARDINALITY_ONE && target === RELATION_CARDINALITY_ONE) {
    return 'one-to-one';
  }
  if (source === RELATION_CARDINALITY_ONE && target === RELATION_CARDINALITY_MANY) {
    return 'one-to-many';
  }
  if (source === RELATION_CARDINALITY_MANY && target === RELATION_CARDINALITY_ONE) {
    return 'many-to-one';
  }
  return 'many-to-many';
}

export function relationCardinalityLabel(rel: EngineRelationEdge): '1:1' | '1:N' | 'N:1' | 'N:N' {
  const source = relationSourceCardinality(rel);
  const target = relationTargetCardinality(rel);
  const left = source === RELATION_CARDINALITY_ONE ? '1' : 'N';
  const right = target === RELATION_CARDINALITY_ONE ? '1' : 'N';
  return `${left}:${right}` as '1:1' | '1:N' | 'N:1' | 'N:N';
}

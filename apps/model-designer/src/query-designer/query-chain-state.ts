import { isInheritRelation } from '../config/graph-edge-kinds.js';
import type { EngineRelationEdge } from '../types/engine-schema.js';

export type QueryGraphEdgeRole = 'primary' | 'branch' | 'constraint';
export type QueryGraphEdgeDirection = 'forward' | 'reverse';

export interface QueryGraphEdgeState {
  relationId: string;
  role: QueryGraphEdgeRole;
  direction: QueryGraphEdgeDirection;
  usage?: QueryGraphRelationUsage;
}

export type QueryGraphRelationUsage =
  | { kind: 'direct' }
  | {
      kind: 'inherited';
      childModelId: string;
      ownerModelId: string;
      inheritRelationId: string;
    };

export interface QueryChainState {
  rootModelId: string | undefined;
  primaryRelationIds: string[];
  branchRelationIds: string[];
  constraintRelationIds: string[];
  relationUsages?: Record<string, QueryGraphRelationUsage>;
  activeModelId: string | undefined;
}

export const EMPTY_QUERY_CHAIN_STATE: QueryChainState = {
  rootModelId: undefined,
  primaryRelationIds: [],
  branchRelationIds: [],
  constraintRelationIds: [],
  relationUsages: {},
  activeModelId: undefined,
};

export function encodeQueryRelationId(
  relationId: string,
  direction: QueryGraphEdgeDirection,
): string {
  return `${direction}:${relationId}`;
}

export function decodeQueryRelationId(encodedRelationId: string): {
  relationId: string;
  direction: QueryGraphEdgeDirection;
} {
  if (encodedRelationId.startsWith('reverse:')) {
    return { relationId: encodedRelationId.slice('reverse:'.length), direction: 'reverse' };
  }
  if (encodedRelationId.startsWith('forward:')) {
    return { relationId: encodedRelationId.slice('forward:'.length), direction: 'forward' };
  }
  return { relationId: encodedRelationId, direction: 'forward' };
}

function queryChainTraversalRelationKeys(chain: QueryChainState): string[] {
  return [...chain.primaryRelationIds, ...chain.branchRelationIds];
}

function queryChainAllRelationKeys(chain: QueryChainState): string[] {
  return [...queryChainTraversalRelationKeys(chain), ...chain.constraintRelationIds];
}

export function queryChainTraversalRelationIds(chain: QueryChainState): string[] {
  return queryChainTraversalRelationKeys(chain).map(
    (relationKey) => decodeQueryRelationId(relationKey).relationId,
  );
}

export function queryChainAllRelationIds(chain: QueryChainState): string[] {
  return queryChainAllRelationKeys(chain).map(
    (relationKey) => decodeQueryRelationId(relationKey).relationId,
  );
}

export function queryChainModelIds(
  chain: QueryChainState,
  relations: readonly EngineRelationEdge[],
): string[] {
  if (!chain.rootModelId) {
    return [];
  }

  const byId = new Map(relations.map((relation) => [relation.id, relation]));
  const ids = new Set<string>([chain.rootModelId]);
  for (const relationKey of queryChainTraversalRelationKeys(chain)) {
    const { relationId, direction } = decodeQueryRelationId(relationKey);
    const relation = byId.get(relationId);
    if (relation) {
      ids.add(queryRelationSourceModelId(relation, direction, chain.relationUsages?.[relationKey]));
      ids.add(queryRelationTargetModelId(relation, direction));
    }
  }
  return Array.from(ids);
}

export function queryChainPrimaryModelIds(
  chain: QueryChainState,
  relations: readonly EngineRelationEdge[],
): string[] {
  if (!chain.rootModelId) {
    return [];
  }

  const byId = new Map(relations.map((relation) => [relation.id, relation]));
  const ids = [chain.rootModelId];
  for (const relationKey of chain.primaryRelationIds) {
    const { relationId, direction } = decodeQueryRelationId(relationKey);
    const relation = byId.get(relationId);
    if (relation) {
      ids.push(queryRelationTargetModelId(relation, direction));
    }
  }
  return ids;
}

export function queryChainTailModelId(
  chain: QueryChainState,
  relations: readonly EngineRelationEdge[],
): string | undefined {
  return queryChainPrimaryModelIds(chain, relations).at(-1);
}

export function queryChainCandidateRelationIds(
  chain: QueryChainState,
  relations: readonly EngineRelationEdge[],
): string[] {
  const selectedRelationIds = new Set(queryChainAllRelationIds(chain));
  const graphModelIds = new Set(queryChainModelIds(chain, relations));
  if (graphModelIds.size === 0) {
    return [];
  }

  return relations
    .filter((relation) => {
      if (selectedRelationIds.has(relation.id)) {
        return false;
      }
      if (
        graphModelIds.has(relation.source_model_id) ||
        graphModelIds.has(relation.target_model_id)
      ) {
        return true;
      }
      return Array.from(graphModelIds).some((modelId) =>
        inheritedRelationCandidate(modelId, relation, relations),
      );
    })
    .map((relation) => relation.id);
}

export function queryChainEdgeStates(chain: QueryChainState): QueryGraphEdgeState[] {
  return [
    ...chain.primaryRelationIds.map((relationKey) => {
      const decoded = decodeQueryRelationId(relationKey);
      return { ...decoded, role: 'primary' as const, usage: chain.relationUsages?.[relationKey] };
    }),
    ...chain.branchRelationIds.map((relationKey) => {
      const decoded = decodeQueryRelationId(relationKey);
      return { ...decoded, role: 'branch' as const, usage: chain.relationUsages?.[relationKey] };
    }),
    ...chain.constraintRelationIds.map((relationKey) => {
      const decoded = decodeQueryRelationId(relationKey);
      return {
        ...decoded,
        role: 'constraint' as const,
        usage: chain.relationUsages?.[relationKey],
      };
    }),
  ];
}

export function nextQueryChainFromModelPick(
  chain: QueryChainState,
  modelId: string,
  relations: readonly EngineRelationEdge[],
): QueryChainState {
  if (!chain.rootModelId) {
    return { ...EMPTY_QUERY_CHAIN_STATE, rootModelId: modelId, activeModelId: modelId };
  }

  const graphModelIds = queryChainModelIds(chain, relations);
  if (graphModelIds.includes(modelId)) {
    return { ...chain, activeModelId: modelId };
  }

  const next = findTraversalRelationToModel(chain, modelId, relations);
  if (!next) {
    return chain;
  }

  return addTraversalRelation(chain, next.relation, relations, next.direction, next.usage);
}

export function nextQueryChainFromRelationPick(
  chain: QueryChainState,
  relationId: string,
  relations: readonly EngineRelationEdge[],
): QueryChainState {
  const relation = relations.find((item) => item.id === relationId);
  if (!relation) {
    return chain;
  }

  if (!chain.rootModelId) {
    return {
      ...EMPTY_QUERY_CHAIN_STATE,
      rootModelId: relation.source_model_id,
      primaryRelationIds: [encodeQueryRelationId(relation.id, 'forward')],
      activeModelId: relation.target_model_id,
    };
  }

  const selectedRelationIds = new Set(queryChainAllRelationIds(chain));
  const graphModelIds = new Set(queryChainModelIds(chain, relations));
  if (selectedRelationIds.has(relation.id)) {
    if (graphModelIds.has(relation.target_model_id)) {
      return { ...chain, activeModelId: relation.target_model_id };
    }
    return { ...chain, activeModelId: relation.source_model_id };
  }

  const sourceInGraph = graphModelIds.has(relation.source_model_id);
  const targetInGraph = graphModelIds.has(relation.target_model_id);
  const directDirection: QueryGraphEdgeDirection = sourceInGraph ? 'forward' : 'reverse';
  const inherited = findInheritedRelationUsageFromGraph(chain, relation, relations);
  const direction = inherited?.direction ?? directDirection;
  const usage = inherited?.usage;

  if (sourceInGraph && targetInGraph) {
    return {
      ...chain,
      constraintRelationIds: [
        ...chain.constraintRelationIds,
        encodeQueryRelationId(relation.id, direction),
      ],
      activeModelId: queryRelationTargetModelId(relation, direction),
    };
  }

  if (sourceInGraph || targetInGraph) {
    return addTraversalRelation(chain, relation, relations, direction, usage);
  }

  if (inherited) {
    return addTraversalRelation(chain, relation, relations, inherited.direction, inherited.usage);
  }

  return chain;
}

function findTraversalRelationToModel(
  chain: QueryChainState,
  modelId: string,
  relations: readonly EngineRelationEdge[],
):
  | {
      relation: EngineRelationEdge;
      direction: QueryGraphEdgeDirection;
      usage?: QueryGraphRelationUsage;
    }
  | undefined {
  const selectedRelationIds = new Set(queryChainAllRelationIds(chain));
  const graphModelIds = new Set(queryChainModelIds(chain, relations));
  const activeModelId = chain.activeModelId ?? queryChainTailModelId(chain, relations);
  const tailModelId = queryChainTailModelId(chain, relations);

  return (
    findRelationStep(activeModelId, modelId, relations, selectedRelationIds) ??
    findInheritedRelationStep(activeModelId, modelId, relations, selectedRelationIds) ??
    findRelationStep(tailModelId, modelId, relations, selectedRelationIds) ??
    findInheritedRelationStep(tailModelId, modelId, relations, selectedRelationIds) ??
    findAnyGraphRelationStep(graphModelIds, modelId, relations, selectedRelationIds)
  );
}

function findAnyGraphRelationStep(
  graphModelIds: ReadonlySet<string>,
  toModelId: string,
  relations: readonly EngineRelationEdge[],
  selectedRelationIds: ReadonlySet<string>,
):
  | {
      relation: EngineRelationEdge;
      direction: QueryGraphEdgeDirection;
      usage?: QueryGraphRelationUsage;
    }
  | undefined {
  for (const relation of relations) {
    if (selectedRelationIds.has(relation.id)) {
      continue;
    }
    if (graphModelIds.has(relation.source_model_id) && relation.target_model_id === toModelId) {
      return { relation, direction: 'forward' };
    }
    if (graphModelIds.has(relation.target_model_id) && relation.source_model_id === toModelId) {
      return { relation, direction: 'reverse' };
    }
    for (const graphModelId of graphModelIds) {
      const inherited = inheritedRelationCandidate(graphModelId, relation, relations);
      if (inherited && queryRelationTargetModelId(relation, inherited.direction) === toModelId) {
        return { relation, direction: inherited.direction, usage: inherited.usage };
      }
    }
  }
  return undefined;
}

function findRelationStep(
  fromModelId: string | undefined,
  toModelId: string,
  relations: readonly EngineRelationEdge[],
  selectedRelationIds: ReadonlySet<string>,
): { relation: EngineRelationEdge; direction: QueryGraphEdgeDirection } | undefined {
  if (!fromModelId) {
    return undefined;
  }
  for (const relation of relations) {
    if (selectedRelationIds.has(relation.id)) {
      continue;
    }
    if (relation.source_model_id === fromModelId && relation.target_model_id === toModelId) {
      return { relation, direction: 'forward' };
    }
    if (relation.target_model_id === fromModelId && relation.source_model_id === toModelId) {
      return { relation, direction: 'reverse' };
    }
  }
  return undefined;
}

function addTraversalRelation(
  chain: QueryChainState,
  relation: EngineRelationEdge,
  relations: readonly EngineRelationEdge[],
  direction: QueryGraphEdgeDirection,
  usage?: QueryGraphRelationUsage,
): QueryChainState {
  const tailModelId = queryChainTailModelId(chain, relations);
  const sourceModelId = queryRelationSourceModelId(relation, direction, usage);
  const targetModelId = queryRelationTargetModelId(relation, direction);
  const relationKey = encodeQueryRelationId(relation.id, direction);
  const relationUsages = usage
    ? { ...(chain.relationUsages ?? {}), [relationKey]: usage }
    : chain.relationUsages;
  const isPrimary = sourceModelId === tailModelId;
  if (isPrimary) {
    return {
      ...chain,
      primaryRelationIds: [...chain.primaryRelationIds, relationKey],
      relationUsages,
      activeModelId: targetModelId,
    };
  }

  return {
    ...chain,
    branchRelationIds: [...chain.branchRelationIds, relationKey],
    relationUsages,
    activeModelId: targetModelId,
  };
}

function queryRelationSourceModelId(
  relation: EngineRelationEdge,
  direction: QueryGraphEdgeDirection,
  usage?: QueryGraphRelationUsage,
): string {
  if (usage?.kind === 'inherited') {
    return usage.childModelId;
  }
  return direction === 'forward' ? relation.source_model_id : relation.target_model_id;
}

function queryRelationTargetModelId(
  relation: EngineRelationEdge,
  direction: QueryGraphEdgeDirection,
): string {
  return direction === 'forward' ? relation.target_model_id : relation.source_model_id;
}

function findInheritedRelationStep(
  fromModelId: string | undefined,
  toModelId: string,
  relations: readonly EngineRelationEdge[],
  selectedRelationIds: ReadonlySet<string>,
):
  | {
      relation: EngineRelationEdge;
      direction: QueryGraphEdgeDirection;
      usage: QueryGraphRelationUsage;
    }
  | undefined {
  if (!fromModelId) {
    return undefined;
  }
  for (const relation of relations) {
    if (selectedRelationIds.has(relation.id)) {
      continue;
    }
    const inherited = inheritedRelationCandidate(fromModelId, relation, relations);
    if (!inherited) {
      continue;
    }
    if (queryRelationTargetModelId(relation, inherited.direction) === toModelId) {
      return { relation, direction: inherited.direction, usage: inherited.usage };
    }
  }
  return undefined;
}

function findInheritedRelationUsageFromGraph(
  chain: QueryChainState,
  relation: EngineRelationEdge,
  relations: readonly EngineRelationEdge[],
): { direction: QueryGraphEdgeDirection; usage: QueryGraphRelationUsage } | undefined {
  for (const modelId of queryChainModelIds(chain, relations)) {
    const inherited = inheritedRelationCandidate(modelId, relation, relations);
    if (inherited) {
      return inherited;
    }
  }
  return undefined;
}

function inheritedRelationCandidate(
  childModelId: string,
  relation: EngineRelationEdge,
  relations: readonly EngineRelationEdge[],
): { direction: QueryGraphEdgeDirection; usage: QueryGraphRelationUsage } | undefined {
  if (isInheritRelation(relation.kind)) {
    return undefined;
  }
  for (const inherit of collectAncestorRelations(childModelId, relations)) {
    if (relation.source_model_id === inherit.ownerModelId) {
      return {
        direction: 'forward',
        usage: {
          kind: 'inherited',
          childModelId,
          ownerModelId: inherit.ownerModelId,
          inheritRelationId: inherit.inheritRelationId,
        },
      };
    }
    if (relation.target_model_id === inherit.ownerModelId) {
      return {
        direction: 'reverse',
        usage: {
          kind: 'inherited',
          childModelId,
          ownerModelId: inherit.ownerModelId,
          inheritRelationId: inherit.inheritRelationId,
        },
      };
    }
  }
  return undefined;
}

function collectAncestorRelations(
  childModelId: string,
  relations: readonly EngineRelationEdge[],
): { ownerModelId: string; inheritRelationId: string }[] {
  const result: { ownerModelId: string; inheritRelationId: string }[] = [];
  const visited = new Set<string>();
  let current = childModelId;
  while (!visited.has(current)) {
    visited.add(current);
    const inherit = relations.find(
      (relation) => isInheritRelation(relation.kind) && relation.target_model_id === current,
    );
    if (!inherit) {
      break;
    }
    result.push({ ownerModelId: inherit.source_model_id, inheritRelationId: inherit.id });
    current = inherit.source_model_id;
  }
  return result;
}

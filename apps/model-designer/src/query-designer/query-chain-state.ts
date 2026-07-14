import { isInheritRelation } from '../config/graph-edge-kinds.js';
import type { EngineRelationEdge } from '../types/engine-schema.js';

export type QueryGraphEdgeRole = 'primary' | 'branch' | 'constraint';
export type QueryGraphEdgeDirection = 'forward' | 'reverse';

export interface QueryGraphEdgeState {
  key?: string;
  relationId: string;
  role: QueryGraphEdgeRole;
  direction: QueryGraphEdgeDirection;
  sourceNodeId?: string;
  usage?: QueryGraphRelationUsage;
}

export interface QueryGraphNodeInstance {
  id: string;
  modelId: string;
  alias: string;
  role: 'root' | 'primary' | 'branch';
}

export interface QueryGraphEdgeInstance extends QueryGraphEdgeState {
  id: string;
  key: string;
  sourceNodeId: string;
  targetNodeId: string;
}

export interface QueryGraphInstances {
  rootNodeId: string | undefined;
  activeNodeId: string | undefined;
  primaryPathNodeIds: string[];
  nodes: QueryGraphNodeInstance[];
  edges: QueryGraphEdgeInstance[];
}

export interface QueryRelationSwitchCandidate {
  relationId: string;
  direction: QueryGraphEdgeDirection;
  usage?: QueryGraphRelationUsage;
}

export interface QueryRelationPickCandidate {
  sourceNodeId: string;
  sourceModelId: string;
  direction: QueryGraphEdgeDirection;
  usage?: QueryGraphRelationUsage;
}

export interface QueryModelPickCandidate extends QueryRelationPickCandidate {
  relationId: string;
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

const QUERY_RELATION_SOURCE_SEPARATOR = '::source::';

export function encodeQueryRelationId(
  relationId: string,
  direction: QueryGraphEdgeDirection,
  sourceNodeId?: string,
): string {
  return sourceNodeId
    ? `${direction}:${relationId}${QUERY_RELATION_SOURCE_SEPARATOR}${sourceNodeId}`
    : `${direction}:${relationId}`;
}

export function decodeQueryRelationId(encodedRelationId: string): {
  relationId: string;
  direction: QueryGraphEdgeDirection;
  sourceNodeId?: string;
} {
  const decode = (value: string, direction: QueryGraphEdgeDirection) => {
    const separatorIndex = value.indexOf(QUERY_RELATION_SOURCE_SEPARATOR);
    if (separatorIndex < 0) {
      return { relationId: value, direction };
    }
    return {
      relationId: value.slice(0, separatorIndex),
      direction,
      sourceNodeId: value.slice(separatorIndex + QUERY_RELATION_SOURCE_SEPARATOR.length),
    };
  };
  if (encodedRelationId.startsWith('reverse:')) {
    return decode(encodedRelationId.slice('reverse:'.length), 'reverse');
  }
  if (encodedRelationId.startsWith('forward:')) {
    return decode(encodedRelationId.slice('forward:'.length), 'forward');
  }
  return decode(encodedRelationId, 'forward');
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
      return {
        ...decoded,
        key: relationKey,
        role: 'primary' as const,
        usage: chain.relationUsages?.[relationKey],
      };
    }),
    ...chain.branchRelationIds.map((relationKey) => {
      const decoded = decodeQueryRelationId(relationKey);
      return {
        ...decoded,
        key: relationKey,
        role: 'branch' as const,
        usage: chain.relationUsages?.[relationKey],
      };
    }),
    ...chain.constraintRelationIds.map((relationKey) => {
      const decoded = decodeQueryRelationId(relationKey);
      return {
        ...decoded,
        key: relationKey,
        role: 'constraint' as const,
        usage: chain.relationUsages?.[relationKey],
      };
    }),
  ];
}

export function queryChainEdgeKey(
  edge: Pick<QueryGraphEdgeState, 'relationId' | 'direction' | 'key'>,
): string {
  if ('key' in edge && typeof edge.key === 'string') {
    return edge.key;
  }
  return encodeQueryRelationId(edge.relationId, edge.direction);
}

export function queryChainGraphInstances(
  chain: QueryChainState,
  relations: readonly EngineRelationEdge[],
): QueryGraphInstances {
  if (!chain.rootModelId) {
    return {
      rootNodeId: undefined,
      activeNodeId: undefined,
      primaryPathNodeIds: [],
      nodes: [],
      edges: [],
    };
  }

  const byId = new Map(relations.map((relation) => [relation.id, relation]));
  const nodes: QueryGraphNodeInstance[] = [
    {
      id: queryNodeInstanceId(chain.rootModelId, 0),
      modelId: chain.rootModelId,
      alias: chain.rootModelId,
      role: 'root',
    },
  ];
  const edges: QueryGraphEdgeInstance[] = [];
  const primaryPathNodeIds = [nodes[0].id];
  let activeNode = nodes[0];

  chain.primaryRelationIds.forEach((relationKey, index) => {
    const decoded = decodeQueryRelationId(relationKey);
    const relation = byId.get(decoded.relationId);
    if (!relation) {
      return;
    }
    const usage = chain.relationUsages?.[relationKey];
    const sourceModelId = queryRelationSourceModelId(relation, decoded.direction, usage);
    const targetModelId = queryRelationTargetModelId(relation, decoded.direction);
    const scopedSourceNode = decoded.sourceNodeId
      ? nodes.find((node) => node.id === decoded.sourceNodeId && node.modelId === sourceModelId)
      : undefined;
    const sourceNode =
      scopedSourceNode ??
      (activeNode.modelId === sourceModelId
        ? activeNode
        : (findLastQueryNodeByModelId(nodes, sourceModelId) ?? activeNode));
    const targetNode = createQueryNodeInstance({
      modelId: targetModelId,
      nodes,
      role: 'primary',
      relation,
      direction: decoded.direction,
    });
    nodes.push(targetNode);
    primaryPathNodeIds.push(targetNode.id);
    edges.push({
      id: queryEdgeInstanceId('primary', relationKey, index),
      key: relationKey,
      relationId: decoded.relationId,
      role: 'primary',
      direction: decoded.direction,
      usage,
      sourceNodeId: sourceNode.id,
      targetNodeId: targetNode.id,
    });
    activeNode = targetNode;
  });

  appendNonPrimaryInstances({
    chain,
    relationKeys: chain.branchRelationIds,
    role: 'branch',
    relationsById: byId,
    nodes,
    edges,
  });
  appendNonPrimaryInstances({
    chain,
    relationKeys: chain.constraintRelationIds,
    role: 'constraint',
    relationsById: byId,
    nodes,
    edges,
  });

  const activeNodeId =
    findLastQueryNodeByModelId(nodes, chain.activeModelId ?? activeNode.modelId)?.id ??
    activeNode.id;
  return {
    rootNodeId: nodes[0].id,
    activeNodeId,
    primaryPathNodeIds,
    nodes,
    edges,
  };
}

/**
 * Return the unambiguous traversal sources for a relation. The caller may add
 * the relation directly when there is one candidate, or ask the user to choose
 * when parallel instances of the same source model are present.
 */
export function queryChainRelationPickCandidates(
  chain: QueryChainState,
  relationId: string,
  relations: readonly EngineRelationEdge[],
): QueryRelationPickCandidate[] {
  const relation = relations.find((item) => item.id === relationId);
  if (!relation || !chain.rootModelId) {
    return [];
  }

  const graph = queryChainGraphInstances(chain, relations);
  const candidates = allQueryRelationPickCandidates(relation, relations, graph);
  const existingEdges = new Set(
    graph.edges.map((edge) => `${edge.relationId}:${edge.direction}:${edge.sourceNodeId}`),
  );
  const availableCandidates = candidates.filter(
    (candidate) =>
      !existingEdges.has(`${relation.id}:${candidate.direction}:${candidate.sourceNodeId}`),
  );
  const traversalEdges = graph.edges.filter((edge) => edge.role !== 'constraint');
  const parallelCandidates = availableCandidates.filter((candidate) => {
    const targetModelId = queryRelationTargetModelId(relation, candidate.direction);
    return traversalEdges.some((edge) => {
      const source = graph.nodes.find((node) => node.id === edge.sourceNodeId);
      const target = graph.nodes.find((node) => node.id === edge.targetNodeId);
      return source?.modelId === candidate.sourceModelId && target?.modelId === targetModelId;
    });
  });
  if (parallelCandidates.length > 0) {
    return parallelCandidates;
  }

  const graphModelIds = new Set(graph.nodes.map((node) => node.modelId));
  return availableCandidates.filter(
    (candidate) => !graphModelIds.has(queryRelationTargetModelId(relation, candidate.direction)),
  );
}

/**
 * Resolve an unselected model against every query-node instance already in the
 * graph. A model may be reachable through several parallel source instances,
 * so the result deliberately keeps relation and source-node identity together.
 */
export function queryChainModelPickCandidates(
  chain: QueryChainState,
  targetModelId: string,
  relations: readonly EngineRelationEdge[],
): QueryModelPickCandidate[] {
  if (!chain.rootModelId) {
    return [];
  }
  const graph = queryChainGraphInstances(chain, relations);
  const existingEdges = new Set(
    graph.edges.map((edge) => `${edge.relationId}:${edge.direction}:${edge.sourceNodeId}`),
  );
  const candidates: QueryModelPickCandidate[] = [];
  for (const relation of relations) {
    for (const candidate of allQueryRelationPickCandidates(relation, relations, graph)) {
      if (queryRelationTargetModelId(relation, candidate.direction) !== targetModelId) {
        continue;
      }
      const key = `${relation.id}:${candidate.direction}:${candidate.sourceNodeId}`;
      if (
        existingEdges.has(key) ||
        candidates.some(
          (item) => `${item.relationId}:${item.direction}:${item.sourceNodeId}` === key,
        )
      ) {
        continue;
      }
      candidates.push({ ...candidate, relationId: relation.id });
    }
  }
  return candidates;
}

/**
 * Nodes that participate in the returned result shape. Constraint edges may read
 * data for filtering, but they must not introduce output models or fields.
 */
export function queryGraphOutputNodes(graph: QueryGraphInstances): QueryGraphNodeInstance[] {
  if (!graph.rootNodeId) {
    return [];
  }

  const outputNodeIds = new Set<string>([graph.rootNodeId]);
  const pendingNodeIds = [graph.rootNodeId];
  const outgoing = new Map<string, QueryGraphEdgeInstance[]>();
  for (const edge of graph.edges) {
    if (edge.role === 'constraint') {
      continue;
    }
    const entries = outgoing.get(edge.sourceNodeId) ?? [];
    entries.push(edge);
    outgoing.set(edge.sourceNodeId, entries);
  }

  while (pendingNodeIds.length > 0) {
    const nodeId = pendingNodeIds.shift();
    if (!nodeId) {
      continue;
    }
    for (const edge of outgoing.get(nodeId) ?? []) {
      if (outputNodeIds.has(edge.targetNodeId)) {
        continue;
      }
      outputNodeIds.add(edge.targetNodeId);
      pendingNodeIds.push(edge.targetNodeId);
    }
  }

  return graph.nodes.filter((node) => outputNodeIds.has(node.id));
}

export function removeQueryChainRelation(
  chain: QueryChainState,
  edge: Pick<QueryGraphEdgeState, 'relationId' | 'direction'>,
  relations: readonly EngineRelationEdge[],
): QueryChainState {
  const relationKey = queryChainEdgeKey(edge);
  const relationUsages = omitRelationUsage(chain.relationUsages, relationKey);
  const next: QueryChainState = {
    ...chain,
    primaryRelationIds: chain.primaryRelationIds.filter((key) => key !== relationKey),
    branchRelationIds: chain.branchRelationIds.filter((key) => key !== relationKey),
    constraintRelationIds: chain.constraintRelationIds.filter((key) => key !== relationKey),
    relationUsages,
  };
  return {
    ...next,
    activeModelId: queryChainTailModelId(next, relations) ?? next.rootModelId,
  };
}

export function removeQueryChainModel(
  chain: QueryChainState,
  modelId: string,
  relations: readonly EngineRelationEdge[],
): QueryChainState {
  if (!chain.rootModelId || chain.rootModelId === modelId) {
    return EMPTY_QUERY_CHAIN_STATE;
  }

  const primaryModelIds = queryChainPrimaryModelIds(chain, relations);
  const primaryModelIndex = primaryModelIds.indexOf(modelId);
  if (primaryModelIndex > 0) {
    const previousModelId = primaryModelIds[primaryModelIndex - 1];
    const nextModelId = primaryModelIds[primaryModelIndex + 1];
    const beforeRemovedModel = chain.primaryRelationIds.slice(0, primaryModelIndex - 1);
    const afterRemovedModel = chain.primaryRelationIds.slice(primaryModelIndex + 1);
    const removedPrimaryKeys = new Set(chain.primaryRelationIds.slice(primaryModelIndex - 1));
    const discardedModelIds = new Set<string>();
    let relationUsages = chain.relationUsages;
    let primaryRelationIds = beforeRemovedModel;

    if (nextModelId) {
      const bridge = findUniqueBridgeRelation(previousModelId, nextModelId, relations);
      if (bridge) {
        const bridgeKey = encodeQueryRelationId(bridge.relation.id, bridge.direction);
        primaryRelationIds = [...beforeRemovedModel, bridgeKey, ...afterRemovedModel];
        for (const relationKey of chain.primaryRelationIds.slice(
          primaryModelIndex - 1,
          primaryModelIndex + 1,
        )) {
          relationUsages = omitRelationUsage(relationUsages, relationKey);
        }
        if (bridge.usage) {
          relationUsages = { ...(relationUsages ?? {}), [bridgeKey]: bridge.usage };
        }
        discardedModelIds.add(modelId);
      } else {
        primaryRelationIds = beforeRemovedModel;
        for (const removedModelId of primaryModelIds.slice(primaryModelIndex)) {
          discardedModelIds.add(removedModelId);
        }
      }
    } else {
      primaryRelationIds = beforeRemovedModel;
      discardedModelIds.add(modelId);
    }

    for (const relationKey of removedPrimaryKeys) {
      if (!primaryRelationIds.includes(relationKey)) {
        relationUsages = omitRelationUsage(relationUsages, relationKey);
      }
    }

    const rewired: QueryChainState = {
      ...chain,
      primaryRelationIds,
      relationUsages,
    };
    const next = removeQueryEdgesByPredicate(rewired, relations, (relation, direction, usage) => {
      const sourceModelId = queryRelationSourceModelId(relation, direction, usage);
      const targetModelId = queryRelationTargetModelId(relation, direction);
      return discardedModelIds.has(sourceModelId) || discardedModelIds.has(targetModelId);
    });

    return {
      ...next,
      activeModelId: queryChainTailModelId(next, relations) ?? next.rootModelId,
    };
  }

  const next = removeQueryEdgesByPredicate(chain, relations, (relation, direction, usage) => {
    const sourceModelId = queryRelationSourceModelId(relation, direction, usage);
    const targetModelId = queryRelationTargetModelId(relation, direction);
    return sourceModelId === modelId || targetModelId === modelId;
  });

  return {
    ...next,
    activeModelId: queryChainTailModelId(next, relations) ?? next.rootModelId,
  };
}

export function removeQueryChainNodeInstance(
  chain: QueryChainState,
  nodeId: string,
  relations: readonly EngineRelationEdge[],
): QueryChainState {
  const graph = queryChainGraphInstances(chain, relations);
  const node = graph.nodes.find((item) => item.id === nodeId);
  if (!node) {
    return chain;
  }
  const sameModelCount = graph.nodes.filter((item) => item.modelId === node.modelId).length;
  if (sameModelCount <= 1) {
    return removeQueryChainModel(chain, node.modelId, relations);
  }
  const primaryIndex = graph.primaryPathNodeIds.indexOf(node.id);
  if (primaryIndex === 0) {
    return EMPTY_QUERY_CHAIN_STATE;
  }
  if (primaryIndex > 0) {
    const removedKeys = new Set(chain.primaryRelationIds.slice(primaryIndex - 1));
    let relationUsages = chain.relationUsages;
    for (const relationKey of removedKeys) {
      relationUsages = omitRelationUsage(relationUsages, relationKey);
    }
    const next: QueryChainState = removeQueryEdgesByPredicate(
      {
        ...chain,
        primaryRelationIds: chain.primaryRelationIds.slice(0, primaryIndex - 1),
        relationUsages,
      },
      relations,
      (relation, direction, usage) =>
        queryRelationSourceModelId(relation, direction, usage) === node.modelId ||
        queryRelationTargetModelId(relation, direction) === node.modelId,
    );
    return {
      ...next,
      activeModelId: queryChainTailModelId(next, relations) ?? next.rootModelId,
    };
  }

  const incomingEdge = graph.edges.find((edge) => edge.targetNodeId === node.id);
  if (incomingEdge) {
    return removeQueryChainRelation(chain, incomingEdge, relations);
  }
  return chain;
}

export function updateQueryChainRelationRole(
  chain: QueryChainState,
  edge: Pick<QueryGraphEdgeState, 'relationId' | 'direction'>,
  role: QueryGraphEdgeRole,
): QueryChainState {
  const relationKey = queryChainEdgeKey(edge);
  const withoutEdge = {
    primaryRelationIds: chain.primaryRelationIds.filter((key) => key !== relationKey),
    branchRelationIds: chain.branchRelationIds.filter((key) => key !== relationKey),
    constraintRelationIds: chain.constraintRelationIds.filter((key) => key !== relationKey),
  };
  return {
    ...chain,
    primaryRelationIds:
      role === 'primary'
        ? [...withoutEdge.primaryRelationIds, relationKey]
        : withoutEdge.primaryRelationIds,
    branchRelationIds:
      role === 'branch'
        ? [...withoutEdge.branchRelationIds, relationKey]
        : withoutEdge.branchRelationIds,
    constraintRelationIds:
      role === 'constraint'
        ? [...withoutEdge.constraintRelationIds, relationKey]
        : withoutEdge.constraintRelationIds,
  };
}

export function updateQueryChainRelationDirection(
  chain: QueryChainState,
  edge: Pick<QueryGraphEdgeState, 'relationId' | 'direction'>,
  direction: QueryGraphEdgeDirection,
  relations: readonly EngineRelationEdge[],
): QueryChainState {
  if (edge.direction === direction) {
    return chain;
  }
  const relationKey = queryChainEdgeKey(edge);
  const nextRelationKey = encodeQueryRelationId(
    edge.relationId,
    direction,
    decodeQueryRelationId(relationKey).sourceNodeId,
  );
  const usage = chain.relationUsages?.[relationKey];
  const relationUsages = usage
    ? {
        ...omitRelationUsage(chain.relationUsages, relationKey),
        [nextRelationKey]: usage,
      }
    : omitRelationUsage(chain.relationUsages, relationKey);
  const next: QueryChainState = {
    ...chain,
    primaryRelationIds: chain.primaryRelationIds.map((key) =>
      key === relationKey ? nextRelationKey : key,
    ),
    branchRelationIds: chain.branchRelationIds.map((key) =>
      key === relationKey ? nextRelationKey : key,
    ),
    constraintRelationIds: chain.constraintRelationIds.map((key) =>
      key === relationKey ? nextRelationKey : key,
    ),
    relationUsages,
  };
  return {
    ...next,
    activeModelId: queryChainTailModelId(next, relations) ?? next.rootModelId,
  };
}

export function replaceQueryChainRelation(
  chain: QueryChainState,
  edge: Pick<QueryGraphEdgeState, 'relationId' | 'direction'>,
  nextEdge: {
    relationId: string;
    direction: QueryGraphEdgeDirection;
    usage?: QueryGraphRelationUsage;
  },
  relations: readonly EngineRelationEdge[],
): QueryChainState {
  const relationKey = queryChainEdgeKey(edge);
  const nextRelationKey = encodeQueryRelationId(
    nextEdge.relationId,
    nextEdge.direction,
    decodeQueryRelationId(relationKey).sourceNodeId,
  );
  const relationUsages = nextEdge.usage
    ? {
        ...omitRelationUsage(chain.relationUsages, relationKey),
        [nextRelationKey]: nextEdge.usage,
      }
    : omitRelationUsage(chain.relationUsages, relationKey);
  const replaceKey = (key: string): string => (key === relationKey ? nextRelationKey : key);
  const next: QueryChainState = {
    ...chain,
    primaryRelationIds: chain.primaryRelationIds.map(replaceKey),
    branchRelationIds: chain.branchRelationIds.map(replaceKey),
    constraintRelationIds: chain.constraintRelationIds.map(replaceKey),
    relationUsages,
  };
  return {
    ...next,
    activeModelId: queryChainTailModelId(next, relations) ?? next.rootModelId,
  };
}

export function queryChainRelationSwitchCandidates(
  chain: QueryChainState,
  edge: Pick<QueryGraphEdgeState, 'relationId' | 'direction'>,
  relations: readonly EngineRelationEdge[],
): QueryRelationSwitchCandidate[] {
  const edgeKey = queryChainEdgeKey(edge);
  const currentEdge = queryChainEdgeStates(chain).find(
    (item) => queryChainEdgeKey(item) === edgeKey,
  );
  const currentRelation = relations.find((relation) => relation.id === edge.relationId);
  if (!currentEdge || !currentRelation) {
    return [];
  }
  const sourceModelId = queryRelationSourceModelId(
    currentRelation,
    currentEdge.direction,
    currentEdge.usage,
  );
  const targetModelId = queryRelationTargetModelId(currentRelation, currentEdge.direction);
  const occupiedRelationIds = new Set(
    queryChainAllRelationIds(chain).filter((relationId) => relationId !== currentEdge.relationId),
  );
  const candidates: QueryRelationSwitchCandidate[] = [];
  const pushCandidate = (
    relation: EngineRelationEdge,
    direction: QueryGraphEdgeDirection,
    usage?: QueryGraphRelationUsage,
  ): void => {
    const key = `${direction}:${relation.id}:${usage?.kind === 'inherited' ? usage.inheritRelationId : 'direct'}`;
    if (
      candidates.some((candidate) => {
        const candidateKey = `${candidate.direction}:${candidate.relationId}:${
          candidate.usage?.kind === 'inherited' ? candidate.usage.inheritRelationId : 'direct'
        }`;
        return candidateKey === key;
      })
    ) {
      return;
    }
    candidates.push({ relationId: relation.id, direction, usage });
  };

  for (const relation of relations) {
    if (isInheritRelation(relation.kind)) {
      continue;
    }
    if (occupiedRelationIds.has(relation.id)) {
      continue;
    }
    if (relation.source_model_id === sourceModelId && relation.target_model_id === targetModelId) {
      pushCandidate(relation, 'forward');
    }
    if (relation.target_model_id === sourceModelId && relation.source_model_id === targetModelId) {
      pushCandidate(relation, 'reverse');
    }
    const inherited = inheritedRelationCandidate(sourceModelId, relation, relations);
    if (inherited && queryRelationTargetModelId(relation, inherited.direction) === targetModelId) {
      pushCandidate(relation, inherited.direction, inherited.usage);
    }
  }

  return candidates;
}

export function queryChainRelationSwitchCandidateIds(
  chain: QueryChainState,
  edge: Pick<QueryGraphEdgeState, 'relationId' | 'direction'> | undefined,
  relations: readonly EngineRelationEdge[],
): string[] {
  if (!edge) {
    return [];
  }
  return Array.from(
    new Set(
      queryChainRelationSwitchCandidates(chain, edge, relations)
        .map((candidate) => candidate.relationId)
        .filter((relationId) => relationId !== edge.relationId),
    ),
  );
}

export function replaceQueryChainRelationWithRelation(
  chain: QueryChainState,
  edge: Pick<QueryGraphEdgeState, 'relationId' | 'direction'>,
  nextRelationId: string,
  relations: readonly EngineRelationEdge[],
): QueryChainState {
  const candidate = queryChainRelationSwitchCandidates(chain, edge, relations).find(
    (item) => item.relationId === nextRelationId,
  );
  if (!candidate) {
    return chain;
  }
  return replaceQueryChainRelation(chain, edge, candidate, relations);
}

export function reverseQueryChainPrimaryPath(
  chain: QueryChainState,
  relations: readonly EngineRelationEdge[],
): QueryChainState {
  if (!chain.rootModelId || chain.primaryRelationIds.length === 0) {
    return chain;
  }
  const byId = new Map(relations.map((relation) => [relation.id, relation]));
  const primaryModelIds = queryChainPrimaryModelIds(chain, relations);
  const nextRootModelId = primaryModelIds.at(-1) ?? chain.rootModelId;
  let relationUsages = chain.relationUsages;
  const primaryRelationIds = chain.primaryRelationIds
    .slice()
    .reverse()
    .map((relationKey) => {
      const decoded = decodeQueryRelationId(relationKey);
      const relation = byId.get(decoded.relationId);
      const nextDirection: QueryGraphEdgeDirection =
        decoded.direction === 'forward' ? 'reverse' : 'forward';
      const nextRelationKey = encodeQueryRelationId(decoded.relationId, nextDirection);
      const usage = chain.relationUsages?.[relationKey];
      relationUsages = omitRelationUsage(relationUsages, relationKey);
      if (usage && relation && usage.kind !== 'inherited') {
        relationUsages = { ...(relationUsages ?? {}), [nextRelationKey]: usage };
      }
      return nextRelationKey;
    });
  const next: QueryChainState = {
    ...chain,
    rootModelId: nextRootModelId,
    primaryRelationIds,
    relationUsages,
    activeModelId: chain.rootModelId,
  };
  return {
    ...next,
    activeModelId: queryChainTailModelId(next, relations) ?? next.rootModelId,
  };
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
  sourceNodeId?: string,
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

  const graph = queryChainGraphInstances(chain, relations);
  const sourceCandidate = sourceNodeId
    ? allQueryRelationPickCandidates(relation, relations, graph).find(
        (candidate) => candidate.sourceNodeId === sourceNodeId,
      )
    : undefined;
  if (sourceCandidate) {
    const alreadyAdded = graph.edges.some(
      (edge) =>
        edge.relationId === relation.id &&
        edge.direction === sourceCandidate.direction &&
        edge.sourceNodeId === sourceCandidate.sourceNodeId,
    );
    if (alreadyAdded) {
      return { ...chain, activeModelId: sourceCandidate.sourceModelId };
    }
    const primaryTailNodeId = graph.primaryPathNodeIds.at(-1);
    return addTraversalRelation(
      chain,
      relation,
      relations,
      sourceCandidate.direction,
      sourceCandidate.usage,
      sourceCandidate.sourceNodeId === primaryTailNodeId ? undefined : 'branch',
      sourceCandidate.sourceNodeId,
    );
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

  if (
    relation.source_model_id === relation.target_model_id &&
    graphModelIds.has(relation.source_model_id)
  ) {
    const role = chain.primaryRelationIds.length === 0 ? 'primary' : 'branch';
    return addTraversalRelation(chain, relation, relations, direction, usage, role);
  }

  // Parallel relations describe independent result properties. They are not a
  // cycle merely because both endpoint models are already present in the graph.
  // Keep a distinct target instance so each relation remains a sibling in the
  // output contract: A { relationOne: B, relationTwo: B }.
  const parallelTraversal = findParallelTraversalRelation(chain, relation, relations);
  if (parallelTraversal) {
    return addTraversalRelation(
      chain,
      relation,
      relations,
      parallelTraversal.direction,
      parallelTraversal.usage,
      'branch',
    );
  }

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

function allQueryRelationPickCandidates(
  relation: EngineRelationEdge,
  relations: readonly EngineRelationEdge[],
  graph: QueryGraphInstances,
): QueryRelationPickCandidate[] {
  const candidates: QueryRelationPickCandidate[] = [];
  const addCandidate = (
    sourceNodeId: string,
    sourceModelId: string,
    direction: QueryGraphEdgeDirection,
    usage?: QueryGraphRelationUsage,
  ): void => {
    const key = `${sourceNodeId}:${direction}:${usage?.kind === 'inherited' ? usage.inheritRelationId : 'direct'}`;
    if (
      !candidates.some(
        (candidate) =>
          `${candidate.sourceNodeId}:${candidate.direction}:${
            candidate.usage?.kind === 'inherited' ? candidate.usage.inheritRelationId : 'direct'
          }` === key,
      )
    ) {
      candidates.push({ sourceNodeId, sourceModelId, direction, usage });
    }
  };

  for (const node of graph.nodes) {
    if (node.modelId === relation.source_model_id) {
      addCandidate(node.id, node.modelId, 'forward');
    }
    if (node.modelId === relation.target_model_id) {
      addCandidate(node.id, node.modelId, 'reverse');
    }
    const inherited = inheritedRelationCandidate(node.modelId, relation, relations);
    if (inherited) {
      addCandidate(node.id, node.modelId, inherited.direction, inherited.usage);
    }
  }

  return candidates;
}

function findParallelTraversalRelation(
  chain: QueryChainState,
  relation: EngineRelationEdge,
  relations: readonly EngineRelationEdge[],
): { direction: QueryGraphEdgeDirection; usage?: QueryGraphRelationUsage } | undefined {
  const byId = new Map(relations.map((item) => [item.id, item]));
  const candidates: { direction: QueryGraphEdgeDirection; usage?: QueryGraphRelationUsage }[] = [
    { direction: 'forward' },
    { direction: 'reverse' },
  ];
  const inherited = findInheritedRelationUsageFromGraph(chain, relation, relations);
  if (inherited) {
    candidates.unshift(inherited);
  }

  for (const candidate of candidates) {
    const sourceModelId = queryRelationSourceModelId(
      relation,
      candidate.direction,
      candidate.usage,
    );
    const targetModelId = queryRelationTargetModelId(relation, candidate.direction);
    for (const relationKey of queryChainTraversalRelationKeys(chain)) {
      const selected = decodeQueryRelationId(relationKey);
      const selectedRelation = byId.get(selected.relationId);
      if (!selectedRelation) {
        continue;
      }
      const selectedUsage = chain.relationUsages?.[relationKey];
      if (
        queryRelationSourceModelId(selectedRelation, selected.direction, selectedUsage) ===
          sourceModelId &&
        queryRelationTargetModelId(selectedRelation, selected.direction) === targetModelId
      ) {
        return candidate;
      }
    }
  }

  return undefined;
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
  const matches: {
    relation: EngineRelationEdge;
    direction: QueryGraphEdgeDirection;
    usage?: QueryGraphRelationUsage;
  }[] = [];
  for (const relation of relations) {
    if (selectedRelationIds.has(relation.id)) {
      continue;
    }
    if (graphModelIds.has(relation.source_model_id) && relation.target_model_id === toModelId) {
      matches.push({ relation, direction: 'forward' });
    }
    if (graphModelIds.has(relation.target_model_id) && relation.source_model_id === toModelId) {
      matches.push({ relation, direction: 'reverse' });
    }
    for (const graphModelId of graphModelIds) {
      const inherited = inheritedRelationCandidate(graphModelId, relation, relations);
      if (inherited && queryRelationTargetModelId(relation, inherited.direction) === toModelId) {
        matches.push({ relation, direction: inherited.direction, usage: inherited.usage });
      }
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
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
  const matches: { relation: EngineRelationEdge; direction: QueryGraphEdgeDirection }[] = [];
  for (const relation of relations) {
    if (selectedRelationIds.has(relation.id)) {
      continue;
    }
    if (relation.source_model_id === fromModelId && relation.target_model_id === toModelId) {
      matches.push({ relation, direction: 'forward' });
    }
    if (relation.target_model_id === fromModelId && relation.source_model_id === toModelId) {
      matches.push({ relation, direction: 'reverse' });
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function findUniqueBridgeRelation(
  fromModelId: string,
  toModelId: string,
  relations: readonly EngineRelationEdge[],
):
  | {
      relation: EngineRelationEdge;
      direction: QueryGraphEdgeDirection;
      usage?: QueryGraphRelationUsage;
    }
  | undefined {
  const selectedRelationIds = new Set<string>();
  const direct = findRelationStep(fromModelId, toModelId, relations, selectedRelationIds);
  const inherited = findInheritedRelationStep(
    fromModelId,
    toModelId,
    relations,
    selectedRelationIds,
  );
  const matches = [direct, inherited].filter(
    (
      item,
    ): item is {
      relation: EngineRelationEdge;
      direction: QueryGraphEdgeDirection;
      usage?: QueryGraphRelationUsage;
    } => Boolean(item),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function addTraversalRelation(
  chain: QueryChainState,
  relation: EngineRelationEdge,
  relations: readonly EngineRelationEdge[],
  direction: QueryGraphEdgeDirection,
  usage?: QueryGraphRelationUsage,
  roleOverride?: 'primary' | 'branch',
  sourceNodeId?: string,
): QueryChainState {
  const tailModelId = queryChainTailModelId(chain, relations);
  const sourceModelId = queryRelationSourceModelId(relation, direction, usage);
  const targetModelId = queryRelationTargetModelId(relation, direction);
  const relationKey = encodeQueryRelationId(relation.id, direction, sourceNodeId);
  const relationUsages = usage
    ? { ...(chain.relationUsages ?? {}), [relationKey]: usage }
    : chain.relationUsages;
  const isPrimary = roleOverride ? roleOverride === 'primary' : sourceModelId === tailModelId;
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

function removeQueryEdgesByPredicate(
  chain: QueryChainState,
  relations: readonly EngineRelationEdge[],
  shouldRemove: (
    relation: EngineRelationEdge,
    direction: QueryGraphEdgeDirection,
    usage: QueryGraphRelationUsage | undefined,
    relationKey: string,
  ) => boolean,
): QueryChainState {
  const byId = new Map(relations.map((relation) => [relation.id, relation]));
  const removedKeys = new Set<string>();
  const keepKey = (relationKey: string): boolean => {
    const { relationId, direction } = decodeQueryRelationId(relationKey);
    const relation = byId.get(relationId);
    if (!relation) {
      removedKeys.add(relationKey);
      return false;
    }
    const usage = chain.relationUsages?.[relationKey];
    const remove = shouldRemove(relation, direction, usage, relationKey);
    if (remove) {
      removedKeys.add(relationKey);
    }
    return !remove;
  };

  const nextPrimaryRelationIds = chain.primaryRelationIds.filter(keepKey);
  const nextBranchRelationIds = chain.branchRelationIds.filter(keepKey);
  const nextConstraintRelationIds = chain.constraintRelationIds.filter(keepKey);
  let relationUsages = chain.relationUsages;
  for (const relationKey of removedKeys) {
    relationUsages = omitRelationUsage(relationUsages, relationKey);
  }

  return {
    ...chain,
    primaryRelationIds: nextPrimaryRelationIds,
    branchRelationIds: nextBranchRelationIds,
    constraintRelationIds: nextConstraintRelationIds,
    relationUsages,
  };
}

function omitRelationUsage(
  relationUsages: QueryChainState['relationUsages'],
  relationKey: string,
): QueryChainState['relationUsages'] {
  if (!relationUsages || !(relationKey in relationUsages)) {
    return relationUsages;
  }
  const next = { ...relationUsages };
  delete next[relationKey];
  return next;
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
  const matches: {
    relation: EngineRelationEdge;
    direction: QueryGraphEdgeDirection;
    usage: QueryGraphRelationUsage;
  }[] = [];
  for (const relation of relations) {
    if (selectedRelationIds.has(relation.id)) {
      continue;
    }
    const inherited = inheritedRelationCandidate(fromModelId, relation, relations);
    if (!inherited) {
      continue;
    }
    if (queryRelationTargetModelId(relation, inherited.direction) === toModelId) {
      matches.push({ relation, direction: inherited.direction, usage: inherited.usage });
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
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

function appendNonPrimaryInstances(input: {
  chain: QueryChainState;
  relationKeys: readonly string[];
  role: 'branch' | 'constraint';
  relationsById: ReadonlyMap<string, EngineRelationEdge>;
  nodes: QueryGraphNodeInstance[];
  edges: QueryGraphEdgeInstance[];
}): void {
  input.relationKeys.forEach((relationKey, index) => {
    const decoded = decodeQueryRelationId(relationKey);
    const relation = input.relationsById.get(decoded.relationId);
    if (!relation) {
      return;
    }
    const usage = input.chain.relationUsages?.[relationKey];
    const sourceModelId = queryRelationSourceModelId(relation, decoded.direction, usage);
    const targetModelId = queryRelationTargetModelId(relation, decoded.direction);
    const selfRelation = sourceModelId === targetModelId;
    const scopedSourceNode = decoded.sourceNodeId
      ? input.nodes.find(
          (node) => node.id === decoded.sourceNodeId && node.modelId === sourceModelId,
        )
      : undefined;
    const sourceNode =
      scopedSourceNode ??
      (selfRelation ? findFirstQueryNodeByModelId(input.nodes, sourceModelId) : undefined) ??
      findLastQueryNodeByModelId(input.nodes, sourceModelId) ??
      createDetachedQueryNodeInstance(sourceModelId, input.nodes, 'branch');
    if (!input.nodes.includes(sourceNode)) {
      input.nodes.push(sourceNode);
    }
    const existingTargetNode = findLastQueryNodeByModelId(input.nodes, targetModelId);
    const targetNode =
      input.role === 'constraint' && existingTargetNode
        ? existingTargetNode
        : createQueryNodeInstance({
            modelId: targetModelId,
            nodes: input.nodes,
            role: input.role === 'branch' ? 'branch' : 'primary',
            relation,
            direction: decoded.direction,
          });
    if (!input.nodes.includes(targetNode)) {
      input.nodes.push(targetNode);
    }
    input.edges.push({
      id: queryEdgeInstanceId(input.role, relationKey, index),
      key: relationKey,
      relationId: decoded.relationId,
      role: input.role,
      direction: decoded.direction,
      usage,
      sourceNodeId: sourceNode.id,
      targetNodeId: targetNode.id,
    });
  });
}

function createDetachedQueryNodeInstance(
  modelId: string,
  nodes: readonly QueryGraphNodeInstance[],
  role: QueryGraphNodeInstance['role'],
): QueryGraphNodeInstance {
  return {
    id: queryNodeInstanceId(modelId, countQueryNodeInstances(nodes, modelId)),
    modelId,
    alias: aliasForQueryNode(modelId, countQueryNodeInstances(nodes, modelId)),
    role,
  };
}

function createQueryNodeInstance(input: {
  modelId: string;
  nodes: readonly QueryGraphNodeInstance[];
  role: QueryGraphNodeInstance['role'];
  relation: EngineRelationEdge;
  direction: QueryGraphEdgeDirection;
}): QueryGraphNodeInstance {
  const occurrence = countQueryNodeInstances(input.nodes, input.modelId);
  return {
    id: queryNodeInstanceId(input.modelId, occurrence),
    modelId: input.modelId,
    alias:
      occurrence > 0
        ? `${input.modelId}.${relationAlias(input.relation, input.direction)}${
            occurrence > 1 ? `#${occurrence + 1}` : ''
          }`
        : aliasForQueryNode(input.modelId, occurrence),
    role: input.role,
  };
}

function findFirstQueryNodeByModelId(
  nodes: readonly QueryGraphNodeInstance[],
  modelId: string | undefined,
): QueryGraphNodeInstance | undefined {
  if (!modelId) {
    return undefined;
  }
  return nodes.find((node) => node.modelId === modelId);
}

function findLastQueryNodeByModelId(
  nodes: readonly QueryGraphNodeInstance[],
  modelId: string | undefined,
): QueryGraphNodeInstance | undefined {
  if (!modelId) {
    return undefined;
  }
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    if (nodes[index].modelId === modelId) {
      return nodes[index];
    }
  }
  return undefined;
}

function countQueryNodeInstances(
  nodes: readonly QueryGraphNodeInstance[],
  modelId: string,
): number {
  return nodes.filter((node) => node.modelId === modelId).length;
}

function queryNodeInstanceId(modelId: string, occurrence: number): string {
  return `qnode_${stableIdPart(modelId)}_${occurrence}`;
}

function queryEdgeInstanceId(
  role: QueryGraphEdgeRole,
  relationKey: string,
  occurrence: number,
): string {
  return `qedge_${role}_${stableIdPart(relationKey)}_${occurrence}`;
}

function aliasForQueryNode(modelId: string, occurrence: number): string {
  return occurrence === 0 ? modelId : `${modelId}#${occurrence + 1}`;
}

function relationAlias(relation: EngineRelationEdge, direction: QueryGraphEdgeDirection): string {
  if (direction === 'reverse') {
    return relation.reverse_name ?? relation.engine_reverse_name ?? relation.id;
  }
  return relation.forward_name ?? relation.engine_forward_name ?? relation.id;
}

function stableIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

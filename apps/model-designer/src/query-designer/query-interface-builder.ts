import type { EngineModelNode, EngineRelationEdge } from '../types/engine-schema.js';
import type { QueryInterface, QueryProjectionField } from './types.js';
import type {
  QueryGraphEdgeDirection,
  QueryGraphEdgeState,
  QueryGraphRelationUsage,
} from './query-chain-state.js';

const DEFAULT_CREATED_AT = '2026-07-09T00:00:00.000Z';

export interface QueryInterfaceDraftOptions {
  rootModelId: string;
  relationIds?: string[];
  edgeStates?: QueryGraphEdgeState[];
  models: readonly EngineModelNode[];
  relations: readonly EngineRelationEdge[];
  createdAt?: string;
}

export function buildQueryInterfaceDraft(options: QueryInterfaceDraftOptions): QueryInterface {
  const createdAt = options.createdAt ?? DEFAULT_CREATED_AT;
  const edgeStates: QueryGraphEdgeState[] =
    options.edgeStates ??
    (options.relationIds ?? []).map((relationId) => ({
      relationId,
      role: 'primary' as const,
      direction: 'forward' as const,
    }));
  const selectedRelations = collectPathRelations(
    edgeStates.map((edge) => edge.relationId),
    options.relations,
  );
  const nodes = buildNodes(options.rootModelId, selectedRelations, edgeStates, options.models);
  const edgeRoleByRelationId = new Map(edgeStates.map((edge) => [edge.relationId, edge.role]));
  const edges = selectedRelations.map((relation) => {
    const edgeState = edgeStates.find((edge) => edge.relationId === relation.id);
    const role = edgeState?.role ?? 'primary';
    const direction = edgeState?.direction ?? 'forward';
    const fromModelId = sourceModelIdForRelation(relation, direction, edgeState?.usage);
    const toModelId = targetModelIdForRelation(relation, direction);
    return {
      id: `edge_${relation.id}`,
      relationId: relation.id,
      fromNodeId: nodeIdForModel(fromModelId),
      toNodeId: nodeIdForModel(toModelId),
      alias: relation.forward_name ?? relation.engine_forward_name ?? relation.id,
      required: false,
      cardinality: relation.target_cardinality === 'one' ? ('one' as const) : ('many' as const),
      traversal: direction,
      purpose: role === 'constraint' ? ('constraint' as const) : ('traversal' as const),
      traversalRole: role === 'constraint' ? undefined : role,
      inherited:
        edgeState?.usage?.kind === 'inherited'
          ? {
              childModelId: edgeState.usage.childModelId,
              ownerModelId: edgeState.usage.ownerModelId,
              inheritRelationId: edgeState.usage.inheritRelationId,
            }
          : undefined,
    };
  });
  const primaryRelations = selectedRelations.filter(
    (relation) => edgeRoleByRelationId.get(relation.id) === 'primary',
  );
  const branchRelations = selectedRelations.filter(
    (relation) => edgeRoleByRelationId.get(relation.id) === 'branch',
  );
  const projectionFields = buildProjectionFields(
    nodes.map((node) => node.modelId),
    options.models,
  );
  const rootModel = options.models.find((model) => model.id === options.rootModelId);
  const rootName = rootModel?.model_name ?? options.rootModelId;

  return {
    id: `query_${rootName}`,
    kind: 'query',
    name: `${rootName}Query`,
    displayName: `${rootName} Query`,
    status: 'draft',
    version: {
      current: '0.1.0',
      compatibility: 'draft',
    },
    contract: {
      parameters: [],
      output: {
        shape: 'tree',
      },
      errors: [],
      invocation: {
        method: 'query',
        callableName: `${rootName}Query`,
      },
    },
    designGraph: {
      rootNodeId: nodeIdForModel(options.rootModelId),
      nodes,
      edges,
    },
    query: {
      rootNodeId: nodeIdForModel(options.rootModelId),
      traversal: {
        primaryPath: [
          nodeIdForModel(options.rootModelId),
          ...primaryRelations.map((relation) => {
            const edgeState = edgeStates.find((edge) => edge.relationId === relation.id);
            const direction = edgeState?.direction ?? 'forward';
            return nodeIdForModel(targetModelIdForRelation(relation, direction));
          }),
        ],
        branches: branchRelations.map((relation) => ({
          id: `branch_${relation.id}`,
          fromNodeId: nodeIdForModel(sourceModelIdForEdgeState(relation, edgeStates)),
          path: [
            nodeIdForModel(sourceModelIdForEdgeState(relation, edgeStates)),
            nodeIdForModel(
              targetModelIdForRelation(
                relation,
                edgeStates.find((edge) => edge.relationId === relation.id)?.direction ?? 'forward',
              ),
            ),
          ],
          label: relation.forward_name ?? relation.engine_forward_name ?? relation.id,
        })),
      },
      filters: [],
      sorts: [],
      projection: {
        shape: 'tree',
        fields: projectionFields,
      },
      result: {
        shape: 'tree',
        schema: projectionFields.map((field) => ({
          name: field.outputName,
          type: 'string',
          nullable: true,
          source: field.source,
        })),
        includesRecordRefs: true,
      },
      binding: {
        bindable: true,
        writeMode: 'readonly',
        readableNodes: nodes.map((node) => node.id),
        writableNodes: [],
        writableFields: [],
        relationPolicies: [],
        warnings: [
          {
            code: 'query_mvp_readonly',
            message: 'Query Mode MVP only builds readonly query interface drafts.',
          },
        ],
      },
    },
    dependencies: {
      models: nodes.map((node) => node.modelId),
      fields: projectionFields.map((field) => `${field.source.modelId}.${field.source.fieldId}`),
      relations: selectedRelations.map((relation) => relation.id),
    },
    lifecycle: {
      createdAt,
      updatedAt: createdAt,
    },
  };
}

export function outgoingRelationsForModel(
  modelId: string,
  relations: readonly EngineRelationEdge[],
): EngineRelationEdge[] {
  return relations.filter((relation) => relation.source_model_id === modelId);
}

export function nodeIdForModel(modelId: string): string {
  return `node_${modelId}`;
}

function collectPathRelations(
  relationIds: readonly string[],
  relations: readonly EngineRelationEdge[],
): EngineRelationEdge[] {
  const byId = new Map(relations.map((relation) => [relation.id, relation]));
  return relationIds.flatMap((id) => {
    const relation = byId.get(id);
    return relation ? [relation] : [];
  });
}

function buildNodes(
  rootModelId: string,
  relations: readonly EngineRelationEdge[],
  edgeStates: readonly QueryGraphEdgeState[],
  models: readonly EngineModelNode[],
): QueryInterface['designGraph']['nodes'] {
  const modelIds = unique([
    rootModelId,
    ...relations.flatMap((relation) => [
      sourceModelIdForEdgeState(relation, edgeStates),
      targetModelIdForRelation(
        relation,
        edgeStates.find((edge) => edge.relationId === relation.id)?.direction ?? 'forward',
      ),
    ]),
  ]);
  return modelIds.map((modelId) => ({
    id: nodeIdForModel(modelId),
    modelId,
    alias: models.find((model) => model.id === modelId)?.model_name ?? modelId,
    role: modelId === rootModelId ? ('root' as const) : ('joined' as const),
    cardinality: modelId === rootModelId ? undefined : ('many' as const),
  }));
}

function buildProjectionFields(
  modelIds: readonly string[],
  models: readonly EngineModelNode[],
): QueryProjectionField[] {
  const byId = new Map(models.map((model) => [model.id, model]));
  const fields: QueryProjectionField[] = [];

  for (const modelId of modelIds) {
    const model = byId.get(modelId);
    const modelFields = model?.props_objects_array.slice(0, 4) ?? [];
    for (const prop of modelFields) {
      fields.push({
        id: `field_${modelId}_${prop.id}`,
        source: {
          nodeId: nodeIdForModel(modelId),
          modelId,
          fieldId: prop.id,
        },
        outputName: `${model?.model_name ?? modelId}_${prop.name ?? prop.id}`,
        visible: true,
      });
    }
  }

  return fields;
}

function unique<T>(values: readonly T[]): T[] {
  return Array.from(new Set(values));
}

function sourceModelIdForEdgeState(
  relation: EngineRelationEdge,
  edgeStates: readonly QueryGraphEdgeState[],
): string {
  const edgeState = edgeStates.find((edge) => edge.relationId === relation.id);
  return sourceModelIdForRelation(relation, edgeState?.direction ?? 'forward', edgeState?.usage);
}

function sourceModelIdForRelation(
  relation: EngineRelationEdge,
  direction: QueryGraphEdgeDirection,
  usage?: QueryGraphRelationUsage,
): string {
  if (usage?.kind === 'inherited') {
    return usage.childModelId;
  }
  return direction === 'forward' ? relation.source_model_id : relation.target_model_id;
}

function targetModelIdForRelation(
  relation: EngineRelationEdge,
  direction: QueryGraphEdgeDirection,
): string {
  return direction === 'forward' ? relation.target_model_id : relation.source_model_id;
}

import { isInheritRelation } from '../config/graph-edge-kinds.js';
import type { EngineModelNode, EngineRelationEdge } from '../types/engine-schema.js';
import { sortPropsBySort } from '../utils/prop-order.js';
import type {
  InterfaceParameter,
  InterfacePermissionPolicy,
  InterfaceValueType,
  QueryAggregationSpec,
  QueryFilter,
  QueryFilterGroup,
  QueryInterface,
  QueryPagination,
  QueryProjectionField,
  QuerySort,
} from './types.js';
import { cloneQueryFilterGroup, flattenQueryFilterTree } from './query-filter-tree.js';
import { queryGraphOutputNodes } from './query-chain-state.js';
import type {
  QueryGraphEdgeDirection,
  QueryGraphEdgeInstance,
  QueryGraphEdgeState,
  QueryGraphInstances,
  QueryGraphRelationUsage,
} from './query-chain-state.js';

const DEFAULT_CREATED_AT = '2026-07-09T00:00:00.000Z';

export interface QueryInterfaceDraftOptions {
  rootModelId: string;
  relationIds?: string[];
  edgeStates?: QueryGraphEdgeState[];
  models: readonly EngineModelNode[];
  relations: readonly EngineRelationEdge[];
  graphInstances?: QueryGraphInstances;
  projectionFieldKeys?: readonly string[];
  parameters?: readonly InterfaceParameter[];
  filters?: readonly QueryFilter[];
  filterTree?: QueryFilterGroup;
  aggregation?: QueryAggregationSpec;
  sorts?: readonly QuerySort[];
  pagination?: QueryPagination;
  permissions?: InterfacePermissionPolicy;
  createdAt?: string;
}

export function queryProjectionFieldKey(nodeId: string, fieldId: string): string {
  return `${nodeId}:${fieldId}`;
}

export function interfaceValueTypeForPropType(propType: string | undefined): InterfaceValueType {
  switch (propType?.toLowerCase()) {
    case 'number':
    case 'int':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'date':
      return 'date';
    case 'datetime':
      return 'datetime';
    case 'json':
      return 'json';
    default:
      return 'string';
  }
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
  const nodes = options.graphInstances
    ? buildNodesFromInstances(options.graphInstances, options.models)
    : buildNodes(options.rootModelId, selectedRelations, edgeStates, options.models);
  const edges = options.graphInstances
    ? options.graphInstances.edges.flatMap((edge) => {
        const relation = options.relations.find((item) => item.id === edge.relationId);
        if (!relation) {
          return [];
        }
        return [
          buildDesignEdge(relation, edge, edge.sourceNodeId, edge.targetNodeId, `edge_${edge.id}`),
        ];
      })
    : selectedRelations.map((relation) => {
        const edgeState = edgeStates.find((edge) => edge.relationId === relation.id);
        const direction = edgeState?.direction ?? 'forward';
        const fromModelId = sourceModelIdForRelation(relation, direction, edgeState?.usage);
        const toModelId = targetModelIdForRelation(relation, direction);
        return buildDesignEdge(
          relation,
          edgeState,
          nodeIdForModel(fromModelId),
          nodeIdForModel(toModelId),
          `edge_${relation.id}`,
        );
      });
  const primaryRelations = selectedRelations.filter((relation) =>
    edgeStates.some((edge) => edge.relationId === relation.id && edge.role === 'primary'),
  );
  const branchRelations = selectedRelations.filter((relation) =>
    edgeStates.some((edge) => edge.relationId === relation.id && edge.role === 'branch'),
  );
  const projectionNodes = options.graphInstances
    ? queryGraphOutputNodes(options.graphInstances)
    : nodes.map((node) => ({
        id: node.id,
        modelId: node.modelId,
        alias: node.alias,
        role: node.role === 'root' ? ('root' as const) : ('primary' as const),
      }));
  const projectionFields = buildProjectionFields(
    projectionNodes.map((node) => ({ nodeId: node.id, modelId: node.modelId, alias: node.alias })),
    options.models,
    options.projectionFieldKeys,
    options.graphInstances?.rootNodeId ?? nodeIdForModel(options.rootModelId),
  );
  const filterTree = options.filterTree ? cloneQueryFilterGroup(options.filterTree) : undefined;
  const filters = filterTree
    ? flattenQueryFilterTree(filterTree)
    : options.filters
      ? [...options.filters]
      : [];
  const aggregation = cloneQueryAggregation(options.aggregation);
  const aggregationEnabled = Boolean(
    aggregation && (aggregation.groupBy.length > 0 || aggregation.metrics.length > 0),
  );
  const resultSchema = aggregationEnabled
    ? buildAggregationResultSchema(aggregation!, options.models)
    : projectionFields.map((field) => ({
        name: field.outputName,
        type: queryResultFieldType(field, options.models),
        nullable: field.nullable ?? true,
        source: field.source,
      }));
  const resultShape = aggregationEnabled ? ('flat' as const) : ('tree' as const);
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
      parameters: options.parameters ? [...options.parameters] : [],
      output: {
        shape: aggregationEnabled ? 'list' : 'tree',
        schema: aggregationEnabled ? resultSchema : undefined,
      },
      errors: [],
      permissions: options.permissions ?? { mode: 'none' },
      invocation: {
        method: 'query',
        callableName: `${rootName}Query`,
      },
    },
    designGraph: {
      rootNodeId: options.graphInstances?.rootNodeId ?? nodeIdForModel(options.rootModelId),
      nodes,
      edges,
    },
    query: {
      rootNodeId: options.graphInstances?.rootNodeId ?? nodeIdForModel(options.rootModelId),
      traversal: {
        primaryPath: options.graphInstances?.primaryPathNodeIds ?? [
          nodeIdForModel(options.rootModelId),
          ...primaryRelations.map((relation) => {
            const edgeState = edgeStates.find((edge) => edge.relationId === relation.id);
            const direction = edgeState?.direction ?? 'forward';
            return nodeIdForModel(targetModelIdForRelation(relation, direction));
          }),
        ],
        branches: options.graphInstances
          ? options.graphInstances.edges
              .filter((edge) => edge.role === 'branch')
              .map((edge) => {
                const relation = selectedRelations.find((item) => item.id === edge.relationId);
                return {
                  id: `branch_${edge.id}`,
                  fromNodeId: edge.sourceNodeId,
                  path: [edge.sourceNodeId, edge.targetNodeId],
                  label: relation
                    ? (relation.forward_name ?? relation.engine_forward_name ?? relation.id)
                    : edge.relationId,
                };
              })
          : branchRelations.map((relation) => ({
              id: `branch_${relation.id}`,
              fromNodeId: nodeIdForModel(sourceModelIdForEdgeState(relation, edgeStates)),
              path: [
                nodeIdForModel(sourceModelIdForEdgeState(relation, edgeStates)),
                nodeIdForModel(
                  targetModelIdForRelation(
                    relation,
                    edgeStates.find((edge) => edge.relationId === relation.id)?.direction ??
                      'forward',
                  ),
                ),
              ],
              label: relation.forward_name ?? relation.engine_forward_name ?? relation.id,
            })),
      },
      filterTree,
      filters,
      aggregation,
      sorts: options.sorts ? [...options.sorts] : [],
      pagination:
        options.pagination && options.pagination.mode !== 'none'
          ? { ...options.pagination }
          : undefined,
      projection: {
        shape: resultShape,
        fields: projectionFields,
      },
      result: {
        shape: resultShape,
        schema: resultSchema,
        includesRecordRefs: !aggregationEnabled,
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
      models: unique(nodes.map((node) => node.modelId)),
      fields: unique([
        ...projectionFields.map((field) => `${field.source.modelId}.${field.source.fieldId}`),
        ...filters.flatMap((filter) =>
          'fieldId' in filter.target ? [`${filter.target.modelId}.${filter.target.fieldId}`] : [],
        ),
        ...(options.sorts ?? []).flatMap((sort) =>
          'fieldId' in sort.target ? [`${sort.target.modelId}.${sort.target.fieldId}`] : [],
        ),
        ...(aggregation?.groupBy ?? []).map(
          (group) => `${group.source.modelId}.${group.source.fieldId}`,
        ),
        ...(aggregation?.metrics ?? []).map(
          (metric) => `${metric.source.modelId}.${metric.source.fieldId}`,
        ),
      ]),
      relations: unique(selectedRelations.map((relation) => relation.id)),
    },
    lifecycle: {
      createdAt,
      updatedAt: createdAt,
    },
  };
}

function buildDesignEdge(
  relation: EngineRelationEdge,
  edgeState: QueryGraphEdgeState | QueryGraphEdgeInstance | undefined,
  fromNodeId: string,
  toNodeId: string,
  id: string,
): QueryInterface['designGraph']['edges'][number] {
  const role = edgeState?.role ?? 'primary';
  const direction = edgeState?.direction ?? 'forward';
  return {
    id,
    relationId: relation.id,
    fromNodeId,
    toNodeId,
    alias: relationAliasForDirection(relation, direction),
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
}

export function outgoingRelationsForModel(
  modelId: string,
  relations: readonly EngineRelationEdge[],
): EngineRelationEdge[] {
  return relations.filter(
    (relation) => relation.source_model_id === modelId && !isInheritRelation(relation.kind),
  );
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

function buildNodesFromInstances(
  graphInstances: QueryGraphInstances,
  models: readonly EngineModelNode[],
): QueryInterface['designGraph']['nodes'] {
  return graphInstances.nodes.map((node) => ({
    id: node.id,
    modelId: node.modelId,
    alias: modelAliasForInstance(node, models),
    role: node.role === 'root' ? ('root' as const) : ('joined' as const),
    cardinality: node.role === 'root' ? undefined : ('many' as const),
  }));
}

function buildProjectionFields(
  nodes: readonly { nodeId: string; modelId: string; alias: string }[],
  models: readonly EngineModelNode[],
  projectionFieldKeys: readonly string[] | undefined,
  rootNodeId: string,
): QueryProjectionField[] {
  const byId = new Map(models.map((model) => [model.id, model]));
  const selectedFieldKeys = projectionFieldKeys ? new Set(projectionFieldKeys) : undefined;
  const fields: QueryProjectionField[] = [];

  for (const node of nodes) {
    const model = byId.get(node.modelId);
    const modelFields = sortPropsBySort(model?.props_objects_array ?? []);
    for (const prop of modelFields) {
      const fieldKey = queryProjectionFieldKey(node.nodeId, prop.id);
      if (selectedFieldKeys ? !selectedFieldKeys.has(fieldKey) : node.nodeId !== rootNodeId) {
        continue;
      }
      fields.push({
        id: `field_${node.nodeId}_${prop.id}`,
        source: {
          nodeId: node.nodeId,
          modelId: node.modelId,
          fieldId: prop.id,
        },
        outputName: prop.name || prop.id,
        visible: true,
        nullable: !Boolean(prop.is_required),
      });
    }
  }

  return fields;
}

function cloneQueryAggregation(
  aggregation: QueryAggregationSpec | undefined,
): QueryAggregationSpec | undefined {
  if (!aggregation) {
    return undefined;
  }
  return {
    groupBy: aggregation.groupBy.map((group) => ({
      ...group,
      source: { ...group.source },
    })),
    metrics: aggregation.metrics.map((metric) => ({
      ...metric,
      source: { ...metric.source },
    })),
    having: aggregation.having ? cloneQueryFilterGroup(aggregation.having) : undefined,
  };
}

function buildAggregationResultSchema(
  aggregation: QueryAggregationSpec,
  models: readonly EngineModelNode[],
): QueryInterface['query']['result']['schema'] {
  const groups = aggregation.groupBy.map((group) => {
    const model = models.find((item) => item.id === group.source.modelId);
    const prop = model?.props_objects_array.find((item) => item.id === group.source.fieldId);
    return {
      name: group.outputName,
      type: interfaceValueTypeForPropType(prop?.type),
      nullable: !Boolean(prop?.is_required),
      source: group.source,
    };
  });
  const metrics = aggregation.metrics.map((metric) => {
    const model = models.find((item) => item.id === metric.source.modelId);
    const prop = model?.props_objects_array.find((item) => item.id === metric.source.fieldId);
    return {
      name: metric.outputName,
      type:
        metric.function === 'count' || metric.function === 'sum' || metric.function === 'avg'
          ? ('number' as const)
          : interfaceValueTypeForPropType(prop?.type),
      nullable: metric.function !== 'count',
      source: metric.source,
    };
  });
  return [...groups, ...metrics];
}

function queryResultFieldType(
  field: QueryProjectionField,
  models: readonly EngineModelNode[],
): InterfaceValueType {
  const model = models.find((item) => item.id === field.source.modelId);
  const prop = model?.props_objects_array.find((item) => item.id === field.source.fieldId);
  return interfaceValueTypeForPropType(prop?.type);
}

function modelAliasForInstance(
  node: { modelId: string; alias: string; role: 'root' | 'primary' | 'branch' },
  models: readonly EngineModelNode[],
): string {
  const model = models.find((item) => item.id === node.modelId);
  const modelName = model?.model_name ?? node.modelId;
  if (node.role === 'root' || node.alias === node.modelId) {
    return modelName;
  }
  return node.alias.replace(node.modelId, modelName);
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

function relationAliasForDirection(
  relation: EngineRelationEdge,
  direction: QueryGraphEdgeDirection,
): string {
  if (direction === 'reverse') {
    return relation.engine_reverse_name ?? relation.reverse_name ?? relation.id;
  }
  return relation.engine_forward_name ?? relation.forward_name ?? relation.id;
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

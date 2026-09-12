import type {
  DependencyGraph,
  DesignEdge,
  DesignGraph,
  DesignNode,
  EdgeId,
  EngineInterface,
  InterfaceContract,
  NodeId,
  OperationInterface,
  OperationTarget,
  ParameterId,
  QueryFieldRef,
  QueryAggregationSpec,
  QueryFilter,
  QueryFilterGroup,
  QueryInterface,
  QueryMetricRef,
  QueryPagination,
  QueryProjectionField,
  QueryRelationRef,
  QuerySort,
} from './types.js';
import type { EngineModelNode } from '../types/engine-schema.js';
import {
  flattenQueryFilterTree,
  isQueryFilterGroup,
  isQueryRelationFilter,
} from './query-filter-tree.js';

export type QueryDesignerValidationSeverity = 'error' | 'warning';

export interface QueryDesignerValidationIssue {
  severity: QueryDesignerValidationSeverity;
  code: string;
  message: string;
  path?: string;
}

export interface QueryDesignerValidationResult {
  ok: boolean;
  issues: QueryDesignerValidationIssue[];
}

type MutableValidationContext = {
  issues: QueryDesignerValidationIssue[];
};

type GraphIndexes = {
  nodes: Map<NodeId, DesignNode>;
  edges: Map<EdgeId, DesignEdge>;
};

export function validateEngineInterface(
  asset: EngineInterface,
  models?: readonly EngineModelNode[],
): QueryDesignerValidationResult {
  const ctx = createValidationContext();

  validateEngineInterfaceBase(asset, ctx);
  const indexes = validateDesignGraph(asset.designGraph, ctx);
  validateInterfaceContract(asset.contract, ctx);
  validateDependencyGraph(asset.dependencies, asset.designGraph, ctx);

  if (asset.kind === 'query') {
    validateQueryInterface(asset, indexes, ctx);
    if (models) {
      validateQueryInterfaceAgainstModels(asset, models, ctx);
    }
  } else {
    validateOperationInterface(asset, indexes, ctx);
  }

  if (asset.status === 'active') {
    ensureNoWarningsMarkedAsDraft(asset.version.compatibility, ctx);
  }

  return toValidationResult(ctx);
}

export function buildDependencyGraphFromDesignGraph(graph: DesignGraph): DependencyGraph {
  return {
    models: unique(graph.nodes.map((node) => node.modelId)),
    fields: [],
    relations: unique(graph.edges.map((edge) => edge.relationId)),
  };
}

export function fieldDependencyKey(ref: QueryFieldRef): string {
  return `${ref.modelId}.${ref.fieldId}`;
}

function validateEngineInterfaceBase(asset: EngineInterface, ctx: MutableValidationContext): void {
  requireNonEmpty(
    asset.id,
    'asset.id',
    'missing_interface_id',
    'EngineInterface.id is required.',
    ctx,
  );
  requireNonEmpty(
    asset.name,
    'asset.name',
    'missing_interface_name',
    'EngineInterface.name is required.',
    ctx,
  );
  requireNonEmpty(
    asset.version.current,
    'asset.version.current',
    'missing_interface_version',
    'EngineInterface.version.current is required.',
    ctx,
  );

  if (asset.kind === 'query' && asset.contract.invocation.method !== 'query') {
    addIssue(
      ctx,
      'error',
      'invalid_query_invocation',
      'QueryInterface must use query invocation.',
      'contract.invocation.method',
    );
  }

  if (asset.kind === 'operation' && asset.contract.invocation.method !== 'mutation') {
    addIssue(
      ctx,
      'error',
      'invalid_operation_invocation',
      'OperationInterface must use mutation invocation.',
      'contract.invocation.method',
    );
  }
  if (
    asset.contract.permissions?.mode === 'key' &&
    !asset.contract.permissions.accessKeyDigest?.trim()
  ) {
    addIssue(
      ctx,
      'error',
      'missing_interface_access_key',
      'Access-key protected interfaces require a configured key.',
      'contract.permissions.accessKeyDigest',
    );
  }
  const rateLimit = asset.contract.permissions?.rateLimit;
  if (
    rateLimit &&
    (!Number.isInteger(rateLimit.maxRequests) ||
      rateLimit.maxRequests < 1 ||
      rateLimit.maxRequests > 1_000_000)
  ) {
    addIssue(
      ctx,
      'error',
      'invalid_interface_rate_limit_requests',
      'Interface rate-limit requests must be an integer between 1 and 1000000.',
      'contract.permissions.rateLimit.maxRequests',
    );
  }
  if (
    rateLimit &&
    (!Number.isInteger(rateLimit.windowSeconds) ||
      rateLimit.windowSeconds < 1 ||
      rateLimit.windowSeconds > 86_400)
  ) {
    addIssue(
      ctx,
      'error',
      'invalid_interface_rate_limit_window',
      'Interface rate-limit window must be an integer between 1 and 86400 seconds.',
      'contract.permissions.rateLimit.windowSeconds',
    );
  }
}

function validateDesignGraph(graph: DesignGraph, ctx: MutableValidationContext): GraphIndexes {
  const nodes = new Map<NodeId, DesignNode>();
  const edges = new Map<EdgeId, DesignEdge>();
  const rootNodes = graph.nodes.filter((node) => node.role === 'root');

  requireNonEmpty(
    graph.rootNodeId,
    'designGraph.rootNodeId',
    'missing_root_node_id',
    'DesignGraph.rootNodeId is required.',
    ctx,
  );

  for (const node of graph.nodes) {
    if (nodes.has(node.id)) {
      addIssue(
        ctx,
        'error',
        'duplicate_node_id',
        `Duplicate node id "${node.id}".`,
        `designGraph.nodes.${node.id}`,
      );
    }
    nodes.set(node.id, node);
    requireNonEmpty(
      node.modelId,
      `designGraph.nodes.${node.id}.modelId`,
      'missing_node_model',
      'DesignNode.modelId is required.',
      ctx,
    );
    requireNonEmpty(
      node.alias,
      `designGraph.nodes.${node.id}.alias`,
      'missing_node_alias',
      'DesignNode.alias is required.',
      ctx,
    );
  }

  if (!nodes.has(graph.rootNodeId)) {
    addIssue(
      ctx,
      'error',
      'root_node_not_found',
      `Root node "${graph.rootNodeId}" does not exist.`,
      'designGraph.rootNodeId',
    );
  }

  if (rootNodes.length !== 1) {
    addIssue(
      ctx,
      'error',
      'invalid_root_node_count',
      'DesignGraph must have exactly one root node.',
      'designGraph.nodes',
    );
  } else if (rootNodes[0]?.id !== graph.rootNodeId) {
    addIssue(
      ctx,
      'error',
      'root_role_mismatch',
      'The root role node must match DesignGraph.rootNodeId.',
      'designGraph.rootNodeId',
    );
  }

  for (const edge of graph.edges) {
    if (edges.has(edge.id)) {
      addIssue(
        ctx,
        'error',
        'duplicate_edge_id',
        `Duplicate edge id "${edge.id}".`,
        `designGraph.edges.${edge.id}`,
      );
    }
    edges.set(edge.id, edge);
    requireNonEmpty(
      edge.relationId,
      `designGraph.edges.${edge.id}.relationId`,
      'missing_edge_relation',
      'DesignEdge.relationId is required.',
      ctx,
    );
    requireNonEmpty(
      edge.alias,
      `designGraph.edges.${edge.id}.alias`,
      'missing_edge_alias',
      'DesignEdge.alias is required.',
      ctx,
    );

    if (!nodes.has(edge.fromNodeId)) {
      addIssue(
        ctx,
        'error',
        'edge_from_node_not_found',
        `Edge "${edge.id}" fromNodeId does not exist.`,
        `designGraph.edges.${edge.id}.fromNodeId`,
      );
    }
    if (!nodes.has(edge.toNodeId)) {
      addIssue(
        ctx,
        'error',
        'edge_to_node_not_found',
        `Edge "${edge.id}" toNodeId does not exist.`,
        `designGraph.edges.${edge.id}.toNodeId`,
      );
    }
  }

  return { nodes, edges };
}

function validateInterfaceContract(
  contract: InterfaceContract,
  ctx: MutableValidationContext,
): void {
  const parameterIds = new Set<ParameterId>();
  const parameterNames = new Set<string>();

  for (const parameter of contract.parameters) {
    if (parameterIds.has(parameter.id)) {
      addIssue(
        ctx,
        'error',
        'duplicate_parameter_id',
        `Duplicate parameter id "${parameter.id}".`,
        `contract.parameters.${parameter.id}`,
      );
    }
    parameterIds.add(parameter.id);

    if (parameterNames.has(parameter.name)) {
      addIssue(
        ctx,
        'error',
        'duplicate_parameter_name',
        `Duplicate parameter name "${parameter.name}".`,
        `contract.parameters.${parameter.name}`,
      );
    }
    parameterNames.add(parameter.name);

    requireNonEmpty(
      parameter.id,
      'contract.parameters.id',
      'missing_parameter_id',
      'InterfaceParameter.id is required.',
      ctx,
    );
    requireNonEmpty(
      parameter.name,
      `contract.parameters.${parameter.id}.name`,
      'missing_parameter_name',
      'InterfaceParameter.name is required.',
      ctx,
    );
  }
}

function validateQueryInterface(
  asset: QueryInterface,
  indexes: GraphIndexes,
  ctx: MutableValidationContext,
): void {
  const query = asset.query;
  const parameterIds = new Set(asset.contract.parameters.map((parameter) => parameter.id));
  const usedParameterIds = new Set<ParameterId>();
  const filterIds = new Set<string>();

  if (query.rootNodeId !== asset.designGraph.rootNodeId) {
    addIssue(
      ctx,
      'error',
      'query_root_mismatch',
      'QueryInterface rootNodeId must match DesignGraph.rootNodeId.',
      'query.rootNodeId',
    );
  }

  validatePrimaryPath(query.traversal.primaryPath, asset.designGraph.rootNodeId, indexes, ctx);

  for (const branch of query.traversal.branches) {
    if (!indexes.nodes.has(branch.fromNodeId)) {
      addIssue(
        ctx,
        'error',
        'branch_from_node_not_found',
        `Branch "${branch.id}" fromNodeId does not exist.`,
        `query.traversal.branches.${branch.id}.fromNodeId`,
      );
    }
    validateNodePath(branch.path, indexes, `query.traversal.branches.${branch.id}.path`, ctx);
  }

  if (query.filterTree) {
    validateFilterTree(query.filterTree, query.filters, indexes, ctx);
  }

  for (const filter of query.filters) {
    if (filterIds.has(filter.id)) {
      addIssue(
        ctx,
        'error',
        'duplicate_filter_id',
        `Duplicate filter id "${filter.id}".`,
        `query.filters.${filter.id}`,
      );
    }
    filterIds.add(filter.id);
    validateFilter(filter, parameterIds, indexes, ctx);
    if (filter.value?.kind === 'parameter') {
      usedParameterIds.add(filter.value.parameterId);
    }
  }

  if (query.aggregation) {
    validateAggregation(query.aggregation, parameterIds, usedParameterIds, indexes, ctx);
  }

  validateSorts(query.sorts, indexes, query.aggregation, ctx);
  validatePagination(query.pagination, ctx);

  for (const parameter of asset.contract.parameters) {
    if (parameter.required && !usedParameterIds.has(parameter.id)) {
      addIssue(
        ctx,
        'warning',
        'unused_required_parameter',
        `Required parameter "${parameter.name}" is not used by any filter.`,
        `contract.parameters.${parameter.id}`,
      );
    }
  }

  for (const field of query.projection.fields) {
    validateProjectionField(field, indexes, ctx);
  }

  if (query.result.shape !== query.projection.shape) {
    addIssue(
      ctx,
      'error',
      'result_projection_shape_mismatch',
      'QueryResultContract.shape must match QueryProjection.shape.',
      'query.result.shape',
    );
  }

  validateBindingCapability(asset, indexes, ctx);
}

function validateOperationInterface(
  asset: OperationInterface,
  indexes: GraphIndexes,
  ctx: MutableValidationContext,
): void {
  const parameterIds = new Set(asset.contract.parameters.map((parameter) => parameter.id));
  const declaredOperationType = asset.operation.operationType;
  const operationType =
    declaredOperationType === 'batch'
      ? asset.operation.batch?.itemOperationType
      : declaredOperationType;
  const recordOperation = Boolean(
    operationType && ['create', 'update', 'delete', 'upsert'].includes(operationType),
  );
  const relationOperation = Boolean(
    operationType && ['bind', 'unbind', 'rebind'].includes(operationType),
  );
  const identityMappings = asset.operation.inputMapping.filter(
    (mapping) =>
      mapping.mode === 'lookup' &&
      isOperationTargetValue(mapping.target) &&
      sameOperationTarget(mapping.target, asset.operation.target),
  );
  const fieldMappings = asset.operation.inputMapping.filter(
    (mapping) => mapping.mode === 'set' && isFieldRef(mapping.target),
  );
  const upsertMatchMappings = asset.operation.inputMapping.filter(
    (mapping) => mapping.mode === 'lookup' && isFieldRef(mapping.target),
  );

  if (declaredOperationType === 'batch') {
    if (!asset.operation.batch) {
      addIssue(
        ctx,
        'error',
        'operation_batch_spec_required',
        'Batch operations require an item operation type and maximum item count.',
        'operation.batch',
      );
    } else if (
      !Number.isInteger(asset.operation.batch.maxItems) ||
      asset.operation.batch.maxItems < 1 ||
      asset.operation.batch.maxItems > 1000
    ) {
      addIssue(
        ctx,
        'error',
        'operation_batch_limit_invalid',
        'Batch maximum item count must be an integer between 1 and 1000.',
        'operation.batch.maxItems',
      );
    }
    if (
      asset.operation.transactionPolicy.mode !== 'batch' ||
      asset.operation.transactionPolicy.rollbackOnFailure
    ) {
      addIssue(
        ctx,
        'error',
        'operation_batch_transaction_unsupported',
        'Batch operations are non-atomic; cross-item rollback is not supported.',
        'operation.transactionPolicy',
      );
    }
    if (!['continue', 'stop'].includes(asset.operation.transactionPolicy.failureMode ?? '')) {
      addIssue(
        ctx,
        'error',
        'operation_batch_failure_mode_required',
        'Batch operations require an explicit continue or stop failure mode.',
        'operation.transactionPolicy.failureMode',
      );
    }
    if (asset.operation.result.returns !== 'summary') {
      addIssue(
        ctx,
        'error',
        'operation_batch_result_invalid',
        'Batch operations return the stable batch summary contract.',
        'operation.result.returns',
      );
    }
  } else if (asset.operation.batch) {
    addIssue(
      ctx,
      'error',
      'operation_batch_spec_not_allowed',
      'Only batch operations can define batch settings.',
      'operation.batch',
    );
  }

  validateOperationTarget(asset.operation.target, indexes, 'operation.target', ctx);

  if (
    recordOperation &&
    asset.operation.target.kind !== 'model' &&
    asset.operation.target.kind !== 'node'
  ) {
    addIssue(
      ctx,
      'error',
      'operation_record_target_invalid',
      'Create, update, delete and upsert operations require a model or node target.',
      'operation.target',
    );
  }
  if (
    relationOperation &&
    asset.operation.target.kind !== 'relation' &&
    asset.operation.target.kind !== 'edge'
  ) {
    addIssue(
      ctx,
      'error',
      'operation_relation_target_invalid',
      'Bind, unbind and rebind operations require a relation or edge target.',
      'operation.target',
    );
  }

  for (const mapping of asset.operation.inputMapping) {
    if (!parameterIds.has(mapping.parameterId)) {
      addIssue(
        ctx,
        'error',
        'operation_mapping_parameter_not_found',
        `Operation input mapping references missing parameter "${mapping.parameterId}".`,
        `operation.inputMapping.${mapping.parameterId}`,
      );
    }
    validateOperationMappingTarget(
      mapping.target,
      indexes,
      `operation.inputMapping.${mapping.parameterId}.target`,
      ctx,
    );
    if (
      recordOperation &&
      !(
        (mapping.mode === 'set' && isFieldRef(mapping.target)) ||
        (mapping.mode === 'lookup' && isOperationTargetValue(mapping.target)) ||
        (operationType === 'upsert' && mapping.mode === 'lookup' && isFieldRef(mapping.target))
      )
    ) {
      addIssue(
        ctx,
        'error',
        'operation_record_mapping_invalid',
        'Record operations support field set mappings and a target identity lookup.',
        `operation.inputMapping.${mapping.parameterId}`,
      );
    }
    if (relationOperation) {
      const expectedMode =
        mapping.role === 'relationPreviousTarget'
          ? 'disconnect'
          : mapping.role === 'relationNextTarget'
            ? 'connect'
            : operationType === 'unbind'
              ? 'disconnect'
              : mapping.role === 'relationSource' && operationType === 'rebind'
                ? 'lookup'
                : 'connect';
      if (
        !mapping.role ||
        mapping.role === 'recordIdentity' ||
        !isOperationTargetValue(mapping.target) ||
        !sameOperationTarget(mapping.target, asset.operation.target) ||
        mapping.mode !== expectedMode
      ) {
        addIssue(
          ctx,
          'error',
          'operation_relation_mapping_invalid',
          'Relationship mappings require an explicit endpoint role, the selected relation target, and the matching connect/disconnect mode.',
          `operation.inputMapping.${mapping.parameterId}`,
        );
      }
    }
  }

  if ((operationType === 'update' || operationType === 'delete') && identityMappings.length !== 1) {
    addIssue(
      ctx,
      'error',
      'operation_identity_mapping_required',
      'Update and delete operations require exactly one identity lookup for their target.',
      'operation.inputMapping',
    );
  }
  if (operationType === 'create' && identityMappings.length > 0) {
    addIssue(
      ctx,
      'error',
      'operation_create_identity_not_allowed',
      'Create operations cannot provide an existing target identity.',
      'operation.inputMapping',
    );
  }
  if (operationType === 'upsert' && identityMappings.length > 0) {
    addIssue(
      ctx,
      'error',
      'operation_upsert_identity_not_allowed',
      'Upsert operations identify records through match fields, not a record identity mapping.',
      'operation.inputMapping',
    );
  }
  if (operationType === 'update' && fieldMappings.length === 0) {
    addIssue(
      ctx,
      'error',
      'operation_update_fields_required',
      'Update operations require at least one field set mapping.',
      'operation.inputMapping',
    );
  }
  if (operationType === 'delete' && fieldMappings.length > 0) {
    addIssue(
      ctx,
      'error',
      'operation_delete_fields_not_allowed',
      'Delete operations cannot contain field set mappings.',
      'operation.inputMapping',
    );
  }
  if (operationType === 'upsert') {
    if (fieldMappings.length === 0) {
      addIssue(
        ctx,
        'error',
        'operation_upsert_fields_required',
        'Upsert operations require at least one field set mapping.',
        'operation.inputMapping',
      );
    }
    if (upsertMatchMappings.length === 0) {
      addIssue(
        ctx,
        'error',
        'operation_upsert_match_required',
        'Upsert operations require at least one match field lookup.',
        'operation.inputMapping',
      );
    }
    for (const match of upsertMatchMappings) {
      if (!isFieldRef(match.target)) {
        continue;
      }
      const matchTarget = match.target;
      if (
        !fieldMappings.some(
          (mapping) =>
            mapping.parameterId === match.parameterId &&
            isFieldRef(mapping.target) &&
            mapping.target.nodeId === matchTarget.nodeId &&
            mapping.target.modelId === matchTarget.modelId &&
            mapping.target.fieldId === matchTarget.fieldId,
        )
      ) {
        addIssue(
          ctx,
          'error',
          'operation_upsert_match_not_set',
          'Every upsert match field must use the same parameter as a field set mapping.',
          `operation.inputMapping.${match.parameterId}`,
        );
      }
    }
  }
  if (
    declaredOperationType !== 'batch' &&
    recordOperation &&
    asset.operation.transactionPolicy.mode === 'batch'
  ) {
    addIssue(
      ctx,
      'error',
      'operation_record_transaction_invalid',
      'Single-record operations cannot use the batch transaction mode.',
      'operation.transactionPolicy.mode',
    );
  }
  if (relationOperation) {
    const requiredRoles =
      operationType === 'rebind'
        ? ['relationSource', 'relationPreviousTarget', 'relationNextTarget']
        : ['relationSource', 'relationTarget'];
    for (const role of requiredRoles) {
      const count = asset.operation.inputMapping.filter((mapping) => mapping.role === role).length;
      if (count !== 1) {
        addIssue(
          ctx,
          'error',
          'operation_relation_role_required',
          `Relationship operation requires exactly one "${role}" mapping.`,
          'operation.inputMapping',
        );
      }
    }
    if (!['summary', 'none'].includes(asset.operation.result.returns)) {
      addIssue(
        ctx,
        'error',
        'operation_relation_result_invalid',
        'Relationship operations can return only summary or none.',
        'operation.result.returns',
      );
    }
    if (declaredOperationType !== 'batch' && asset.operation.transactionPolicy.mode !== 'single') {
      addIssue(
        ctx,
        'error',
        'operation_relation_transaction_invalid',
        'Single-pair relationship operations require the single transaction mode.',
        'operation.transactionPolicy.mode',
      );
    }
  }
}

function validateDependencyGraph(
  dependencies: DependencyGraph,
  graph: DesignGraph,
  ctx: MutableValidationContext,
): void {
  for (const modelId of unique(graph.nodes.map((node) => node.modelId))) {
    if (!dependencies.models.includes(modelId)) {
      addIssue(
        ctx,
        'warning',
        'dependency_model_missing',
        `DependencyGraph is missing model "${modelId}".`,
        'dependencies.models',
      );
    }
  }

  for (const relationId of unique(graph.edges.map((edge) => edge.relationId))) {
    if (!dependencies.relations.includes(relationId)) {
      addIssue(
        ctx,
        'warning',
        'dependency_relation_missing',
        `DependencyGraph is missing relation "${relationId}".`,
        'dependencies.relations',
      );
    }
  }
}

function validatePrimaryPath(
  path: NodeId[],
  rootNodeId: NodeId,
  indexes: GraphIndexes,
  ctx: MutableValidationContext,
): void {
  if (path.length === 0) {
    addIssue(
      ctx,
      'error',
      'empty_primary_path',
      'QueryTraversalSpec.primaryPath cannot be empty.',
      'query.traversal.primaryPath',
    );
    return;
  }

  if (path[0] !== rootNodeId) {
    addIssue(
      ctx,
      'error',
      'primary_path_root_mismatch',
      'Primary path must start from rootNodeId.',
      'query.traversal.primaryPath',
    );
  }

  validateNodePath(path, indexes, 'query.traversal.primaryPath', ctx);
}

function validateNodePath(
  path: NodeId[],
  indexes: GraphIndexes,
  pathLabel: string,
  ctx: MutableValidationContext,
): void {
  for (const nodeId of path) {
    if (!indexes.nodes.has(nodeId)) {
      addIssue(
        ctx,
        'error',
        'path_node_not_found',
        `Path references missing node "${nodeId}".`,
        pathLabel,
      );
    }
  }

  for (let i = 0; i < path.length - 1; i += 1) {
    if (!hasEdgeBetween(path[i] ?? '', path[i + 1] ?? '', indexes.edges)) {
      addIssue(
        ctx,
        'warning',
        'path_nodes_not_adjacent',
        `Path nodes "${path[i]}" and "${path[i + 1]}" are not connected by an edge.`,
        pathLabel,
      );
    }
  }
}

function validateAggregation(
  aggregation: QueryAggregationSpec,
  parameterIds: ReadonlySet<ParameterId>,
  usedParameterIds: Set<ParameterId>,
  indexes: GraphIndexes,
  ctx: MutableValidationContext,
): void {
  const ids = new Set<string>();
  const outputNames = new Set<string>();
  const groupTargets = new Set<string>();
  for (const group of aggregation.groupBy) {
    if (ids.has(group.id)) {
      addIssue(
        ctx,
        'error',
        'duplicate_group_field_id',
        `Duplicate group field id "${group.id}".`,
        `query.aggregation.groupBy.${group.id}`,
      );
    }
    ids.add(group.id);
    validateFieldRef(group.source, indexes, `query.aggregation.groupBy.${group.id}.source`, ctx);
    const targetKey = `${group.source.nodeId}:${group.source.fieldId}`;
    if (groupTargets.has(targetKey)) {
      addIssue(
        ctx,
        'error',
        'duplicate_group_field',
        `Field "${targetKey}" is grouped more than once.`,
        `query.aggregation.groupBy.${group.id}`,
      );
    }
    groupTargets.add(targetKey);
    validateAggregationOutputName(group.outputName, group.id, outputNames, ctx);
  }

  const metricsById = new Map(aggregation.metrics.map((metric) => [metric.id, metric]));
  for (const metric of aggregation.metrics) {
    if (ids.has(metric.id)) {
      addIssue(
        ctx,
        'error',
        'duplicate_metric_id',
        `Duplicate aggregation id "${metric.id}".`,
        `query.aggregation.metrics.${metric.id}`,
      );
    }
    ids.add(metric.id);
    validateFieldRef(metric.source, indexes, `query.aggregation.metrics.${metric.id}.source`, ctx);
    validateAggregationOutputName(metric.outputName, metric.id, outputNames, ctx);
  }

  if (!aggregation.having) {
    return;
  }
  const havingIds = new Set<string>();
  const visit = (group: QueryFilterGroup, depth: number): void => {
    if (depth > 8) {
      addIssue(
        ctx,
        'error',
        'having_depth_exceeded',
        'HAVING groups cannot be nested more than 8 levels.',
        `query.aggregation.having.${group.id}`,
      );
      return;
    }
    for (const child of group.children) {
      if (isQueryFilterGroup(child)) {
        visit(child, depth + 1);
        continue;
      }
      if (isQueryRelationFilter(child)) {
        addIssue(
          ctx,
          'error',
          'relation_filter_not_allowed_in_having',
          'Relation filters are not allowed in HAVING.',
          `query.aggregation.having.${child.id}`,
        );
        continue;
      }
      if (havingIds.has(child.id)) {
        addIssue(
          ctx,
          'error',
          'duplicate_having_filter_id',
          `Duplicate HAVING filter id "${child.id}".`,
          `query.aggregation.having.${child.id}`,
        );
      }
      havingIds.add(child.id);
      const path = `query.aggregation.having.${child.id}`;
      if (!isMetricRef(child.target)) {
        addIssue(
          ctx,
          'error',
          'having_metric_required',
          `HAVING filter "${child.id}" must target an aggregation metric.`,
          `${path}.target`,
        );
      } else if (!metricsById.has(child.target.metricId)) {
        addIssue(
          ctx,
          'error',
          'having_metric_not_found',
          `HAVING filter "${child.id}" references missing metric "${child.target.metricId}".`,
          `${path}.target`,
        );
      }
      const requiresValue = child.operator !== 'isNull' && child.operator !== 'isNotNull';
      if (requiresValue && !child.value) {
        addIssue(
          ctx,
          'error',
          'having_value_required',
          `HAVING filter "${child.id}" requires a value.`,
          `${path}.value`,
        );
      }
      if (child.value?.kind === 'parameter') {
        usedParameterIds.add(child.value.parameterId);
        if (!parameterIds.has(child.value.parameterId)) {
          addIssue(
            ctx,
            'error',
            'having_parameter_not_found',
            `HAVING filter "${child.id}" references missing parameter "${child.value.parameterId}".`,
            `${path}.value`,
          );
        }
      }
    }
  };
  visit(aggregation.having, 0);
}

function validateAggregationOutputName(
  outputName: string,
  id: string,
  outputNames: Set<string>,
  ctx: MutableValidationContext,
): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(outputName)) {
    addIssue(
      ctx,
      'error',
      'invalid_aggregation_output_name',
      `Aggregation output name "${outputName}" must be an English identifier.`,
      `query.aggregation.${id}.outputName`,
    );
    return;
  }
  if (outputNames.has(outputName)) {
    addIssue(
      ctx,
      'error',
      'duplicate_aggregation_output_name',
      `Aggregation output name "${outputName}" is duplicated.`,
      `query.aggregation.${id}.outputName`,
    );
  }
  outputNames.add(outputName);
}

function validateFilterTree(
  root: QueryFilterGroup,
  filters: readonly QueryFilter[],
  indexes: GraphIndexes,
  ctx: MutableValidationContext,
): void {
  const groupIds = new Set<string>();
  const relationFilterIds = new Set<string>();
  const visit = (group: QueryFilterGroup, depth: number, allowEmpty = false): void => {
    if (groupIds.has(group.id)) {
      addIssue(
        ctx,
        'error',
        'duplicate_filter_group_id',
        `Duplicate filter group id "${group.id}".`,
        `query.filterTree.${group.id}`,
      );
      return;
    }
    groupIds.add(group.id);
    if (depth > 8) {
      addIssue(
        ctx,
        'error',
        'filter_group_depth_exceeded',
        'Filter groups cannot be nested more than 8 levels.',
        `query.filterTree.${group.id}`,
      );
      return;
    }
    if (depth > 0 && group.children.length === 0 && !allowEmpty) {
      addIssue(
        ctx,
        'warning',
        'empty_filter_group',
        `Filter group "${group.id}" is empty.`,
        `query.filterTree.${group.id}`,
      );
    }
    for (const child of group.children) {
      if (isQueryFilterGroup(child)) {
        visit(child, depth + 1);
      } else if (isQueryRelationFilter(child)) {
        const path = `query.filterTree.${child.id}`;
        if (relationFilterIds.has(child.id)) {
          addIssue(
            ctx,
            'error',
            'duplicate_relation_filter_id',
            `Duplicate relation filter id "${child.id}".`,
            path,
          );
          continue;
        }
        relationFilterIds.add(child.id);
        validateQueryTarget(child.target, indexes, `${path}.target`, ctx);
        const edge = indexes.edges.get(child.target.edgeId);
        if (
          edge &&
          (edge.fromNodeId !== child.sourceNodeId || edge.toNodeId !== child.targetNodeId)
        ) {
          addIssue(
            ctx,
            'error',
            'relation_filter_scope_mismatch',
            `Relation filter "${child.id}" node scope does not match its design edge.`,
            path,
          );
        }
        validateRelationConditionScope(child.condition, child.targetNodeId, path, ctx);
        visit(child.condition, depth + 1, true);
      }
    }
  };
  visit(root, 0);

  const treeFilterIds = flattenQueryFilterTree(root).map((filter) => filter.id);
  const flatFilterIds = filters.map((filter) => filter.id);
  if (
    treeFilterIds.length !== flatFilterIds.length ||
    treeFilterIds.some((id, index) => id !== flatFilterIds[index])
  ) {
    addIssue(
      ctx,
      'error',
      'filter_tree_flat_mismatch',
      'Filter tree predicates must match the compatibility filters list.',
      'query.filterTree',
    );
  }
}

function validateRelationConditionScope(
  group: QueryFilterGroup,
  expectedNodeId: NodeId,
  path: string,
  ctx: MutableValidationContext,
): void {
  for (const child of group.children) {
    if (isQueryFilterGroup(child)) {
      validateRelationConditionScope(child, expectedNodeId, path, ctx);
      continue;
    }
    if (isQueryRelationFilter(child)) {
      if (child.sourceNodeId !== expectedNodeId) {
        addIssue(
          ctx,
          'error',
          'nested_relation_filter_source_mismatch',
          `Nested relation filter "${child.id}" must start from node "${expectedNodeId}".`,
          `${path}.${child.id}`,
        );
      }
      continue;
    }
    if (isFieldRef(child.target) && child.target.nodeId !== expectedNodeId) {
      addIssue(
        ctx,
        'error',
        'relation_filter_field_scope_mismatch',
        `Filter "${child.id}" must target relation node "${expectedNodeId}".`,
        `${path}.${child.id}`,
      );
    }
  }
}

function validateFilter(
  filter: QueryFilter,
  parameterIds: ReadonlySet<ParameterId>,
  indexes: GraphIndexes,
  ctx: MutableValidationContext,
): void {
  validateQueryTarget(filter.target, indexes, `query.filters.${filter.id}.target`, ctx);

  const requiresValue = filter.operator !== 'isNull' && filter.operator !== 'isNotNull';
  if (requiresValue && !filter.value) {
    addIssue(
      ctx,
      'error',
      'filter_value_required',
      `Filter "${filter.id}" requires a value for operator "${filter.operator}".`,
      `query.filters.${filter.id}.value`,
    );
  }
  if (!requiresValue && filter.value) {
    addIssue(
      ctx,
      'warning',
      'filter_value_ignored',
      `Filter "${filter.id}" ignores values for operator "${filter.operator}".`,
      `query.filters.${filter.id}.value`,
    );
  }

  if (filter.value?.kind === 'parameter' && !parameterIds.has(filter.value.parameterId)) {
    addIssue(
      ctx,
      'error',
      'filter_parameter_not_found',
      `Filter "${filter.id}" references missing parameter "${filter.value.parameterId}".`,
      `query.filters.${filter.id}.value`,
    );
  }
}

function validateSorts(
  sorts: readonly QuerySort[],
  indexes: GraphIndexes,
  aggregation: QueryAggregationSpec | undefined,
  ctx: MutableValidationContext,
): void {
  const sortIds = new Set<string>();
  const priorities = new Set<number>();
  const targets = new Set<string>();
  for (const sort of sorts) {
    if (sortIds.has(sort.id)) {
      addIssue(
        ctx,
        'error',
        'duplicate_sort_id',
        `Duplicate sort id "${sort.id}".`,
        `query.sorts.${sort.id}`,
      );
    }
    sortIds.add(sort.id);
    let targetKey: string;
    const target = sort.target;
    if (isMetricRef(target)) {
      targetKey = `metric:${target.metricId}`;
      if (!aggregation?.metrics.some((metric) => metric.id === target.metricId)) {
        addIssue(
          ctx,
          'error',
          'sort_metric_not_found',
          `Sort references missing metric "${target.metricId}".`,
          `query.sorts.${sort.id}.target`,
        );
      }
    } else {
      validateFieldRef(target, indexes, `query.sorts.${sort.id}.target`, ctx);
      targetKey = `${target.nodeId}:${target.fieldId}`;
    }
    if (targets.has(targetKey)) {
      addIssue(
        ctx,
        'warning',
        'duplicate_sort_target',
        `Field "${targetKey}" is sorted more than once.`,
        `query.sorts.${sort.id}.target`,
      );
    }
    targets.add(targetKey);
    if (!Number.isInteger(sort.priority) || sort.priority < 0) {
      addIssue(
        ctx,
        'error',
        'invalid_sort_priority',
        `Sort "${sort.id}" priority must be a non-negative integer.`,
        `query.sorts.${sort.id}.priority`,
      );
    } else if (priorities.has(sort.priority)) {
      addIssue(
        ctx,
        'warning',
        'duplicate_sort_priority',
        `Sort priority "${sort.priority}" is used more than once.`,
        `query.sorts.${sort.id}.priority`,
      );
    }
    priorities.add(sort.priority);
  }
}

function validatePagination(
  pagination: QueryPagination | undefined,
  ctx: MutableValidationContext,
): void {
  if (!pagination || pagination.mode === 'none') {
    return;
  }
  const validateLimit = (value: number | undefined, path: string, label: string): void => {
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
      addIssue(
        ctx,
        'error',
        'invalid_pagination_limit',
        `${label} must be a positive integer.`,
        path,
      );
    }
  };
  validateLimit(pagination.defaultLimit, 'query.pagination.defaultLimit', 'Default limit');
  validateLimit(pagination.maxLimit, 'query.pagination.maxLimit', 'Maximum limit');
  if (
    pagination.defaultLimit !== undefined &&
    pagination.maxLimit !== undefined &&
    pagination.defaultLimit > pagination.maxLimit
  ) {
    addIssue(
      ctx,
      'error',
      'pagination_default_exceeds_maximum',
      'Default pagination limit cannot exceed maximum limit.',
      'query.pagination',
    );
  }
}

function validateQueryInterfaceAgainstModels(
  asset: QueryInterface,
  models: readonly EngineModelNode[],
  ctx: MutableValidationContext,
): void {
  const modelsById = new Map(models.map((model) => [model.id, model]));
  const validateField = (
    ref: QueryFieldRef,
    path: string,
  ): EngineModelNode['props_objects_array'][number] | undefined => {
    const model = modelsById.get(ref.modelId);
    if (!model) {
      addIssue(
        ctx,
        'warning',
        'dependency_model_drift',
        `Model "${ref.modelId}" is no longer available in the current catalog.`,
        path,
      );
      return undefined;
    }
    const prop = model.props_objects_array.find((item) => item.id === ref.fieldId);
    if (!prop) {
      addIssue(
        ctx,
        'warning',
        'dependency_field_drift',
        `Field "${ref.fieldId}" is no longer available on model "${ref.modelId}".`,
        path,
      );
    }
    return prop;
  };

  for (const filter of asset.query.filters) {
    if (!isFieldRef(filter.target)) {
      continue;
    }
    const prop = validateField(filter.target, `query.filters.${filter.id}.target`);
    if (prop && !isFilterOperatorCompatible(prop.type, filter.operator)) {
      addIssue(
        ctx,
        'error',
        'filter_operator_type_mismatch',
        `Operator "${filter.operator}" is not compatible with field type "${prop.type}".`,
        `query.filters.${filter.id}.operator`,
      );
    }
  }

  const aggregation = asset.query.aggregation;
  if (aggregation) {
    for (const group of aggregation.groupBy) {
      validateField(group.source, `query.aggregation.groupBy.${group.id}.source`);
    }
    const metricTypes = new Map<string, string>();
    for (const metric of aggregation.metrics) {
      const prop = validateField(metric.source, `query.aggregation.metrics.${metric.id}.source`);
      const normalizedType = prop?.type?.toLowerCase() ?? 'string';
      if (
        (metric.function === 'sum' || metric.function === 'avg') &&
        !['number', 'int'].includes(normalizedType)
      ) {
        addIssue(
          ctx,
          'error',
          'aggregation_function_type_mismatch',
          `Aggregation function "${metric.function}" requires a numeric field.`,
          `query.aggregation.metrics.${metric.id}.function`,
        );
      }
      metricTypes.set(
        metric.id,
        ['count', 'sum', 'avg'].includes(metric.function) ? 'number' : normalizedType,
      );
    }
    if (aggregation.having) {
      for (const filter of flattenQueryFilterTree(aggregation.having)) {
        if (!isMetricRef(filter.target)) {
          continue;
        }
        const type = metricTypes.get(filter.target.metricId);
        if (type && !isFilterOperatorCompatible(type, filter.operator)) {
          addIssue(
            ctx,
            'error',
            'having_operator_type_mismatch',
            `Operator "${filter.operator}" is not compatible with metric type "${type}".`,
            `query.aggregation.having.${filter.id}.operator`,
          );
        }
      }
    }
  }

  for (const sort of asset.query.sorts) {
    if (isFieldRef(sort.target)) {
      validateField(sort.target, `query.sorts.${sort.id}.target`);
    }
  }
  for (const field of asset.query.projection.fields) {
    validateField(field.source, `query.projection.fields.${field.id}.source`);
  }
}

function isFilterOperatorCompatible(
  type: string | undefined,
  operator: QueryFilter['operator'],
): boolean {
  const normalized = type?.toLowerCase() ?? 'string';
  const nullOperators = ['isNull', 'isNotNull'];
  if (nullOperators.includes(operator)) {
    return true;
  }
  if (normalized === 'boolean') {
    return operator === 'eq' || operator === 'neq';
  }
  if (['number', 'int', 'date', 'datetime'].includes(normalized)) {
    return ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'notIn'].includes(operator);
  }
  if (normalized === 'json') {
    return ['eq', 'neq', 'contains', 'in', 'notIn'].includes(operator);
  }
  return ['eq', 'neq', 'contains', 'startsWith', 'endsWith', 'in', 'notIn'].includes(operator);
}

function validateProjectionField(
  field: QueryProjectionField,
  indexes: GraphIndexes,
  ctx: MutableValidationContext,
): void {
  requireNonEmpty(
    field.outputName,
    `query.projection.fields.${field.id}.outputName`,
    'missing_projection_output_name',
    'Projection outputName is required.',
    ctx,
  );
  validateFieldRef(field.source, indexes, `query.projection.fields.${field.id}.source`, ctx);
}

function validateBindingCapability(
  asset: QueryInterface,
  indexes: GraphIndexes,
  ctx: MutableValidationContext,
): void {
  const binding = asset.query.binding;

  if (!binding) {
    return;
  }

  for (const nodeId of [...binding.readableNodes, ...binding.writableNodes]) {
    if (!indexes.nodes.has(nodeId)) {
      addIssue(
        ctx,
        'error',
        'binding_node_not_found',
        `BindingCapability references missing node "${nodeId}".`,
        'query.binding',
      );
    }
  }

  for (const field of binding.writableFields) {
    validateFieldRef(field.field, indexes, 'query.binding.writableFields', ctx);
  }

  for (const policy of binding.relationPolicies) {
    validateRelationRef(policy.relation, indexes, 'query.binding.relationPolicies', ctx);
  }
}

function validateQueryTarget(
  target: QueryFieldRef | QueryRelationRef | QueryMetricRef,
  indexes: GraphIndexes,
  path: string,
  ctx: MutableValidationContext,
): void {
  if (isFieldRef(target)) {
    validateFieldRef(target, indexes, path, ctx);
  } else if (isRelationRef(target)) {
    validateRelationRef(target, indexes, path, ctx);
  } else {
    addIssue(
      ctx,
      'error',
      'metric_ref_not_allowed_in_row_filter',
      'Metric references are only allowed in aggregation HAVING filters.',
      path,
    );
  }
}

function validateFieldRef(
  ref: QueryFieldRef,
  indexes: GraphIndexes,
  path: string,
  ctx: MutableValidationContext,
): void {
  const node = indexes.nodes.get(ref.nodeId);

  if (!node) {
    addIssue(
      ctx,
      'error',
      'field_ref_node_not_found',
      `FieldRef node "${ref.nodeId}" does not exist.`,
      path,
    );
    return;
  }

  if (node.modelId !== ref.modelId) {
    addIssue(
      ctx,
      'error',
      'field_ref_model_mismatch',
      `FieldRef model "${ref.modelId}" does not match node model "${node.modelId}".`,
      path,
    );
  }

  requireNonEmpty(
    ref.fieldId,
    `${path}.fieldId`,
    'missing_field_ref_field',
    'FieldRef.fieldId is required.',
    ctx,
  );
}

function validateRelationRef(
  ref: QueryRelationRef,
  indexes: GraphIndexes,
  path: string,
  ctx: MutableValidationContext,
): void {
  const edge = indexes.edges.get(ref.edgeId);

  if (!edge) {
    addIssue(
      ctx,
      'error',
      'relation_ref_edge_not_found',
      `RelationRef edge "${ref.edgeId}" does not exist.`,
      path,
    );
    return;
  }

  if (edge.relationId !== ref.relationId) {
    addIssue(
      ctx,
      'error',
      'relation_ref_relation_mismatch',
      `RelationRef relation "${ref.relationId}" does not match edge relation "${edge.relationId}".`,
      path,
    );
  }
}

function validateOperationTarget(
  target: OperationTarget,
  indexes: GraphIndexes,
  path: string,
  ctx: MutableValidationContext,
): void {
  if (target.kind === 'node' && !indexes.nodes.has(target.nodeId)) {
    addIssue(
      ctx,
      'error',
      'operation_target_node_not_found',
      `Operation target node "${target.nodeId}" does not exist.`,
      path,
    );
  }
  if (target.kind === 'edge' && !indexes.edges.has(target.edgeId)) {
    addIssue(
      ctx,
      'error',
      'operation_target_edge_not_found',
      `Operation target edge "${target.edgeId}" does not exist.`,
      path,
    );
  }
  if (
    target.kind === 'relation' &&
    !Array.from(indexes.edges.values()).some((edge) => edge.relationId === target.relationId)
  ) {
    addIssue(
      ctx,
      'error',
      'operation_target_relation_not_found',
      `Operation target relation "${target.relationId}" does not exist in the design graph.`,
      path,
    );
  }
}

function validateOperationMappingTarget(
  target: QueryFieldRef | QueryRelationRef | OperationTarget,
  indexes: GraphIndexes,
  path: string,
  ctx: MutableValidationContext,
): void {
  if (isFieldRef(target)) {
    validateFieldRef(target, indexes, path, ctx);
    return;
  }

  if (isRelationRef(target)) {
    validateRelationRef(target, indexes, path, ctx);
    return;
  }

  validateOperationTarget(target, indexes, path, ctx);
}

function isOperationTargetValue(
  value: QueryFieldRef | QueryRelationRef | OperationTarget,
): value is OperationTarget {
  return 'kind' in value;
}

function sameOperationTarget(left: OperationTarget, right: OperationTarget): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === 'model' && right.kind === 'model') {
    return left.modelId === right.modelId;
  }
  if (left.kind === 'node' && right.kind === 'node') {
    return left.nodeId === right.nodeId;
  }
  if (left.kind === 'relation' && right.kind === 'relation') {
    return left.relationId === right.relationId;
  }
  return left.kind === 'edge' && right.kind === 'edge' && left.edgeId === right.edgeId;
}

function hasEdgeBetween(
  fromNodeId: NodeId,
  toNodeId: NodeId,
  edges: ReadonlyMap<EdgeId, DesignEdge>,
): boolean {
  for (const edge of edges.values()) {
    if (
      (edge.fromNodeId === fromNodeId && edge.toNodeId === toNodeId) ||
      (edge.fromNodeId === toNodeId && edge.toNodeId === fromNodeId)
    ) {
      return true;
    }
  }
  return false;
}

function isFieldRef(
  value: QueryFieldRef | QueryRelationRef | QueryMetricRef | OperationTarget,
): value is QueryFieldRef {
  return 'fieldId' in value;
}

function isRelationRef(
  value: QueryFieldRef | QueryRelationRef | QueryMetricRef | OperationTarget,
): value is QueryRelationRef {
  return 'edgeId' in value && 'relationId' in value;
}

function isMetricRef(
  value: QueryFieldRef | QueryRelationRef | QueryMetricRef | OperationTarget,
): value is QueryMetricRef {
  return 'metricId' in value;
}

function ensureNoWarningsMarkedAsDraft(
  compatibility: 'draft' | 'compatible' | 'breaking',
  ctx: MutableValidationContext,
): void {
  if (compatibility === 'draft') {
    addIssue(
      ctx,
      'warning',
      'active_interface_draft_compatibility',
      'Active interfaces should not use draft compatibility.',
      'version.compatibility',
    );
  }
}

function createValidationContext(): MutableValidationContext {
  return { issues: [] };
}

function toValidationResult(ctx: MutableValidationContext): QueryDesignerValidationResult {
  return {
    ok: !ctx.issues.some((issue) => issue.severity === 'error'),
    issues: ctx.issues,
  };
}

function requireNonEmpty(
  value: string,
  path: string,
  code: string,
  message: string,
  ctx: MutableValidationContext,
): void {
  if (value.trim().length === 0) {
    addIssue(ctx, 'error', code, message, path);
  }
}

function addIssue(
  ctx: MutableValidationContext,
  severity: QueryDesignerValidationSeverity,
  code: string,
  message: string,
  path?: string,
): void {
  ctx.issues.push({ severity, code, message, path });
}

function unique<T extends string>(values: T[]): T[] {
  return Array.from(new Set(values));
}

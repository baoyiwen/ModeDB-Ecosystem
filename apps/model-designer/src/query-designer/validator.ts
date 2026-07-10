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
  QueryFilter,
  QueryInterface,
  QueryProjectionField,
  QueryRelationRef,
} from './types.js';

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

export function validateEngineInterface(asset: EngineInterface): QueryDesignerValidationResult {
  const ctx = createValidationContext();

  validateEngineInterfaceBase(asset, ctx);
  const indexes = validateDesignGraph(asset.designGraph, ctx);
  validateInterfaceContract(asset.contract, ctx);
  validateDependencyGraph(asset.dependencies, asset.designGraph, ctx);

  if (asset.kind === 'query') {
    validateQueryInterface(asset, indexes, ctx);
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

  for (const filter of query.filters) {
    validateFilter(filter, parameterIds, indexes, ctx);
  }

  for (const sort of query.sorts) {
    validateFieldRef(sort.target, indexes, `query.sorts.${sort.id}.target`, ctx);
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

  validateOperationTarget(asset.operation.target, indexes, 'operation.target', ctx);

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

function validateFilter(
  filter: QueryFilter,
  parameterIds: ReadonlySet<ParameterId>,
  indexes: GraphIndexes,
  ctx: MutableValidationContext,
): void {
  validateQueryTarget(filter.target, indexes, `query.filters.${filter.id}.target`, ctx);

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
  target: QueryFieldRef | QueryRelationRef,
  indexes: GraphIndexes,
  path: string,
  ctx: MutableValidationContext,
): void {
  if (isFieldRef(target)) {
    validateFieldRef(target, indexes, path, ctx);
  } else {
    validateRelationRef(target, indexes, path, ctx);
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
  value: QueryFieldRef | QueryRelationRef | OperationTarget,
): value is QueryFieldRef {
  return 'fieldId' in value;
}

function isRelationRef(
  value: QueryFieldRef | QueryRelationRef | OperationTarget,
): value is QueryRelationRef {
  return 'edgeId' in value && 'relationId' in value;
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

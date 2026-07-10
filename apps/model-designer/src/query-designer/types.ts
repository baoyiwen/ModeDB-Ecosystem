export type InterfaceId = string;
export type ModelId = string;
export type FieldId = string;
export type RelationId = string;
export type NodeId = string;
export type EdgeId = string;
export type ParameterId = string;
export type InterfaceVersion = string;
export type IsoDateTime = string;

export type EngineInterface = QueryInterface | OperationInterface;

export type EngineInterfaceKind = 'query' | 'operation';

export type EngineInterfaceStatus = 'draft' | 'active' | 'deprecated' | 'archived';

export interface EngineInterfaceBase {
  id: InterfaceId;
  kind: EngineInterfaceKind;
  name: string;
  displayName?: string;
  description?: string;
  namespace?: string;
  status: EngineInterfaceStatus;
  version: InterfaceVersionInfo;
  contract: InterfaceContract;
  designGraph: DesignGraph;
  dependencies: DependencyGraph;
  lifecycle: InterfaceLifecycle;
  tags?: string[];
}

export interface InterfaceVersionInfo {
  current: InterfaceVersion;
  compatibility: 'draft' | 'compatible' | 'breaking';
  history?: InterfaceVersionRecord[];
}

export interface InterfaceVersionRecord {
  version: InterfaceVersion;
  createdAt: IsoDateTime;
  summary?: string;
  breakingChanges?: string[];
}

export interface InterfaceLifecycle {
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  createdBy?: string;
  updatedBy?: string;
  lastValidatedAt?: IsoDateTime;
  lastCompiledAt?: IsoDateTime;
  lastExecutedAt?: IsoDateTime;
}

export type QueryInterface = EngineInterfaceBase & {
  kind: 'query';
  query: QueryInterfaceSpec;
};

export interface QueryInterfaceSpec {
  rootNodeId: NodeId;
  traversal: QueryTraversalSpec;
  filters: QueryFilter[];
  sorts: QuerySort[];
  projection: QueryProjection;
  pagination?: QueryPagination;
  result: QueryResultContract;
  binding?: QueryBindingCapability;
}

export interface QueryTraversalSpec {
  primaryPath: NodeId[];
  branches: QueryBranch[];
}

export interface QueryBranch {
  id: string;
  fromNodeId: NodeId;
  path: NodeId[];
  label?: string;
}

export interface QueryFilter {
  id: string;
  target: QueryFieldRef | QueryRelationRef;
  operator: QueryFilterOperator;
  value?: QueryFilterValue;
  enabled: boolean;
}

export type QueryFilterOperator =
  | 'eq'
  | 'neq'
  | 'contains'
  | 'startsWith'
  | 'endsWith'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  | 'notIn'
  | 'isNull'
  | 'isNotNull';

export type QueryFilterValue =
  | { kind: 'literal'; value: unknown }
  | { kind: 'parameter'; parameterId: ParameterId };

export interface QuerySort {
  id: string;
  target: QueryFieldRef;
  direction: 'asc' | 'desc';
  priority: number;
}

export interface QueryProjection {
  shape: QueryResultShape;
  fields: QueryProjectionField[];
}

export type QueryResultShape = 'flat' | 'tree';

export interface QueryProjectionField {
  id: string;
  source: QueryFieldRef;
  outputName: string;
  visible: boolean;
  nullable?: boolean;
  readonly?: boolean;
}

export interface QueryPagination {
  mode: 'none' | 'offset' | 'cursor';
  defaultLimit?: number;
  maxLimit?: number;
}

export interface QueryResultContract {
  shape: QueryResultShape;
  schema: QueryResultField[];
  includesRecordRefs: boolean;
  sample?: unknown;
}

export interface QueryResultField {
  name: string;
  type: InterfaceValueType;
  nullable: boolean;
  source?: QueryFieldRef;
  children?: QueryResultField[];
}

export type OperationInterface = EngineInterfaceBase & {
  kind: 'operation';
  operation: OperationInterfaceSpec;
};

export interface OperationInterfaceSpec {
  operationType: OperationType;
  target: OperationTarget;
  inputMapping: OperationInputMapping[];
  validationRules: OperationValidationRule[];
  transactionPolicy: TransactionPolicy;
  result: OperationResultContract;
}

export type OperationType =
  | 'create'
  | 'update'
  | 'delete'
  | 'bind'
  | 'unbind'
  | 'rebind'
  | 'upsert'
  | 'batch';

export type OperationTarget =
  | { kind: 'model'; modelId: ModelId }
  | { kind: 'relation'; relationId: RelationId }
  | { kind: 'node'; nodeId: NodeId }
  | { kind: 'edge'; edgeId: EdgeId };

export interface OperationInputMapping {
  parameterId: ParameterId;
  target: QueryFieldRef | QueryRelationRef | OperationTarget;
  mode: 'set' | 'lookup' | 'connect' | 'disconnect';
}

export interface OperationValidationRule {
  id: string;
  message: string;
}

export interface TransactionPolicy {
  mode: 'none' | 'single' | 'batch';
  rollbackOnFailure: boolean;
}

export interface OperationResultContract {
  returns: 'none' | 'recordRef' | 'record' | 'summary';
  schema?: QueryResultField[];
}

export interface InterfaceContract {
  parameters: InterfaceParameter[];
  output: InterfaceOutputContract;
  errors: InterfaceErrorContract[];
  permissions?: InterfacePermissionPolicy;
  invocation: InterfaceInvocationShape;
}

export interface InterfaceParameter {
  id: ParameterId;
  name: string;
  label?: string;
  type: InterfaceValueType;
  required: boolean;
  defaultValue?: unknown;
  description?: string;
}

export type InterfaceValueType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'enum'
  | 'json'
  | 'recordRef'
  | 'relationRef';

export interface InterfaceOutputContract {
  shape: 'none' | 'single' | 'list' | 'tree' | 'summary';
  schema?: QueryResultField[];
}

export interface InterfaceErrorContract {
  code: string;
  message: string;
  recoverable: boolean;
}

export interface InterfacePermissionPolicy {
  mode: 'none' | 'role' | 'custom';
  roles?: string[];
  ruleId?: string;
}

export interface InterfaceInvocationShape {
  method: 'query' | 'mutation';
  endpoint?: string;
  callableName?: string;
}

export interface DesignGraph {
  rootNodeId: NodeId;
  nodes: DesignNode[];
  edges: DesignEdge[];
  annotations?: DesignGraphAnnotation[];
}

export interface DesignNode {
  id: NodeId;
  modelId: ModelId;
  alias: string;
  role: DesignNodeRole;
  cardinality?: 'one' | 'many';
  position?: DesignNodePosition;
}

export type DesignNodeRole = 'root' | 'joined' | 'lookup' | 'transient';

export interface DesignNodePosition {
  x: number;
  y: number;
}

export interface DesignEdge {
  id: EdgeId;
  relationId: RelationId;
  fromNodeId: NodeId;
  toNodeId: NodeId;
  alias: string;
  required: boolean;
  cardinality: 'one' | 'many';
  traversal: 'forward' | 'reverse';
  purpose?: 'traversal' | 'constraint';
  traversalRole?: 'primary' | 'branch';
  inherited?: {
    childModelId: ModelId;
    ownerModelId: ModelId;
    inheritRelationId: RelationId;
  };
}

export interface QueryFieldRef {
  nodeId: NodeId;
  modelId: ModelId;
  fieldId: FieldId;
}

export interface QueryRelationRef {
  edgeId: EdgeId;
  relationId: RelationId;
}

export interface DesignGraphAnnotation {
  id: string;
  targetId: NodeId | EdgeId;
  level: 'info' | 'warning' | 'error';
  message: string;
}

export interface DependencyGraph {
  models: ModelId[];
  fields: string[];
  relations: RelationId[];
  indexes?: string[];
  interfaces?: InterfaceId[];
}

export interface QueryBindingCapability {
  bindable: boolean;
  writeMode: QueryWriteMode;
  readableNodes: NodeId[];
  writableNodes: NodeId[];
  writableFields: WritableField[];
  relationPolicies: RelationWritePolicy[];
  warnings: BindingWarning[];
}

export type QueryWriteMode = 'readonly' | 'partial' | 'writable' | 'ambiguous';

export interface WritableField {
  field: QueryFieldRef;
  operationInterfaceId?: InterfaceId;
}

export interface RelationWritePolicy {
  relation: QueryRelationRef;
  allowedOperations: OperationType[];
  deleteBehavior: 'deleteRecord' | 'unbindOnly' | 'deny';
}

export interface BindingWarning {
  code: string;
  message: string;
  targetId?: NodeId | EdgeId | FieldId;
}

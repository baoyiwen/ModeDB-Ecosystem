# Query Designer 核心协议与类型边界 v1

## 1. 目标

本文档定义 Query Designer 第一阶段研发所需的核心协议与类型边界。

Query Designer 的产物不是临时查询，而是可以被外部系统、前端页面、DataBinding、后端服务和 Agent 调用的引擎接口资产。

核心目标：

- 定义 EngineInterface 的通用资产结构。
- 定义 QueryInterface 作为读接口的 v1 结构。
- 定义 OperationInterface 作为写入与关系操作接口的 v1 边界。
- 定义 DesignGraph 作为设计态图结构。
- 定义 InterfaceContract 作为对外调用契约。
- 为后续校验器、编译器、Interface Manager 和 DataBinding 接入提供稳定基础。

## 2. 设计原则

### 2.1 接口资产优先

Query Designer 生成的是接口资产，而不是一次性的查询配置。

接口资产必须支持：

- 保存
- 复用
- 版本化
- 依赖分析
- 调用审计
- 外部调用
- DataBinding 接入
- 后续 Agent 生成与维护

### 2.2 外界不直接操作引擎

外部调用方不直接访问底层引擎协议，而是调用 Query Designer 生成的 EngineInterface。

```text
External Caller
  -> InterfaceContract
  -> EngineInterface
  -> QueryPlan / OperationPlan
  -> ModeDB Engine
```

### 2.3 设计态与执行态分离

Query Designer 内部保存 DesignGraph。

引擎执行 QueryPlan 或 OperationPlan。

```text
DesignGraph = 设计态
QueryPlan / OperationPlan = 执行态
```

### 2.4 底层使用 Rooted Graph，首版 UI 表现为 Chain + Branches

协议层不应被简单链式 UI 限制。

v1 内部结构使用有根图：

```text
Rooted Graph
```

v1 UI 表现可以是：

```text
Primary Chain + Branches
```

## 3. 核心类型总览

```ts
type EngineInterface = QueryInterface | OperationInterface;
```

核心类型：

```text
EngineInterface
QueryInterface
OperationInterface
InterfaceContract
DesignGraph
DependencyGraph
QueryPlan
OperationPlan
BindingSurface
WritebackPolicy
```

本文档重点定义前五类：

```text
EngineInterface
QueryInterface
OperationInterface
InterfaceContract
DesignGraph
```

## 4. 通用基础类型

```ts
type InterfaceId = string;
type ModelId = string;
type FieldId = string;
type RelationId = string;
type NodeId = string;
type EdgeId = string;
type ParameterId = string;
type InterfaceVersion = string;
type IsoDateTime = string;
```

所有 id 在当前 workspace 或 project 范围内必须稳定。

## 5. EngineInterface

EngineInterface 是 Query Designer 生成的可调用接口资产总称。

```ts
type EngineInterface = QueryInterface | OperationInterface;

type EngineInterfaceKind = 'query' | 'operation';

type EngineInterfaceStatus = 'draft' | 'active' | 'deprecated' | 'archived';

type EngineInterfaceBase = {
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
};
```

### 5.1 Version

```ts
type InterfaceVersionInfo = {
  current: InterfaceVersion;
  compatibility: 'draft' | 'compatible' | 'breaking';
  history?: InterfaceVersionRecord[];
};

type InterfaceVersionRecord = {
  version: InterfaceVersion;
  createdAt: IsoDateTime;
  summary?: string;
  breakingChanges?: string[];
};
```

### 5.2 Lifecycle

```ts
type InterfaceLifecycle = {
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  createdBy?: string;
  updatedBy?: string;
  lastValidatedAt?: IsoDateTime;
  lastCompiledAt?: IsoDateTime;
  lastExecutedAt?: IsoDateTime;
};
```

## 6. QueryInterface

QueryInterface 是读接口资产。

它负责描述如何从模型关系图谱中读取数据，并暴露稳定的输入和输出契约。

```ts
type QueryInterface = EngineInterfaceBase & {
  kind: 'query';
  query: QueryInterfaceSpec;
};

type QueryInterfaceSpec = {
  rootNodeId: NodeId;
  traversal: QueryTraversalSpec;
  filters: QueryFilter[];
  sorts: QuerySort[];
  projection: QueryProjection;
  pagination?: QueryPagination;
  result: QueryResultContract;
  binding?: QueryBindingCapability;
};
```

### 6.1 Traversal

```ts
type QueryTraversalSpec = {
  primaryPath: NodeId[];
  branches: QueryBranch[];
};

type QueryBranch = {
  id: string;
  fromNodeId: NodeId;
  path: NodeId[];
  label?: string;
};
```

说明：

- `primaryPath` 是首版 UI 中展示的主链。
- `branches` 是从主链或节点上展开的分支。
- 实际节点和边仍以 `designGraph.nodes` 与 `designGraph.edges` 为准。

### 6.2 Filter

```ts
type QueryFilter = {
  id: string;
  target: QueryFieldRef | QueryRelationRef;
  operator: QueryFilterOperator;
  value?: QueryFilterValue;
  enabled: boolean;
};

type QueryFilterOperator =
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

type QueryFilterValue =
  | { kind: 'literal'; value: unknown }
  | { kind: 'parameter'; parameterId: ParameterId };
```

### 6.3 Sort

```ts
type QuerySort = {
  id: string;
  target: QueryFieldRef;
  direction: 'asc' | 'desc';
  priority: number;
};
```

### 6.4 Projection

```ts
type QueryProjection = {
  shape: QueryResultShape;
  fields: QueryProjectionField[];
};

type QueryResultShape = 'flat' | 'tree';

type QueryProjectionField = {
  id: string;
  source: QueryFieldRef;
  outputName: string;
  visible: boolean;
  nullable?: boolean;
  readonly?: boolean;
};
```

### 6.5 Pagination

```ts
type QueryPagination = {
  mode: 'none' | 'offset' | 'cursor';
  defaultLimit?: number;
  maxLimit?: number;
};
```

### 6.6 Result Contract

```ts
type QueryResultContract = {
  shape: QueryResultShape;
  schema: QueryResultField[];
  includesRecordRefs: boolean;
  sample?: unknown;
};

type QueryResultField = {
  name: string;
  type: InterfaceValueType;
  nullable: boolean;
  source?: QueryFieldRef;
  children?: QueryResultField[];
};
```

## 7. OperationInterface

OperationInterface 是写入与关系操作接口资产。

v1 先定义协议边界，不要求第一阶段完整实现执行器。

```ts
type OperationInterface = EngineInterfaceBase & {
  kind: 'operation';
  operation: OperationInterfaceSpec;
};

type OperationInterfaceSpec = {
  operationType: OperationType;
  target: OperationTarget;
  inputMapping: OperationInputMapping[];
  validationRules: OperationValidationRule[];
  transactionPolicy: TransactionPolicy;
  result: OperationResultContract;
};
```

### 7.1 Operation Type

```ts
type OperationType =
  | 'create'
  | 'update'
  | 'delete'
  | 'bind'
  | 'unbind'
  | 'rebind'
  | 'upsert'
  | 'batch';
```

### 7.2 Operation Target

```ts
type OperationTarget =
  | { kind: 'model'; modelId: ModelId }
  | { kind: 'relation'; relationId: RelationId }
  | { kind: 'node'; nodeId: NodeId }
  | { kind: 'edge'; edgeId: EdgeId };
```

### 7.3 Input Mapping

```ts
type OperationInputMapping = {
  parameterId: ParameterId;
  target: QueryFieldRef | QueryRelationRef | OperationTarget;
  mode: 'set' | 'lookup' | 'connect' | 'disconnect';
};
```

### 7.4 Transaction Policy

```ts
type TransactionPolicy = {
  mode: 'none' | 'single' | 'batch';
  rollbackOnFailure: boolean;
};
```

### 7.5 Operation Result

```ts
type OperationResultContract = {
  returns: 'none' | 'recordRef' | 'record' | 'summary';
  schema?: QueryResultField[];
};
```

## 8. InterfaceContract

InterfaceContract 是 EngineInterface 暴露给外部调用方的稳定契约。

```ts
type InterfaceContract = {
  parameters: InterfaceParameter[];
  output: InterfaceOutputContract;
  errors: InterfaceErrorContract[];
  permissions?: InterfacePermissionPolicy;
  invocation: InterfaceInvocationShape;
};
```

### 8.1 Parameters

```ts
type InterfaceParameter = {
  id: ParameterId;
  name: string;
  label?: string;
  type: InterfaceValueType;
  required: boolean;
  defaultValue?: unknown;
  description?: string;
};

type InterfaceValueType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'enum'
  | 'json'
  | 'recordRef'
  | 'relationRef';
```

### 8.2 Output

```ts
type InterfaceOutputContract = {
  shape: 'none' | 'single' | 'list' | 'tree' | 'summary';
  schema?: QueryResultField[];
};
```

### 8.3 Errors

```ts
type InterfaceErrorContract = {
  code: string;
  message: string;
  recoverable: boolean;
};
```

### 8.4 Permissions

```ts
type InterfacePermissionPolicy = {
  mode: 'none' | 'role' | 'custom';
  roles?: string[];
  ruleId?: string;
};
```

### 8.5 Invocation

```ts
type InterfaceInvocationShape = {
  method: 'query' | 'mutation';
  endpoint?: string;
  callableName?: string;
};
```

## 9. DesignGraph

DesignGraph 是 Query Designer 的设计态图结构。

它描述接口如何基于模型关系图谱展开。

```ts
type DesignGraph = {
  rootNodeId: NodeId;
  nodes: DesignNode[];
  edges: DesignEdge[];
  annotations?: DesignGraphAnnotation[];
};
```

### 9.1 Node

```ts
type DesignNode = {
  id: NodeId;
  modelId: ModelId;
  alias: string;
  role: DesignNodeRole;
  cardinality?: 'one' | 'many';
  position?: DesignNodePosition;
};

type DesignNodeRole = 'root' | 'joined' | 'lookup' | 'transient';

type DesignNodePosition = {
  x: number;
  y: number;
};
```

### 9.2 Edge

```ts
type DesignEdge = {
  id: EdgeId;
  relationId: RelationId;
  fromNodeId: NodeId;
  toNodeId: NodeId;
  alias: string;
  required: boolean;
  cardinality: 'one' | 'many';
  traversal: 'forward' | 'reverse';
};
```

### 9.3 Refs

```ts
type QueryFieldRef = {
  nodeId: NodeId;
  modelId: ModelId;
  fieldId: FieldId;
};

type QueryRelationRef = {
  edgeId: EdgeId;
  relationId: RelationId;
};
```

### 9.4 Annotation

```ts
type DesignGraphAnnotation = {
  id: string;
  targetId: NodeId | EdgeId;
  level: 'info' | 'warning' | 'error';
  message: string;
};
```

## 10. DependencyGraph

DependencyGraph 用于影响分析。

```ts
type DependencyGraph = {
  models: ModelId[];
  fields: string[];
  relations: RelationId[];
  indexes?: string[];
  interfaces?: InterfaceId[];
};
```

约定：

- `models` 保存所有依赖模型。
- `fields` 建议使用稳定字段引用，例如 `ModelId.FieldId`。
- `relations` 保存所有依赖关系。
- `interfaces` 用于接口组合或 BindingSurface 场景。

## 11. BindingCapability

BindingCapability 用于描述 QueryInterface 是否可以被 DataBinding 使用。

v1 只做能力分析，不要求直接自动写回。

```ts
type QueryBindingCapability = {
  bindable: boolean;
  writeMode: QueryWriteMode;
  readableNodes: NodeId[];
  writableNodes: NodeId[];
  writableFields: WritableField[];
  relationPolicies: RelationWritePolicy[];
  warnings: BindingWarning[];
};

type QueryWriteMode = 'readonly' | 'partial' | 'writable' | 'ambiguous';

type WritableField = {
  field: QueryFieldRef;
  operationInterfaceId?: InterfaceId;
};

type RelationWritePolicy = {
  relation: QueryRelationRef;
  allowedOperations: OperationType[];
  deleteBehavior: 'deleteRecord' | 'unbindOnly' | 'deny';
};

type BindingWarning = {
  code: string;
  message: string;
  targetId?: NodeId | EdgeId | FieldId;
};
```

## 12. v1 校验规则

第一版 Validator 至少需要校验：

- EngineInterface 必须有 id、kind、name、status、version。
- DesignGraph 必须有且只有一个 root node。
- QueryInterface 的 `query.rootNodeId` 必须等于 `designGraph.rootNodeId`。
- 所有 edge 的 fromNodeId 和 toNodeId 必须存在。
- 所有 filter target 必须指向存在的 field 或 relation。
- 所有 parameter 引用必须存在于 InterfaceContract.parameters。
- Projection 中的 field 必须指向存在的 node 和 field。
- DependencyGraph 必须覆盖 DesignGraph 中使用的模型和关系。
- QueryResultContract 必须与 Projection shape 一致。
- active 接口必须通过完整校验。

## 13. v1 MVP 边界

v1 支持：

- QueryInterface
- Rooted Graph 数据结构
- Primary Chain + Branches UI 映射
- 参数化 filter
- field projection
- flat / tree result contract
- dependency graph
- binding capability 初步分析
- OperationInterface 协议边界

v1 不支持：

- 复杂聚合
- 自定义表达式
- 多 root 查询
- 完整权限系统
- 自动写回执行
- Agent 自动生成接口

## 14. 示例

```json
{
  "id": "query_customer_orders",
  "kind": "query",
  "name": "customerOrders",
  "displayName": "客户订单查询",
  "status": "draft",
  "version": {
    "current": "0.1.0",
    "compatibility": "draft"
  },
  "contract": {
    "parameters": [
      {
        "id": "param_status",
        "name": "status",
        "type": "string",
        "required": false
      }
    ],
    "output": {
      "shape": "tree"
    },
    "errors": [],
    "invocation": {
      "method": "query",
      "callableName": "customerOrders"
    }
  },
  "designGraph": {
    "rootNodeId": "node_customer",
    "nodes": [
      {
        "id": "node_customer",
        "modelId": "Customer",
        "alias": "customer",
        "role": "root"
      },
      {
        "id": "node_order",
        "modelId": "Order",
        "alias": "orders",
        "role": "joined",
        "cardinality": "many"
      }
    ],
    "edges": [
      {
        "id": "edge_customer_orders",
        "relationId": "Customer.orders",
        "fromNodeId": "node_customer",
        "toNodeId": "node_order",
        "alias": "orders",
        "required": false,
        "cardinality": "many",
        "traversal": "forward"
      }
    ]
  },
  "query": {
    "rootNodeId": "node_customer",
    "traversal": {
      "primaryPath": ["node_customer", "node_order"],
      "branches": []
    },
    "filters": [
      {
        "id": "filter_order_status",
        "target": {
          "nodeId": "node_order",
          "modelId": "Order",
          "fieldId": "status"
        },
        "operator": "eq",
        "value": {
          "kind": "parameter",
          "parameterId": "param_status"
        },
        "enabled": true
      }
    ],
    "sorts": [],
    "projection": {
      "shape": "tree",
      "fields": [
        {
          "id": "field_customer_name",
          "source": {
            "nodeId": "node_customer",
            "modelId": "Customer",
            "fieldId": "name"
          },
          "outputName": "customerName",
          "visible": true
        }
      ]
    },
    "result": {
      "shape": "tree",
      "schema": [],
      "includesRecordRefs": true
    }
  },
  "dependencies": {
    "models": ["Customer", "Order"],
    "fields": ["Customer.name", "Order.status"],
    "relations": ["Customer.orders"]
  },
  "lifecycle": {
    "createdAt": "2026-07-09T00:00:00.000Z",
    "updatedAt": "2026-07-09T00:00:00.000Z"
  }
}
```

## 15. 下一步

下一阶段应实现：

- TypeScript 类型文件
- 示例 QueryInterface fixtures
- DesignGraph Validator
- QueryInterface Validator
- DependencyGraph 生成器
- Validator 测试用例

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

重新发布时按契约影响自动计算最低版本：仅元数据或查询行为变化递增 patch；新增可选参数、输出字段等兼容扩展递增 minor；新增必填参数、删除或改型参数、删除或改型输出字段、结果形态、分页模式、调用名或访问策略变化递增 major，并将 `compatibility` 标记为 `breaking`。显式设置的更高版本会被保留，但不会允许低于计算出的最低版本。

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
  batch?: BatchOperationSpec;
};

type BatchOperationSpec = {
  itemOperationType: Exclude<OperationType, 'batch'>;
  maxItems: number;
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
  failureMode?: 'continue' | 'stop';
};
```

batch 当前仅支持 `mode: 'batch'`、`rollbackOnFailure: false`。`continue` 允许部分成功；`stop`
只停止后续项，不回滚此前成功项。

### 7.5 Operation Result

```ts
type OperationResultContract = {
  returns: 'none' | 'recordRef' | 'record' | 'summary';
  schema?: QueryResultField[];
  includeItemResults?: boolean;
};
```

batch 固定使用 `returns: 'summary'`。运行时返回
`status: 'success' | 'partial' | 'failed'`、六个执行计数字段，以及可选 `items` 逐项结果。

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

BindingCapability 用于描述 QueryInterface 是否可以被 DataBinding 使用。它是静态能力提示；真正的写回只能通过显式 BindingSurface 绑定到已发布 OperationInterface，不根据字段名自动猜测写操作。

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

## 12. BindingSurface Contract V1

BindingSurface 将一个固定版本的 QueryInterface 与零个或多个固定版本的 OperationInterface 组合为 DataBinding 可消费的读写契约。草稿引用 `interfaceId + version`，编译后同时固化 `callableName`，避免接口重新发布后产生隐式漂移。

```ts
type BindingSurface = {
  id: InterfaceId;
  kind: 'binding';
  name: string;
  status: EngineInterfaceStatus;
  version: InterfaceVersionInfo;
  parameters: InterfaceParameter[];
  query: BindingSurfaceQueryBinding;
  writeback: WritebackPolicy;
  lifecycle: InterfaceLifecycle;
};

type BindingSurfaceQueryBinding = {
  interfaceId: InterfaceId;
  version: InterfaceVersion;
  parameterBindings: BindingSurfaceParameterBinding[];
};

type WritebackPolicy = {
  mode: 'readonly' | 'explicit';
  mutations: BindingSurfaceMutationBinding[];
  refresh: 'manual' | 'afterMutation';
};

type BindingSurfaceMutationTrigger =
  | { kind: 'create' | 'delete'; nodeId: NodeId }
  | { kind: 'update'; fieldPath: string }
  | { kind: 'bind' | 'unbind' | 'rebind'; edgeId: EdgeId };

type BindingSurfaceValueSource =
  | { kind: 'surfaceParameter'; parameterId: ParameterId }
  | { kind: 'rowField'; fieldPath: string }
  | { kind: 'rowRecordRef'; nodeId: NodeId }
  | { kind: 'editedValue' }
  | { kind: 'literal'; value: unknown };
```

V1 编译规则：

- 所有读写接口必须引用存在且 active 的精确 release。
- 查询参数与操作必填参数必须存在唯一值来源。
- `rowField` 必须来自查询结果契约，`rowRecordRef` 要求查询结果携带记录引用。
- 字段更新必须指向有源字段且非 readonly 的 projection；模型和关系写操作必须与查询图目标一致。
- create 触发器可使用 create 或 upsert，update 触发器可使用 update 或 upsert；其他触发器必须与操作类型严格一致。
- readonly 表面不得携带写路由；同一 UI 触发器不得映射到多个操作。
- 编译结果使用共享 `PublishedBindingSurfaceContract` format 1，SDK 与 Data Kit 通过同一类型出口消费。

发布与持久化规则：

- 发布前必须使用当前 QueryInterface / OperationInterface release 集合重新编译，不能直接接受调用方传入的旧 contract。
- `BindingSurfaceRelease` 保存 active BindingSurface 快照和完整 `PublishedBindingSurfaceContract`；重新发布时自动递增 patch 版本并把上一版完整快照归档。
- 弃用只改变 release 生命周期状态，不删除 contract 或历史版本。
- 设计器专属库使用 `sys_binding_surface` 保存草稿、签名、当前 release 和 `release_history_json`。
- 注册表以 `surface_id` 作为逻辑键，以引擎 `_id` 作为存储键，并按 `library_code` 隔离业务库。

## 13. v1 校验规则

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

## 14. v1 MVP 边界

v1 支持：

- QueryInterface
- Rooted Graph 数据结构
- Primary Chain + Branches UI 映射
- 参数化 filter
- field projection
- flat / tree result contract
- dependency graph
- binding capability 初步分析
- OperationInterface 设计、发布与执行
- BindingSurface 版本固定、参数映射和写回路由编译

v1 不支持：

- 自定义表达式
- 多 root 查询
- 完整权限系统
- Agent 自动生成接口

BindingSurface 的服务端运行时调用编排与 SDK 基础调用已经接入。`executeBindingSurface` 支持 `read` / `mutate`、精确历史版本、Surface 自身 access key、分接口 access key、Surface 级限流、`manual` / `afterMutation` 刷新策略，以及 `surfaceParameter`、`literal`、`editedValue`、`rowRecordRef`、`rowField` 五类参数来源。

Data Kit 已提供 `createBindingSurfaceSession`：它保留原始 QueryInterface 行用于后续 mutation 映射，同时把内部 `$recordRef` 转换为视图层 `rowRefs`，不会显示为数据列。会话可按 `rowIndex` 自动带入原始行与无歧义的节点记录引用，并独立维护请求版本、Surface 参数和分接口 access key。

Model Designer 已提供 Binding Surface Designer。设计页用于固定 QueryInterface release、设置 `readonly` / `explicit` 写入模式、配置刷新策略、Surface 权限/限流和 OperationInterface 参数来源；资产页管理草稿、当前 release、历史台账及调用统计；执行页通过真实 Data Kit 会话验证 read / mutate，并将 Surface access key 与子接口 access key 分开输入。

当 mutation 已提交而 `afterMutation` 查询刷新失败时，服务端返回 `status: 'refreshFailed'`，同时保留 `mutation` 与结构化 `refreshError`。该状态不是写入失败，客户端不得自动重试 mutation。

## 15. 示例

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

## 16. 后续阶段

Query Designer V1 的读接口、写接口、BindingSurface 设计/编译/发布/执行、会话适配、统一治理和 Data UI 消费主链路已经形成。后续工作聚焦产品化收口：

- [x] Data UI 对 `BindingSurfaceSession` 的通用表格、表单和关系编辑组件接入，并完成真实服务读写与数据恢复验证
- [x] 契约迁移、兼容性检查和发布回滚工具

### 16.1 BindingSurface 失败恢复实验（已完成）

可重复的真实服务实验位于 `scripts/binding-surface-failure-recovery-live-check.ts`，通过
`pnpm test:live:binding-surface-recovery` 执行。实验使用临时业务库与隔离的接口资产，结束时自动清理注册表、审计记录和临时库，并验证：

- mutation 本身失败时不会继续执行 query 刷新，业务数据保持不变；
- mutation 已提交但 `afterMutation` 刷新失败时返回 `refreshFailed`，成功的写入结果不会丢失；
- 调用方可以改用健康的 Surface/read 路径确认已提交状态，不会重试 mutation；
- 恢复写入后自动刷新成功，实验业务数据回到初始值；
- QueryInterface 与 OperationInterface 子调用的成功/失败审计数量与执行路径一致。

### 16.2 BindingSurface 统一治理（已完成）

- 发布契约支持 `none` / `key` / `disabled` 权限模式和可选固定窗口限流，旧 release 未配置策略时保持连接认证兼容行为；
- Surface 自身策略在参数绑定和 QueryInterface / OperationInterface 子调用之前执行，限流窗口按接口类型、逻辑库、Surface 和 release 版本隔离；
- `sys_binding_surface_call_log` 记录版本、动作、状态、错误码、耗时、参数数量和结果行数，不保存 access key、参数值、业务行或编辑值；
- 审计状态区分 `success`、`refresh_failed` 和 `error`，且审计持久化失败不会改变业务调用结果；
- Binding Surface Designer 资产页展示总调用、成功、刷新失败、执行错误、平均耗时、趋势和最近调用；无调用记录时显示明确的零值指标；
- 真实服务实验验证 Surface 密钥前置拦截与六次调用审计顺序：`error`、`success`、`error`、`refresh_failed`、`success`、`success`。

批量操作的 `continue` / `stop` 部分成功契约继续由
`scripts/batch-operation-interface-live-check.ts` 在真实服务上验证。

### 16.3 契约迁移、兼容性与发布回滚（已完成）

- 注册表加载旧草稿时补齐当前契约要求的安全默认值；历史 release 保持不可变，仅在重新发布前迁移。
- QueryInterface、OperationInterface 与 BindingSurface 均在发布前生成 `patch` / `minor` / `major` 影响报告，并按最低兼容版本递增；破坏性变化标记为 `breaking`。
- 回滚不把当前指针直接切换到旧 release，而是迁移并重新编译目标历史契约，再以更高的新版本发布；被替换的当前 release 进入历史台账，当前设计草稿不被覆盖。
- 三类资产台账展示历史版本相对当前 release 的兼容性级别，并为契约不同的历史版本提供带确认提示的回滚操作。
- 真实服务实验将 `activeTrainServicesSurface` 从 v1.0.1 回滚发布为 v2.0.0，再把原写回契约恢复发布为 v3.0.0；两个版本读取均返回 75 行，最终写回路由恢复，业务数据没有变化。

Query Designer V1 的计划研发阶段至此完成，后续进入性能、包体、长列表和交互体验调优。

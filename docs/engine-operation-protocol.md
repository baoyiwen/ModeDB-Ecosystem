# 引擎操作协议（Engine Operation Protocol）

本文描述 ModeDB 的 **统一 JSON 操作协议**：所有引擎动作（工作区 CRUD、模型/关系/行 CRUD、绑定、查询、数据清除）都有对应的 JSON 形态，可通过 **`apply(op)`** / **`applyAll(ops)`** 执行，与现有函数式 API **双支持**（Designer / Query Designer 可序列化配置后直接下发）。

**类型定义**：`packages/shared/src/engine-operations.ts`  
**执行器**：`packages/core/src/network/operation-executor.ts`  
**集成回归**：`test/integration/protocol-operations.ts`

---

## 1. 作用域（scope）

| 作用域        | 类型别名                                        | 入口                                                  | 说明                                |
| ------------- | ----------------------------------------------- | ----------------------------------------------------- | ----------------------------------- |
| **database**  | `EngineDatabaseOperation` (= `WireExecuteBody`) | `AuthoringEngine.apply` / `RemoteModelDBClient.apply` | 针对**一个逻辑库**（atlas）内的读写 |
| **workspace** | `EngineWorkspaceOperation`                      | `ModelDB.apply`                                       | 创建/删除/列举逻辑库、读取 catalog  |

```typescript
import {
  type EngineOperation,
  isDatabaseOperation,
  isWorkspaceOperation,
  operationScope,
} from '@mode-db/sdk';
```

---

## 2. 入口 API

### 2.1 进程内（治理端）

```typescript
import { AuthoringEngine } from '@mode-db/core';

const engine = new AuthoringEngine({ atlas, storageRoot, connectToken });

// 单条
const result = await engine.apply({
  op: 'insert',
  model: 'Country',
  data: { id: 'jp', name: 'Japan' },
});

// 批量（默认 failFast: true）
const outcomes = await engine.applyAll([
  { op: 'registerModel', model: 'Tag', schema: { id: 'String', label: 'String' } },
  { op: 'insert', model: 'Tag', data: { id: 't1', label: 'red' } },
]);
```

### 2.2 远程 SDK

```typescript
import { ModelDB } from '@mode-db/sdk';

const modeldb = new ModelDB({ host, port, token });

// 工作区
await modeldb.apply({ op: 'createDatabase', name: 'my_lib' });
await modeldb.apply({ op: 'listDatabases' });

// 逻辑库内（需指定 database）
const client = await modeldb.use('my_lib');
await client.apply({ op: 'clearAllData' });

// 或经 ModelDB 路由
await modeldb.apply({ op: 'clearModelData', model: 'Country' }, 'my_lib');
```

---

## 3. 查询协议（`executeQuery`）

查询不复用新的 DSL，而是复用现有 **`RemoteExecuteSnapshot`**（由 `WireQueryChain.getRemoteExecuteSnapshot()` 生成，或手写等价 JSON）。

### 3.1 快照结构

```typescript
interface RemoteExecuteSnapshot {
  plan: QueryPlanASTv2; // 起点模型 + hops + 可选 filter
  execute: {
    limit?: number;
    page?: number;
    includeRelates?: boolean; // 将关系子行挂到 relates[slot]
    wrapGroups?: boolean;
  };
  analysis: {
    groupBy: readonly string[] | null;
    compute: Record<string, AggregateInputEntry> | null;
  };
}
```

**限制**：wire 传输不支持 `filter(callback)`、`customReduce()`、`wrapGroups()`（见 `finalizeRemoteExecuteSnapshot`）。

### 3.2 示例 A：简单列表查询

函数式：

```typescript
const rows = await client.model('Country').query().execute();
```

等价 JSON（`apply`）：

```typescript
const snapshot = client.model('Country').query().getRemoteExecuteSnapshot();
const result = await client.apply({ op: 'executeQuery', snapshot });
// result: { kind: 'rows', rows: [{ model: 'Country', data: { ... } }, ...] }
```

手写 JSON 形态（示意，`plan` 由链式 API 生成更可靠）：

```json
{
  "op": "executeQuery",
  "snapshot": {
    "plan": {
      "start": { "model": "Country", "mode": "rows" },
      "hops": []
    },
    "execute": { "page": 0 },
    "analysis": { "groupBy": null, "compute": null }
  }
}
```

### 3.3 示例 B：关系前进 + 嵌套子行（`relate` + `includeRelates`）

函数式：

```typescript
const rows = await client
  .model('Country')
  .query()
  .relate('cities')
  .execute({ includeRelates: true });
// 主体变为 City；每行 data.relates 含反向关系槽位
```

JSON：

```typescript
const snapshot = client
  .model('Country')
  .query()
  .relate('cities')
  .getRemoteExecuteSnapshot({ includeRelates: true });
await client.apply({ op: 'executeQuery', snapshot });
```

### 3.4 示例 C：横向附加（`group`，主体不变）

当需要在**保持查询主体**的同时把关系目标挂在 `relates` 下（例如 Country 行下挂 cities，顶层仍是 Country）：

函数式：

```typescript
const rows = await client
  .model('Country')
  .query()
  .group('cities')
  .execute({ includeRelates: true });
```

JSON：

```typescript
const snapshot = client
  .model('Country')
  .query()
  .group('cities')
  .getRemoteExecuteSnapshot({ includeRelates: true });
await client.apply({ op: 'executeQuery', snapshot });
```

`plan.hops[0].lateral` 为 `true` 表示 lateral attach。

### 3.5 示例 D：自关联树（`children`）

函数式：

```typescript
const tree = await client
  .model('Category')
  .query()
  .children('parent', { maxDepth: 3 })
  .execute({ includeRelates: true });
// 每行 data.relates.parent 为嵌套子节点数组
```

JSON：

```typescript
const snapshot = client
  .model('Category')
  .query()
  .children('parent', { maxDepth: 3 })
  .getRemoteExecuteSnapshot({ includeRelates: true });
await client.apply({ op: 'executeQuery', snapshot });
```

`plan.hops[0].recursive` 含 `{ tree: true, maxDepth: 3, ... }`。

### 3.6 示例 E：多分支数据网（`build` 回调 → `branches`）

函数式：

```typescript
const net = await client
  .model('Order')
  .query()
  .relate('lines', (sub) => sub.relate('product').group('tags'))
  .execute({ includeRelates: true });
```

JSON 中 `hops[0].branches` 为嵌套 hop 数组（由 `getRemoteExecuteSnapshot()` 序列化）。

### 3.7 分页结果

当 `execute.limit` 设置且命中分页路径时，响应为：

```json
{
  "kind": "paginated",
  "page": 0,
  "total": 42,
  "limit": 10,
  "pageCount": 5,
  "items": { "kind": "rows", "rows": [ ... ] }
}
```

---

## 4. 写入 / 元数据 / 绑定（database 作用域）

| `op`                                 | 用途                     | 函数式等价                             |
| ------------------------------------ | ------------------------ | -------------------------------------- |
| `insert`                             | 插入单行                 | `engine.insert(model, data)`           |
| `update`                             | 更新单行                 | `engine.update(model, id, partial)`    |
| `insertMany`                         | 批量插入                 | `engine.model(model).insertMany(rows)` |
| `batchUpdate`                        | 批量更新                 | 循环 `update`                          |
| `registerModel` / `registerRelation` | 注册模型/关系            | `registerModel` / `registerRelation`   |
| `batchRegister`                      | 批量 DDL                 | 组合注册                               |
| `alterModel`                         | Schema 变更              | `alterModel` / `alterModelPatch`       |
| `dropModel` / `dropRelation`         | 删除模型/关系定义        | `dropModel` / `dropRelation`           |
| `bind` / `bindPair` / `unlinkPair`   | 关系绑定                 | `bind` / 手动 pair                     |
| **`bindImportLookup`**               | **导入后二阶段关系绑定** | 按对端字段 lookup 后 bind              |
| `previewBind` / `relationStats`      | 只读预览/统计            | —                                      |
| **`clearModelData`**                 | **清除单模型全部行数据** | `clearModelData(model)`                |
| **`clearAllData`**                   | **清除库内全部行数据**   | `clearAllData()`                       |
| `executeQuery`                       | 查询                     | `query().execute()`                    |

### 4.1 数据清除（与 drop 的区别）

- **`clearModelData` / `clearAllData`**：**仅清除行数据**（软删除 tombstone + 清空相关关系索引）；**模型/关系 schema 保留**。
- **`dropModel`**：逻辑删除模型定义及关系索引；物理 payload 可能暂留 Vault 待 compact。

**单模型清除：**

```typescript
// 函数式
const deletedCount = await client.clearModelData('Country');

// JSON
const result = await client.apply({ op: 'clearModelData', model: 'Country' });
// { kind: 'mutation', op: 'clearModelData', model: 'Country', ok: true, deletedCount: 12 }
```

**全库清除：**

```typescript
const { totalDeleted, perModel } = await client.clearAllData();

// JSON
const result = await client.apply({ op: 'clearAllData' });
// { kind: 'mutation', op: 'clearAllData', ok: true, deletedCount: 50, perModel: { Country: 2, City: 48 } }
```

### 4.2 导入关系绑定：`bindImportLookup`

`bindImportLookup` 用于 CSV / 批量导入后的二阶段关系绑定：

1. 先执行 `insertMany` 或 upsert `insertMany`。
2. 从插入结果中读取导入行 `_id`。
3. 用导入时暂存的 join value 去对端模型字段 lookup。
4. 将导入行和对端行写入关系索引。

关键字段：

- `forward` / `reverse`：关系正逆向名称。
- `importModel`：本次导入的模型。
- `peerModel`：被 lookup 的对端模型。
- `importSide`：自关联时说明导入行位于 `source` 还是 `target`，默认 `target`。
- `peerMatchField` / `peerMatchFieldType`：对端匹配字段和类型。
- `pairs`：`{ importedId, lookupValue }[]`。

注意：

- 关系名是端点局部唯一，执行端必须同时校验 `importModel` 和 `peerModel` 是否为关系端点。
- 直接自环 `sourceId === targetId` 默认被 `selfLoopPolicy: 'deny'` 跳过；只有关系显式 `allow` 才写入。
- 修改该 op 时必须同步检查 `@mode-db/data-kit`、`@mode-db/shared`、`@mode-db/core`、`@mode-db/server` 和 `@mode-db/sdk`。

---

## 5. 工作区操作（workspace 作用域）

```typescript
await modeldb.apply({ op: 'createDatabase', name: 'demo' });
await modeldb.apply({ op: 'listDatabases' }); // → { kind: 'databases', databases: [...] }
await modeldb.apply({ op: 'catalog', database: 'demo' });
await modeldb.apply({ op: 'dropDatabase', name: 'demo' });
```

---

## 6. 批量与错误

```typescript
const outcomes = await client.applyAll(
  [
    { op: 'insert', model: 'A', data: { id: '1' } },
    { op: 'insert', model: 'B', data: { id: '2' } },
  ],
  { failFast: false }, // 默认 true：首条失败即停止
);
// [{ ok: true, result: {...} }, { ok: false, error: '...' }]
```

结构校验：`assertEngineOperation(json)` / `isEngineOperation(json)`。

---

## 7. 相关文档

- [engine-meta-crud-and-wire.md](./engine-meta-crud-and-wire.md) — DDL wire RPC、`dropModel` 等
- [developer-handbook.md](./developer-handbook.md) — AuthoringEngine 全量 API
- [packages/sdk/README.md](../packages/sdk/README.md) — SDK 连接与示例

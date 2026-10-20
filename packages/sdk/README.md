# `@mode-db/sdk`

ModelDB **远程客户端**：通过 WebSocket 连接 **`@mode-db/server`**，提供链式查询、Meta-DDL、数据变更与 **`EngineOperation` JSON** 入口。**不**内置、也**不得**在 SDK 内启动服务端——须单独运行 **`modeldb-server start`**。

## 文档导航

- 模块说明文档：[`docs/module-overview.md`](./docs/module-overview.md)
- 操作手册：[`docs/operation-manual.md`](./docs/operation-manual.md)
- 开发手册：[`docs/developer-handbook.md`](./docs/developer-handbook.md)
- 模块级 AI 协作约束：[`AGENTS.md`](./AGENTS.md)
- 面向后续 AI 的上下文资料：[`../../.agents/sdk/`](../../.agents/sdk/)

实现依赖 **`@mode-db/shared`**（线协议与编解码），**不**依赖 **`@mode-db/core`** 源码，可在 **浏览器与 Node** 共用。

## 模块用途

| 能力     | 说明                                                                                        |
| -------- | ------------------------------------------------------------------------------------------- |
| **连接** | `connectRemote`、`RemoteModelDBClient.connect`、`ModelDB` 门面                              |
| **查询** | `model(name).query().filter(...).execute()`                                                 |
| **接口** | `invokeQueryInterface` / `invokeOperationInterface` / `invokeBindingSurface` 调用已发布接口 |
| **变更** | `insertMany`、`batchUpdate`、`batchDelete`、`bind`                                          |
| **Meta** | `registerModel`、`dropModel`、`alterModel`、`batchRegister`                                 |
| **协议** | `apply(op)` / `applyAll(ops)` — 与 Designer JSON 配置同源                                   |
| **管理** | `listDatabases`、`getManagementStatus`（静态方法）                                          |

### 备份文件迁移

```typescript
const created = await db.createBackup('Asset_Graph', 'manual', '发布前快照');
// created.name is the optional display name; created.fileName is the safe server identifier.
const backups = await db.listBackups('Asset_Graph');
const file = await db.downloadBackup(backups[0].fileName);

// 浏览器中可将 Blob 下载到本地，也可以在目标服务器重新导入。
const imported = await targetDb.importBackup('asset-transfer.modeldb-backup.json', file);
await targetDb.restoreBackup('Asset_Graph_Copy', imported.fileName);
```

`downloadBackup` 返回原始备份 `Blob`，`importBackup` 会把经过服务端校验的文件放入目标服务器的 `modeldb/backups/` 目录。
可选备份名称会随创建、列表、下载、导入和恢复保留，旧备份仍兼容。名称支持 1-120 个字符（去除首尾空白后计算），不允许控制字符。

## 安装与构建

```bash
pnpm install
pnpm run build:sdk
# 或
pnpm run build
```

## 使用说明

### 连接逻辑库

```typescript
import { connectRemote } from '@mode-db/sdk';

const client = await connectRemote({
  url: 'ws://127.0.0.1:9090',
  connectToken: '与 modeldb.config.json 一致',
  dbName: 'Asset_Graph', // 逻辑库名，非物理 dbPath
});

const rows = await client.model('Country').query().execute();
client.close();
```

**禁止**使用物理路径 `dbPath` 绑定生产数据；须用 **`workspaceName` / `dbName`** 与握手 token（见仓库 `.cursorrules`）。

### ModelDB 门面（多库缓存）

```typescript
import { ModelDB } from '@mode-db/sdk';

const db = new ModelDB({ host: '127.0.0.1', port: 9090, token: '...' });
const session = await db.connect('Asset_Graph');
await session.model('Country').query().execute();
```

### Meta-DDL（Model Designer / 治理）

```typescript
await client.batchRegister({
  models: [{ name: 'Pipe', schema: { diameter: 'Float64' } }],
  relations: [
    {
      source: 'Pipe',
      target: 'Station',
      forward: 'pipe_at',
      reverse: 'station_has',
      logic: 'many-to-many',
    },
  ],
  quickLink: true,
});

await client.alterModel('Pipe', { note: 'String' }, { patch: true });
await client.dropModel('Old_Pipe_Version');
await client.dropRelation('owns');
```

### JSON 引擎操作

```typescript
import type { EngineOperation } from '@mode-db/shared';

const op: EngineOperation = { op: 'clearModelData', model: 'Country' };
await client.apply(op);
```

### 调用已发布查询接口

Query Designer 发布的 active release 可通过调用名、版本和参数直接执行。调用方不需要了解底层模型关系或 wire query plan。

```typescript
const first = await client.invokeQueryInterface('itemsByCategory', {
  version: '1.0.0',
  parameters: { category: 'A' },
  accessKey: '接口启用专属密钥策略时提供',
  cursor: null,
  limit: 20,
});

if (first.nextCursor) {
  const second = await client.invokeQueryInterface('itemsByCategory', {
    version: '1.0.0',
    parameters: { category: 'A' },
    cursor: first.nextCursor,
    limit: 20,
  });
}
```

返回值的 `rows` 已按接口输出契约完成字段筛选和重命名，并包含 `version`、`callableName` 以及适用的分页元数据。

如果调用方不希望安装 SDK，也可以使用服务端提供的普通 JSON HTTP 入口。它仍然只执行已发布的 active release，并保留版本、参数、访问密钥、限流和审计规则：

```bash
curl -X POST "http://127.0.0.1:9091/api/v1/databases/railway_domain_v1/query-interfaces/itemsByCategory" \
  -H "Content-Type: application/json" \
  -H "X-ModelDB-Connect-Token: <CONNECT_TOKEN>" \
  -d '{
    "version": "1.0.0",
    "parameters": { "category": "A" },
    "accessKey": "<ACCESS_KEY>"
  }'
```

HTTP 返回与 SDK 的 `invokeQueryInterface` 相同的接口结果 JSON；调用地址中的数据库名和 callable name 应使用 URL 编码。

调用失败时可以通过结构化异常稳定判断错误类型，不需要解析错误文本：

```typescript
import { QueryInterfaceInvocationError } from '@mode-db/sdk';

try {
  await client.invokeQueryInterface('itemsByCategory', {
    parameters: { category: 'A' },
  });
} catch (error) {
  if (error instanceof QueryInterfaceInvocationError) {
    console.log(error.code, error.category, error.retryable, error.details);
  }
}
```

接口触发固定窗口限流时，异常 `code` 为 `INTERFACE_RATE_LIMITED`、`category` 为 `rate_limited`、`retryable` 为 `true`，并通过 `details.retryAfterSeconds` 告知建议重试等待时间。

### 调用已发布写接口

OperationInterface 使用独立的 mutation 调用入口。调用方只提交发布契约中的参数，不能直接传入底层 Engine operation。

```typescript
const created = await client.invokeOperationInterface('createItem', {
  version: '1.0.0',
  parameters: { name: 'First item', score: 7 },
  accessKey: '接口启用专属密钥策略时提供',
});

console.log(created.operation, created.output);
```

当前发布执行链支持单记录 `create / update / delete / upsert` 和单关系对
`bind / unbind / rebind`。Server 会在参数校验、访问策略和限流通过后，通过写串行门执行已固化的
`insert / update / delete / bindPair / unlinkPair / rebindPair` 模板，并返回 `operationInterface`
结果。`upsert` 通过显式匹配字段编译为单行 `insertMany + upsert.matchFields + returning`；
`rebind` 保持 source 不变，将 `previousTargetId` 替换为 `nextTargetId`，新边建立失败时恢复旧边。
batch 接口通过 `parameters.items` 接收同构参数对象数组，支持失败后继续或首错停止。返回值包含
`success / partial / failed` 状态、请求/尝试/成功/失败/跳过计数和可选逐项结果。batch 当前非原子，
成功项会独立提交；声明跨项回滚的发布模板会被拒绝。损坏或未知操作模板仍会在执行前被拒绝。

### 调用已发布 BindingSurface

BindingSurface 将固定版本的查询接口和写接口组合为一个稳定入口。读取时只提交 Surface 参数；写入时提交发布契约中的 mutation id，以及该 UI 行的记录引用、当前行值和编辑值。

```typescript
const read = await client.invokeBindingSurface('item-editor', {
  version: '1.0.0',
  parameters: { category: 'A' },
  accessKeys: {
    'query-items': 'query-access-key',
    'operation-update-item': 'operation-access-key',
  },
  action: { kind: 'read', limit: 20 },
});

const updated = await client.invokeBindingSurface('item-editor', {
  version: '1.0.0',
  parameters: { category: 'A' },
  action: {
    kind: 'mutate',
    mutationId: 'update-name',
    editedValue: 'Updated name',
    row: read.query?.rows[0],
    recordRefs: {
      node_item: { model: 'Item', id: 'item-id' },
    },
  },
});
```

`accessKeys` 可以接口 id 或 callable name 为键，服务端只把对应密钥传给相应固定版本接口。`status === 'refreshFailed'` 表示 mutation 已成功提交、仅自动刷新失败；此时应单独重新读取，不能重试 mutation。

### 浏览器说明

- 字节与 UTF-8 使用 **`Uint8Array`**、`TextEncoder` / `TextDecoder`
- 不使用 Node **`Buffer`** 全局
- **`apps/web`** 演练场可直接 import 本包

## 用户手册

### 启动顺序

1. 构建：`pnpm run build`
2. 启动服务：`pnpm run start:server -- -c modeldb.config.json`
3. 应用中 `connectRemote` 或打开 **`apps/web`**

详见 **[user-handbook.md](../../docs/user-handbook.md)**。

### 连接参数

| 参数                  | 说明                                  |
| --------------------- | ------------------------------------- |
| `url` / `host`+`port` | WebSocket 地址                        |
| `connectToken`        | 与服务器配置一致，否则握手失败        |
| `dbName`              | 逻辑库名（workspace 内 atlas 目录名） |

### 错误与诊断

- 网络/编解码错误应捕获异常消息（含 HTTP/WS 状态摘要）
- 未完成 `connect` 前勿调用会话方法（SDK 内部有异步守卫）

### 与 server / core 的关系

```
应用 (Designer, web, 脚本)
        ↓ @mode-db/sdk
   WebSocket + 线协议 (@mode-db/shared)
        ↓ @mode-db/server
   AuthoringEngine + Query (@mode-db/core)
        ↓
      atlas.mld
```

### 相关文档

| 文档                                                                    | 内容                                   |
| ----------------------------------------------------------------------- | -------------------------------------- |
| [operations-manual.md](../../docs/operations-manual.md)                 | 部署与 connectRemote 检查清单          |
| [engine-operation-protocol.md](../../docs/engine-operation-protocol.md) | `apply` 支持的全部 op                  |
| [developer-handbook.md](../../docs/developer-handbook.md)               | 查询链与 HydratedEntity 语义（引擎侧） |

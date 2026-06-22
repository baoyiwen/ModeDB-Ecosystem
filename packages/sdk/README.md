# `@mode-db/sdk`

ModelDB **远程客户端**：通过 WebSocket 连接 **`@mode-db/server`**，提供链式查询、Meta-DDL、数据变更与 **`EngineOperation` JSON** 入口。**不**内置、也**不得**在 SDK 内启动服务端——须单独运行 **`modeldb-server start`**。

实现依赖 **`@mode-db/shared`**（线协议与编解码），**不**依赖 **`@mode-db/core`** 源码，可在 **浏览器与 Node** 共用。

## 模块用途

| 能力     | 说明                                                           |
| -------- | -------------------------------------------------------------- |
| **连接** | `connectRemote`、`RemoteModelDBClient.connect`、`ModelDB` 门面 |
| **查询** | `model(name).query().filter(...).execute()`                    |
| **变更** | `insertMany`、`batchUpdate`、`batchDelete`、`bind`             |
| **Meta** | `registerModel`、`dropModel`、`alterModel`、`batchRegister`    |
| **协议** | `apply(op)` / `applyAll(ops)` — 与 Designer JSON 配置同源      |
| **管理** | `listDatabases`、`getManagementStatus`（静态方法）             |

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

# `@mode-db/shared`

ModelDB 的**协议与传输层**：WebSocket 线协议类型、二进制帧编解码、远程查询计划 AST、统一引擎操作 JSON（`EngineOperation`）。**不依赖** monorepo 内其它 workspace 包，可被浏览器与 Node 共用。

## 模块用途

| 能力             | 说明                                                             |
| ---------------- | ---------------------------------------------------------------- |
| **Wire 协议**    | `WireExecuteBody`、`WireExecuteResultJson` — RPC 请求/响应形状   |
| **传输编解码**   | `encodeWirePayload` / `decodeWirePayload`、外层 `MDBX` 帧        |
| **引擎操作协议** | `EngineOperation`、`apply` / `applyAll` 用的 JSON 判别式联合类型 |
| **远程查询计划** | `WireQueryChain`、谓词/聚合序列化，供 SDK 把链式查询发到服务端   |
| **管理面类型**   | `ManagementCatalogResponse`、`ManagementDatabaseInfo` 等         |

**消费者**：`@mode-db/sdk`（客户端）、`@mode-db/server`（服务端分发）、`@mode-db/common` / `@mode-db/core`（共享类型引用）。

## 安装与构建

Monorepo 内为 workspace 依赖，无需单独发布安装：

```bash
pnpm install
pnpm run build:shared
```

产物：`packages/shared/dist/`。

## 使用说明

### 1. 引擎操作 JSON（Designer / 自动化脚本）

```typescript
import type { EngineOperation } from '@mode-db/shared';
import { isEngineOperation, operationScope } from '@mode-db/shared';

const op: EngineOperation = {
  op: 'executeQuery',
  snapshot: {
    /* 远程查询快照 */
  },
};

if (isEngineOperation(op) && operationScope(op) === 'database') {
  // 经 SDK RemoteModelDBClient.apply(op) 发送
}
```

完整 op 列表见仓库 **[docs/engine-operation-protocol.md](../../docs/engine-operation-protocol.md)**。

### 2. 线载荷编解码（高级 / 自定义传输）

```typescript
import { deriveWireSessionKey, encodeWirePayload, decodeWirePayload } from '@mode-db/shared';

const key = deriveWireSessionKey(connectToken, handshakeNonce);
const cipher = encodeWirePayload(key, { op: 'listDatabases' });
const plain = decodeWirePayload(key, cipher);
```

### 3. 管理面响应类型

```typescript
import type { ManagementCatalogResponse } from '@mode-db/shared';
```

用于解析 `catalog` 工作区操作或 HTTP 管理 API 的 JSON。

## 用户手册

### 何时直接使用本包

- 实现**自定义客户端/网关**，需与 ModelDB 线协议对齐
- 编写**不依赖 `@mode-db/core` 源码**的协议测试或 codegen
- 在浏览器侧解析/构造 `EngineOperation` JSON

### 何时不要直接用

- **业务应用**请优先 **`@mode-db/sdk`**（已封装握手、重连、查询链）
- **进程内读写引擎**请用 **`@mode-db/core`**（AuthoringEngine / ModelDBClient）

### 相关文档

| 文档                                                                    | 内容                        |
| ----------------------------------------------------------------------- | --------------------------- |
| [engine-operation-protocol.md](../../docs/engine-operation-protocol.md) | 全部 `EngineOperation` 语义 |
| [user-handbook.md](../../docs/user-handbook.md)                         | 仓库安装、构建、启动服务    |
| [developer-handbook.md](../../docs/developer-handbook.md)               | 引擎与 SDK API 索引         |

### 目录结构

| 路径                           | 说明                   |
| ------------------------------ | ---------------------- |
| `src/wire-protocol-exports.ts` | RPC body / result 类型 |
| `src/wire-codec.ts`            | 会话密钥与载荷 XOR     |
| `src/binary-transport.ts`      | 外层二进制帧           |
| `src/engine-operations.ts`     | 统一操作协议与守卫     |
| `src/wire-query-plan.ts`       | 远程查询计划编译       |

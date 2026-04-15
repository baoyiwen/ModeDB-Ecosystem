# @mode-db/sdk

**远程客户端**：仅通过 **`connectRemote`** / **`RemoteModelDBClient.connect`** / **`ModelDBClient.connect`**（网络）与 **`@mode-db/server`** 托管的进程通信。**不包含**、也**不得**依赖 **`ModelDBServer`** 或任何在 SDK 内启动监听端口的逻辑——服务由运维单独执行 **`modeldb-server start`**（见根 README）。

实现上依赖 **`@mode-db/shared`**（线协议、**`encodeWirePayload`** 混淆载荷、**`WireExecuteBody`**），**不**依赖 **`@mode-db/core`** 源码树。

## 构建

在 monorepo 根目录：

```bash
npm run build
npm run build:sdk
```

## 查询

```typescript
import { connectRemote } from '@mode-db/sdk';

const db = await connectRemote({
  url: 'ws://127.0.0.1:9090',
  connectToken: '与服务器一致',
  dbName: 'Asset_Graph',
});

const rows = await db.model('YourModel').query().execute();
db.close();
```

## Meta-DDL（Model Designer）

在已握手的 **`RemoteModelDBClient`** 上（与根引擎 **`AuthoringEngine`** 对齐的 RPC）：

- **`await client.dropModel('Old_Pipe_Version')`** → 线载荷经 **`cipher`** 发送，服务端执行物理删除 / orphan。
- **`await client.dropRelation('owns')`**
- **`await client.alterModel('Pipe', { note: { type: 'String', required: false } }, { patch: true })`** → 增量 schema（**`patch: true`** 走 **`alterModelPatch`**）；省略第三参则与全量 **`alterModel`** 一致。

在 **Node** 下未传入 **`webSocketCtor`** 时，本包**优先使用 `ws`**，避免与基于 **`ws`** 的服务端不兼容。

更多说明见仓库根 **[README.md](../../README.md)**（网络服务、**`dbName`**、安全边界）。

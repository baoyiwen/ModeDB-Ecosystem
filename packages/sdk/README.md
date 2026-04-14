# @mode-db/sdk

Mode DB / ModelDB 的 **远程客户端**：通过 WebSocket（或 **`mode: 'short'`** 的 HTTP）与 **ModelDB WebSocket Server**（由 **`@mode-db/server`** + 仓库根引擎运行时托管）通信。链式查询 API 与本地 **`ModelDBClient`** 用法相近（**`await model.query()…execute()`**），但实现上仅依赖 **`@mode-db/shared`**，**不**依赖 **`mode-db-engine`** npm 包。

完整说明、服务端 CLI、配置与安全边界见仓库根目录 **[README.md](../../README.md)** 中的 **「网络服务与远程客户端 SDK」** 一节（含 **`RemoteRuntimeModel`** 与进程内 **`RuntimeModel`** 的差异说明）。

## 构建

在 monorepo 根目录：

```bash
npm run build
npm run build:sdk
```

## 使用

```typescript
import { connectRemote } from '@mode-db/sdk';

const db = await connectRemote({
  url: 'ws://127.0.0.1:9090',
  connectToken: '与服务器一致',
  atlas: 'your_atlas',
});

const rows = await db.model('YourModel').query().execute();
db.close();
```

在 **Node** 下未传入 **`webSocketCtor`** 时，本包 **始终使用 `ws`**，而不会使用 Node 自带的 **`globalThis.WebSocket`**，以便与基于 **`ws`** 的服务端稳定互操作。

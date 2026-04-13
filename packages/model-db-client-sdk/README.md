# @mode-db/model-db-client-sdk

Mode DB / ModelDB 的 **远程只读客户端**：通过 WebSocket 与 **`mode-db-engine`** 自带的 **`ModelDB WebSocket Server`** 通信，链式 API 与本地 **`ModelDBClient`** 一致（**`await model.query()…execute()`**）。

完整说明、服务端 CLI、配置与安全边界见仓库根目录 **[README.md](../../README.md)** 中的 **「网络服务与远程客户端 SDK」** 一节。

## 构建

在 monorepo 根目录：

```bash
npm run build
npm run build:sdk
```

## 使用

```typescript
import { connectRemote } from '@mode-db/model-db-client-sdk';

const db = await connectRemote({
  url: 'ws://127.0.0.1:8787',
  connectToken: '与服务器一致',
  atlas: 'your_atlas',
});

const rows = await db.model('YourModel').query().execute();
db.close();
```

发布到 npm 前，请将 **`package.json`** 中的 **`dependencies.mode-db-engine`** 从 **`file:../..`** 改为与注册表一致的 **`^x.y.z`** 范围。

在 **Node** 下未传入 **`webSocketCtor`** 时，本包 **始终使用 `ws`**，而不会使用 Node 自带的 **`globalThis.WebSocket`**，以便与 **`mode-db-engine`** 自带的 **`ws` 服务端** 稳定互操作。

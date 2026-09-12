# Data Studio

`apps/data-studio` 是一个运行在浏览器中的数据工作台与组件演练场，用来把：

- `@mode-db/sdk` 的远程连接能力
- `@mode-db/data-kit` 的无头数据绑定能力
- `@mode-db/data-ui` 的表格 / 透视 / 导入组件

串成一个可以直接连接新版 engine 的前端模块。

它不是业务后台，也不是本地引擎宿主；所有真实数据读写都通过远程 `RemoteModelDBClient` 发往 `@mode-db/server`。

## 文档导航

- 模块说明文档：[`docs/module-overview.md`](./docs/module-overview.md)
- 操作手册：[`docs/operation-manual.md`](./docs/operation-manual.md)
- 开发手册：[`docs/developer-handbook.md`](./docs/developer-handbook.md)
- 模块级 AI 协作约束：[`AGENTS.md`](./AGENTS.md)
- 面向后续 AI 的上下文资料：[`../../.agents/data-studio/`](../../.agents/data-studio/)

## 本地运行

```bash
pnpm --filter data-studio dev
# 或
pnpm dev:data-studio
```

Dev server 已绑定 `host: true`，终端会同时打印 **Local**（`http://localhost:5176/`）与 **Network**（`http://<局域网 IP>:5176/`）地址，便于其它设备访问。跨设备连接引擎时，连接页主机需填开发机局域网 IP（而非 `127.0.0.1`），或用 `VITE_MODE_DB_HOST` 指定默认主机；引擎 server 用 `pnpm start:server:network` 监听局域网。详见 [`docs/operation-manual.md`](./docs/operation-manual.md) §2–§3。

## 构建

```bash
pnpm --filter data-studio build
```

## 类型检查

```bash
pnpm --filter data-studio typecheck
```

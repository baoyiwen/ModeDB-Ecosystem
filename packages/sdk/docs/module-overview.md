# `@mode-db/sdk` 模块说明

`@mode-db/sdk` 是新版 engine 的远程客户端包，负责：

- 远程连接
- 管理面访问
- 远程查询链
- 远程 DDL / CRUD / bind
- `apply` / `applyAll`

它依赖 `@mode-db/shared`，但不依赖 `core` 或 `server`。

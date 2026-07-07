# `@mode-db/sdk` 模块说明

`@mode-db/sdk` 是新版 engine 的远程客户端包，负责：

- 远程连接
- 管理面访问
- 远程查询链
- 远程 DDL / CRUD / bind
- `apply` / `applyAll`
- management catalog 与数据库展示名 / 字段标签
- 备份、恢复、清除和强制重置管理 API

它依赖 `@mode-db/shared`，但不依赖 `core` 或 `server`。

常用管理面方法：

- `ModelDB.listBackups(database?)`
- `ModelDB.createBackup(database, reason?)`
- `ModelDB.restoreBackup(database, backupFile)`
- `ModelDB.clearDatabaseData(database, { forceReset? })`

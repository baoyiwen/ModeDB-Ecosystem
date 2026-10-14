# `@mode-db/server` 模块说明

`@mode-db/server` 是新版 engine 的网络服务层，负责：

- CLI 启动。
- 配置加载。
- HTTP 管理面。
- WebSocket / HTTP RPC。
- 写串行化。
- 逻辑库与引擎会话桥接。
- 数据备份、恢复、清除与可选自动备份调度。

## 核心模块

- `src/modeldb-server.ts`：服务启动入口。
- `src/dual-track-app.ts`：Fastify HTTP + WebSocket 组合、管理 API 路由。
- `src/request-dispatcher.ts`：线协议 RPC 分发。
- `src/authoring-bridge.ts`：逻辑库到 `AuthoringEngine` 的缓存桥接；引擎在 server 生命周期内常驻，只在恢复、清除、强制重置、删除库等管理操作后通过 `evict` 重建。
- `src/write-serialization-gate.ts`：写请求串行化门闩。
- `src/config-loader.ts`：`modeldb.config.json` 加载与合并。

## Management catalog

`src/dual-track-app.ts` 暴露的 catalog 是前端显示名和导入关系绑定的关键来源。当前 catalog 需要覆盖：

- 数据库和模型显示名：`displayName`
- 字段显示名：`fieldLabels`
- 字段类型：`fieldTypes`
- 关系端点、正逆向名称、显示名、自环策略：`selfLoopPolicy`

这些字段由 SDK 原样透传给 web / data-studio / model-designer。不要在 server 端按当前语言裁剪 i18n map。

## 备份相关模块

- `src/backup-manager.ts`：本地备份文件的创建、枚举、恢复、强制重置。
- `src/auto-backup-scheduler.ts`：根据 `modeldb.config.json` 的 `autoBackup` 配置定时备份。
- `src/cli-backup.ts`：`modeldb-server backup/backups/restore/clear-data/force-reset` 命令。
- `src/dual-track-app.ts`：HTTP Management API 暴露 `/api/v1/management/backups` 与数据库级 backup/restore/clear 路由。

备份文件位于 `<workspace>/modeldb/backups/`，格式为 `modeldb.backup.v1` JSON，内部按 base64 保存目标逻辑库的 vault 文件。

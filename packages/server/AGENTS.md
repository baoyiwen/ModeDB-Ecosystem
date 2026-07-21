# Server Agent Rules

## 1. 模块边界

- `@mode-db/server` 负责传输、配置、调度。
- 真实引擎行为由 `core` 执行。

## 2. 核心入口

- `src/modeldb-server.ts`
- `src/dual-track-app.ts`
- `src/request-dispatcher.ts`
- `src/authoring-bridge.ts`
- `src/write-serialization-gate.ts`

## 3. 修改后检查

- 写请求是否仍经过 gate
- 管理面和 database RPC 是否仍清晰分离
- 是否与 `shared` / `sdk` 协议一致
- catalog 是否完整返回 `displayName`、`fieldLabels`、`fieldTypes`、`selfLoopPolicy`
- 是否避免把唯一名当显示名写回 catalog

## 4. 备份 / 恢复规则

- 备份、恢复、清除数据、强制重置属于 management plane，不属于普通 database RPC。
- 关键文件：`src/backup-manager.ts`、`src/auto-backup-scheduler.ts`、`src/cli-backup.ts`、`src/config-loader.ts`、`src/dual-track-app.ts`。
- 备份文件写入 `<workspace>/modeldb/backups/`。
- `restore` / `clear-data` / `force-reset` 前应尽量创建安全备份。
- 外部备份迁移通过 management download/import API；导入必须验证 payload 与每个相对路径，禁止覆盖已有备份文件。
- `force-reset` 是损坏恢复后门，可在库文件缺失时重建；普通 `clear-data` 仍应要求库存在。
- 自动备份默认关闭；仅 `autoBackup.enabled === true` 且间隔不小于 `60000ms` 时启动。
- 破坏性 CLI 必须要求 `--yes`。

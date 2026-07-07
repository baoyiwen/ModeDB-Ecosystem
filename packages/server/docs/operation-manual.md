# `@mode-db/server` 操作手册

## 1. 启动

```bash
pnpm run build:server
pnpm run start:server -- -c modeldb.config.json
```

常用 CLI：

```bash
modeldb-server start -c modeldb.config.json
modeldb-server info -c modeldb.config.json
modeldb-server ls -c modeldb.config.json
modeldb-server create-db <db-name> -c modeldb.config.json
```

## 2. 常见职责

- 列出逻辑库。
- 提供 catalog。
- 接收 SDK 查询与 mutation。
- 串行执行写请求。
- 提供数据库备份、恢复、清除与强制重置入口。
- 根据配置执行可选自动备份。

## 3. 数据备份、恢复与清除

服务端支持两类备份：

- **主动备份**：由 CLI、HTTP Management API、SDK 或前端入口触发。
- **自动备份**：仅当 `modeldb.config.json` 配置 `autoBackup.enabled: true` 时启用；不配置或 `enabled: false` 时不会自动备份。

备份文件统一写入逻辑库 workspace 下的：

```text
<workspace>/modeldb/backups/*.modeldb-backup.json
```

常用 CLI：

```bash
modeldb-server backup <db-name> --reason manual
modeldb-server backups [db-name]
modeldb-server restore <db-name> <backup-file> --yes
modeldb-server clear-data <db-name> --yes
modeldb-server force-reset <db-name> --yes
```

说明：

- `restore`、`clear-data`、`force-reset` 是破坏性操作，必须显式传 `--yes`。
- `restore` 前会尽量创建 `pre-restore` 安全备份。
- `clear-data` 前会尽量创建 `pre-clear` 安全备份。
- `force-reset` 前会尽量创建 `pre-reset` 安全备份；该命令用于数据库文件损坏、普通引擎打开失败时的后门重建。

## 4. 自动备份配置

```json
{
  "autoBackup": {
    "enabled": true,
    "intervalMinutes": 60,
    "runOnStart": false,
    "reason": "auto",
    "databases": ["Test_DB"]
  }
}
```

- `databases` 为空或省略时表示备份所有逻辑库。
- `intervalMs` 也可使用，且优先于 `intervalMinutes`。
- 最小间隔为 `60000` ms，避免过短周期打爆磁盘。
- 自动备份只在 server 进程运行期间生效。

## 5. 排查重点

- 配置是否加载正确。
- 端口与 token 是否正确。
- WebSocket 与管理面是否都可用。
- `workspace` 是否可写，且 `modeldb/backups/` 可创建。
- 自动备份没有执行时，先确认 `autoBackup.enabled` 是否为 `true`。

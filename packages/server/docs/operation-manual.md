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

**监听地址（host）**：默认绑定 **`127.0.0.1`**，仅本机可连。要让同一局域网内其它设备连接，用 **`--host 0.0.0.0`** 监听所有网卡：

```bash
modeldb-server start -c modeldb.config.json --host 0.0.0.0
# 仓库根等价脚本：
pnpm run start:server:network
```

启动成功后，控制台会按 `Local: http://localhost:<port>/`、`Network: http://<网卡 IP>:<port>/` 的形式打印本机和每个可用网卡地址，并继续打印完整 **HTTP**、**`/health`**、管理状态、**WebSocket** 和 **`/v2/stream`** 地址，以及 `info`、`ls`、`create-db`、`backup` 等常用命令。`0.0.0.0` 只表示监听所有网卡，不能直接作为客户端地址；跨机器连接时应使用控制台列出的 IP、hostname 或配置的 `advertisedHost`。如果接口位于反向代理后面，则配置 `publicBaseUrl` 为代理的 `https://` 地址。

如果机器有固定域名或外部可达地址，可在配置中指定展示地址：

```json
{
  "host": "0.0.0.0",
  "advertisedHost": "db.example.com",
  "publicBaseUrl": "https://api.example.com"
}
```

也可以临时使用 `--advertised-host db.example.com --public-base-url https://api.example.com`。`advertisedHost` 只决定控制台展示的主机名，`publicBaseUrl` 只决定公开 API 文档地址；两者都不会创建网络路由。

局域网访问需放行防火墙对应端口；**公网**必须置于 **TLS 反向代理（WSS）** 之后，不要以明文 `ws://` 暴露到公网。

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

Management API 还支持浏览器/SDK 迁移文件：

- `GET /api/v1/management/backups/:backupFile/download`：下载原始备份文件。
- `POST /api/v1/management/backups/import?fileName=...`：以 `application/octet-stream` 上传备份文件。
- 上传时会验证备份版本、数据库名、创建时间、文件条目和相对路径；同名文件不会覆盖已有备份。
- 导入只把文件加入备份目录，实际替换数据库仍通过 restore API 完成并创建安全备份。

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

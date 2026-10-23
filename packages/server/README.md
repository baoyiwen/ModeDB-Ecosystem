# `@mode-db/server`

ModelDB **网络服务进程**：WebSocket + HTTP 管理面、线协议分发、写串行化门闩、CLI（`modeldb-server`）。将客户端 RPC 委托给 **`@mode-db/core`** 的 `AuthoringEngine` 与查询运行时。

## 文档导航

- 模块说明文档：[`docs/module-overview.md`](./docs/module-overview.md)
- 操作手册：[`docs/operation-manual.md`](./docs/operation-manual.md)
- 开发手册：[`docs/developer-handbook.md`](./docs/developer-handbook.md)
- 模块级 AI 协作约束：[`AGENTS.md`](./AGENTS.md)
- 面向后续 AI 的上下文资料：[`../../.agents/server/`](../../.agents/server/)

## 模块用途

| 能力               | 说明                                                 |
| ------------------ | ---------------------------------------------------- |
| **WebSocket 服务** | 握手、`connectToken`、按逻辑库（`dbName`）绑定 Atlas |
| **RPC 分发**       | `WireRequestDispatcher` → `executeDatabaseOperation` |
| **管理 HTTP**      | 库列表、catalog、健康检查（Dual-track Fastify）      |
| **CLI**            | `modeldb-server start`、`create-db`、配置路径解析    |
| **安全传输**       | 二进制帧、载荷混淆（`@mode-db/shared`）              |

**不包含**浏览器 SDK；客户端见 **`@mode-db/sdk`**。

## 安装与构建

```bash
pnpm install
pnpm run build:server
```

`prebuild` 会自动构建 `shared` → `common` → `core`。全局 CLI 入口：

```bash
pnpm run start:server -- -c modeldb.config.json
# 或
npx modeldb-server start -c modeldb.config.json
```

## 使用说明

### 启动服务（运维）

```bash
# 仓库根，使用配置文件
pnpm run start:server -- -c modeldb.config.json

# 指定端口与 token（示例，以 config 为准）
modeldb-server start -c ./modeldb.config.json --port 9090
```

启动成功后，控制台会打印完整的 HTTP、健康检查、管理状态和 WebSocket 地址。使用 `--host 0.0.0.0` 时会列出机器 hostname 与非回环网卡 IP，跨机器客户端应复制其中一个地址；未配置 `publicBaseUrl` 时，Query Designer 会自动复用其中一个非回环网卡地址生成接口调用地址。多网卡、VPN、容器或反向代理场景可在配置中加入 `publicBaseUrl`，或临时传入 `--public-base-url <url>` 指定稳定地址；它只影响展示和 API 文档，不改变监听。

配置项说明：**[modeldb-config-guide.md](../../docs/modeldb-config-guide.md)**。  
部署清单：**[operations-manual.md](../../docs/operations-manual.md)**。

### 程序化嵌入（高级）

```typescript
import { startModelDBWebSocketServer, loadModelDBServerConfig } from '@mode-db/server';

const config = await loadModelDBServerConfig({ configPath: 'modeldb.config.json' });
await startModelDBWebSocketServer(config);
```

### 客户端连接

服务启动后，应用通过 **`@mode-db/sdk`** 连接：

```typescript
import { connectRemote } from '@mode-db/sdk';

const db = await connectRemote({
  url: 'ws://127.0.0.1:9090',
  connectToken: '<与 server 配置一致>',
  dbName: 'YourLogicalLibrary',
});
```

## 用户手册

### 典型工作流

1. 复制根目录 **`modeldb.config.example.json`** 到数据根并编辑 **`modeldb.config.json`**；需要逐项中文说明时参考 **`modeldb.config.example.jsonc`** 和 **[modeldb-config-guide.md](../../docs/modeldb-config-guide.md)**
2. **`pnpm run build`** 或至少 **`build:server`**
3. **`pnpm run start:server`**
4. 用 **`apps/web`** 演练场或 **`@mode-db/sdk`** 连接联调
5. 集成测试：**`pnpm run test:integration`**

### 写操作与并发

所有变更类 RPC（insert、batchUpdate、dropModel、bind 等）经 **`WriteSerializationGate`** 串行化，保证单库内一致性。读查询（`executeQuery`）可与写并发，具体以实现为准。

### 故障排查

| 现象         | 检查                                                   |
| ------------ | ------------------------------------------------------ |
| 握手失败     | `connectToken` 是否与 config 一致                      |
| 找不到库     | `dbName` 是否已在 workspace 注册；`create-db` 是否执行 |
| 改代码不生效 | 是否重新 **`build:server`** 并重启进程                 |
| 端口占用     | config 中 `port` / 环境变量                            |

### 包结构

| 路径                        | 说明                        |
| --------------------------- | --------------------------- |
| `src/modeldb-server.ts`     | WebSocket 服务入口          |
| `src/request-dispatcher.ts` | RPC → 引擎操作              |
| `src/dual-track-app.ts`     | HTTP + WS 组合              |
| `src/config-loader.ts`      | 配置文件加载                |
| `src/cli.ts`                | `modeldb-server` 可执行入口 |

### 相关文档

| 文档                                                                    | 内容                   |
| ----------------------------------------------------------------------- | ---------------------- |
| [user-handbook.md](../../docs/user-handbook.md)                         | 安装、构建、启动、排障 |
| [operations-manual.md](../../docs/operations-manual.md)                 | 生产部署               |
| [engine-operation-protocol.md](../../docs/engine-operation-protocol.md) | RPC 操作列表           |

## 数据备份与恢复

`@mode-db/server` 支持手动备份、恢复、清除数据、强制重置以及可选自动备份。备份文件写入当前逻辑库 workspace 下的 `modeldb/backups/`。S6.2 使用 `modeldb.backup.v2` 加密单库包，旧 JSON v1 明确拒绝并保留；Windows registry 离线 CLI 要求实例未运行且显式指定 `-c`。简介、权限、备份/独立恢复与接收方迁移步骤见[安全 V1 使用手册](../../docs/security-v1/user-guide.md)。

CLI：

```bash
modeldb-server backup <db-name> --reason manual -c <config>
modeldb-server backups [db-name] -c <config>
modeldb-server restore <db-name> <backup-file> --yes -c <config>
modeldb-server clear-data <db-name> --yes -c <config>
modeldb-server force-reset <db-name> --yes -c <config>
```

配置自动备份：

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

不配置 `autoBackup` 或设置 `enabled: false` 时不会自动备份。恢复已有库和 `clear-data` 要先成功创建安全备份；`force-reset` 仍允许损坏/缺失库时跳过失败备份。自动备份共用写入锁，刷盘或审计失败不报告成功。单个 Vault 最大 48 MiB、包最大 128 MiB；备份不包括访问台账和策略，独立灾备还需要最新密钥恢复材料及单独保管的口令。

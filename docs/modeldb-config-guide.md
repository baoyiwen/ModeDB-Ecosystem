# `modeldb.config.json` 配置指南（放置位置、数据根与磁盘路径）

本文说明 **`modeldb.config.json` 应如何写、放在哪、与「配置文件所在目录」和磁盘目录的关系**，并分别给出 **Windows、Linux、macOS** 下的推荐做法。实现以 **`packages/server/src/config-loader.ts`**、**`packages/server/src/modeldb-default-home.ts`** 与 **`modeldb-persisted-home.ts`**（**`set`** 持久路径）为准。

安全 V1：新生成的配置默认 `"security": { "version": 1 }`，不再生成 `connectToken`；已提供 Windows DPAPI/ACL、本机管理 CLI、限权 Bearer HTTP/WS、HTTPS/WSS、来源名单，以及三个前端的一次性配对、短期 HttpOnly Cookie、续期、注销和 CSRF。安全发布平台验收为 Windows，本文其他平台的目录示例不代表其已完成密钥适配验收。本文保留的 `connectToken` 示例适用于未含 `security` 的 legacy 配置，不会自动迁移现有进程、配置或旧 Vault。详细步骤见[统一授权与连接契约](security-v1-authorization-contract.md)和[使用手册](security-v1/user-guide.md)。

研发验收使用全新临时目录、显式配置与随机端口，步骤见[构建与切换指南](security-v1/release-guide.md)。现有根配置、真实 9091 和业务库不属于默认测试目标。局域网访问必须配置原生 TLS 或可信 HTTPS 反向代理，不能只把 `host` 改成 `0.0.0.0`；实际停机、切换与发布须单独授权。

两台 Windows 通过局域网使用 Designer，请先看[配置实例与逐字段说明](security-v1/windows-lan-config.md)：附本机/TLS 两份 JSON、证书信任、HTTPS 页面、有效名单检查和双库授权步骤。已有实例的来源规则可能来自台账，单改 JSON 不会覆盖已保存的防护状态。

**仓库布局（与本文件字段无关）**：**ModeDB-Ecosystem** 为 **pnpm monorepo**；**`modeldb-server`** 在 **`packages/server`**，图谱引擎在 **`packages/core`**（**`@mode-db/core`**），根目录 **`package.json`**（**`modedb-ecosystem`**，**`private: true`**）仅做脚本编排。应用侧 **API** 见 **[developer-handbook.md](./developer-handbook.md)**。**引擎与 SDK 的 API 说明**见 **[developer-handbook.md](./developer-handbook.md)**。

---

## 1. 这个文件是做什么的？

**`modeldb.config.json`** 是 **`modeldb-server`** 的**静态配置文件**，用于提供：

- 监听 **`port` / `host`**
- 逻辑库根路径 **`workspace`**（在代码里解析后也叫 **`storageRoot`**）
- 安全模式 **`security`**；仅 legacy 模式使用客户端握手 **`connectToken`**
- 日志目录、缓冲阈值、运行模式等

**不会**自动被 Node 读取；只有启动 **`modeldb-server`** 且 **`loadModelDBServerConfig`** 被调用时才会读入（或通过 **`-c`** 指定会话根 / 配置文件）。**`modeldb-server` CLI 不提供 `--workspace` / `--storage` / `--db-path`**；逻辑库根与日志路径由本文件中的 **`workspace` / `logDir`**（及数据根目录布局）决定，模板 **[modeldb.config.example.json](../modeldb.config.example.json)** 默认 **`vault`** / **`logs`**。

---

## 2. 文件应该放在哪里？

### 2.1 默认查找规则（最重要）

若启动时 **没有** 传 **`-c` / `--config`**：

1. 数据根目录由 **`getModelDbHome()`** 决定，顺序为：**环境变量 `MODELDB_HOME`** → **`~/.modeldb/home`**（由 **`modeldb-server set <dir>`** 写入的单行绝对路径）→ **OS 默认**：
   - **Windows**：**`%LOCALAPPDATA%\modeldb`**
   - **macOS**：**`~/Library/Application Support/modeldb`**
   - **Linux 等**：**`$XDG_DATA_HOME/modeldb`**，缺省为 **`~/.local/share/modeldb`**
2. 配置文件路径恒为 **`<数据根>/modeldb.config.json`**。若该 JSON 尚不存在，**首次启动**会在该根下创建 **`logs/`**、**`cache/`**、**`vault/`**，并写入默认 JSON；其中 **`logDir`**、**`workspace`** 为相对字符串 **`logs`**、**`vault`**（相对 JSON 所在目录解析，见 **`config-loader`**）。

因此：**无 `-c` 时与「你从哪个目录 `cd` 启动」无关**；持久默认路径可用 **`modeldb-server set`**。在仓库内开发若仍想用根目录的 **`modeldb.config.json`**，请对**会话根目录**或**该 JSON 文件路径**使用 **`-c`**（见下节）。

### 2.2 显式指定会话根（`-c`）

**`-c` / `--config`** 表示**本次启动的数据根目录**（临时或固定盘符均可），其下约定为：

- **`modeldb.config.json`**
- **`logs/`**、**`cache/`**、**`vault/`**（逻辑库数据默认在 **`vault/<dbName>/`**）

示例：

```bash
modeldb-server start -c /绝对路径/或/相对路径/某数据根
```

若 **`-c`** 指向**已存在的 `.json` 文件`**（例如旧版传入 **`…/modeldb.config.json`** 本身），则以**该文件所在目录**为会话根，并仍保证同级的 **`logs/`**、**`cache/`**、**`vault/`** 存在（兼容旧 CLI）。

- 传入 **相对路径** 时，按进程 **`cwd`** 经 **`path.resolve`** 得到绝对路径。
- 传入 **绝对路径** 时与 **`cwd`** 无关。

**生产建议**：在 systemd、Windows 服务、Docker 中写死 **`-c`** 为**数据根绝对路径**，避免运维 `cd` 错目录。

会话根与 `workspace` 是两个不同的目录：默认布局为 `<会话根>/cache/`、`<会话根>/logs/`、`<会话根>/vault/<库名>/atlas.mld`。`workspace` 指向其中的 `vault`，服务不会在它下面重复创建 `cache`、`logs` 或另一层 `vault`。未设置 `logDir` 时，日志也默认写到会话根的 `logs/`；打开或切换逻辑库不会改变日志目录。显式设置的 `logDir` 继续生效。

---

## 3. `workspace` 是什么？和「你电脑上的目录」有什么关系？

### 3.1 语义

- **`workspace`**（或兼容字段 **`storageRoot` / `dbPath`**，合并顺序见 loader）表示：**所有逻辑库（图谱）所共用的父目录**。
- 每个客户端连接时使用的 **逻辑库名** **`dbName`**（握手里的 **`dbName`**，旧字段名 **`atlas`**）对应磁盘上的：

  **`{解析后的 workspace 绝对路径}/{dbName}/atlas.mld`**

因此：**`workspace` 就是你希望存放「多个库子目录」的那个文件夹在磁盘上的位置**——可以是 **`C:\Data\ModelDB`**、**`/var/lib/modeldb`**、**`/Users/you/modeldb_vault`** 等。

### 3.2 相对路径如何解析（与配置文件所在目录绑定）

配置里若写：

```json
"workspace": "./modeldb_vault"
```

加载时会执行（概念上）：

**`绝对路径 = path.resolve(dirname(已解析的 modeldb.config.json 绝对路径), "./modeldb_vault")`**

因此：

- **`workspace` / `logDir`** 中的相对路径，是 **相对「正在读取的 `modeldb.config.json` 所在目录」**，不是相对进程 **`cwd`**（除非该文件恰好就在 **`cwd`** 下）。
- 若 **`workspace` 未配置** 且 CLI / 环境也未提供，内部默认串为 **`"vault"`**，解析为 **`<配置文件所在目录>/vault`**（与 **`MODELDB_HOME`** 下自动创建的 **`vault/`** 布局一致）。

### 3.3 绝对路径（推荐生产）

在 JSON 里写绝对路径，可避免 **`cd` 错误导致数据写到别处**：

**Windows 示例：**

```json
"workspace": "D:/Data/modeldb_workspace"
```

JSON 中 **`/`** 在 Node 下可用；也可用 **`D:\\\\Data\\\\modeldb_workspace`**（反斜杠需转义）。

**Linux / macOS 示例：**

```json
"workspace": "/var/lib/modeldb/workspace"
```

### 3.4 特殊写法：`dbPath` 指向单个 `.mld` 文件

若 **`workspace` / `dbPath`** 最终解析到的字符串是 **「某个 `.mld` 文件路径」**（例如 **`/data/world.mld`**），则：

- **`storageRoot`** = 该文件所在**父目录**
- **`defaultAtlas`** = 文件名去掉 **`.mld`** 后缀（用于默认逻辑库名）

适用于「工作区根下直接平铺一个库文件」的部署；多数场景仍推荐 **「目录 + 子库名 + atlas.mld」** 结构。

---

## 4. 字段说明（与 `modeldb.config.example.json` 对齐）

| JSON 字段                    | 说明                                                                                                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`port`**                   | 监听端口，默认 **9090**；可被 **`MODEL_DB_PORT`** 或 CLI **`-p`** 覆盖。                                                                                                                                                       |
| **`host`**                   | 绑定地址，默认 **127.0.0.1**；可被 **`MODEL_DB_HOST`** 或 CLI **`-H`** 覆盖。                                                                                                                                                  |
| **`advertisedHost`**         | 启动控制台优先展示的客户端主机名、IP 或域名；可被 **`MODEL_DB_ADVERTISED_HOST`** 或 CLI **`--advertised-host`** 覆盖。仅影响展示，不改变监听或网络路由。                                                                       |
| **`publicBaseUrl`**          | 对外展示的完整 HTTP(S) 基础地址，例如 `https://api.example.com`；可被 **`MODEL_DB_PUBLIC_BASE_URL`** 或 CLI **`--public-base-url`** 覆盖。未配置且绑定到 `0.0.0.0`/`::` 时，会自动复用启动日志中的非回环网卡地址；不改变监听。 |
| **`workspace`**              | **首选**：逻辑库根；每个库 **`{workspace}/{dbName}/atlas.mld`**。                                                                                                                                                              |
| **`storageRoot` / `dbPath`** | 与 **`workspace`** 同一条合并链上的别名（见 loader）。                                                                                                                                                                         |
| **`logDir`**                 | 日志目录；**相对路径时相对 `modeldb.config.json` 所在目录** 解析为 **`serverLogDirectory`**。                                                                                                                                  |
| **`bufferThreshold`**        | 服务端写缓冲阈值；可被 **`MODEL_DB_BUFFER_THRESHOLD`** 覆盖。                                                                                                                                                                  |
| **`cacheSize`**              | 当前为预留提示，不参与核心逻辑，也不限制 `cache/` 目录大小。                                                                                                                                                                   |
| **`mode`**                   | **`"production"`**（不区分大小写）时启用访问日志；也可用 **`MODEL_DB_ACCESS_LOG=true`** 单独启用。                                                                                                                             |
| **`designerWorkspace`**      | 保存 Query Designer 的 `sys_*` 元数据、接口注册表、发布台账和审计记录的逻辑库名；默认 **`model_designer_workspace`**。文件值优先于 **`MODEL_DB_DESIGNER_WORKSPACE`**。                                                         |
| **`security`**               | 新安装默认 `{ "version": 1 }`；独立台账和本机管理，不接受文件、环境变量或 CLI 混入旧 Token。可选 `network` 控制 registry 的 TLS/WSS、可信代理、来源名单和 Origin。                                                             |
| **`connectToken`**           | 仅 legacy 模式必填（文件、环境变量 **`MODEL_DB_CONNECT_TOKEN`** 或 CLI **`--token`** 合并后非空）；registry 模式禁止使用。                                                                                                     |
| **`dev`**                    | 开发诊断标志；可被 **`MODEL_DB_DEV`** 或 CLI **`--dev`** 覆盖，生产必须为 `false`。                                                                                                                                            |
| **`autoBackup`**             | 可选的自动备份调度器；省略或 `enabled: false` 时关闭。间隔最小 **60000ms**，备份写入 **`<workspace>/modeldb/backups/`**。                                                                                                      |

`autoBackup` 的完整字段为：

| 字段                  | 类型     | 说明                                                                      |
| --------------------- | -------- | ------------------------------------------------------------------------- |
| **`enabled`**         | boolean  | 是否启用自动备份；只有 `true` 才启动调度器。                              |
| **`intervalMs`**      | number   | 间隔毫秒数；与 `intervalMinutes` 同时存在时优先使用它，最小值为 `60000`。 |
| **`intervalMinutes`** | number   | 间隔分钟数；未设置 `intervalMs` 时使用。                                  |
| **`runOnStart`**      | boolean  | 服务启动后是否立即执行一轮备份，默认 `false`。                            |
| **`reason`**          | string   | 写入备份文件名的原因标记；非法字符会转成 `_`，默认 `auto`。               |
| **`databases`**       | string[] | 需要备份的逻辑库白名单；空数组或省略表示 `workspace` 下全部逻辑库。       |

**Vault 磁盘密钥（SEC-M1）**：Windows Server 自动在配置文件目录的 `security/` 保存 DPAPI/ACL 保护的 IMK 和独立数据库 DEK，网络 Token 不参与解密。`MODEL_DB_VAULT_SECRET` / `vaultSecret` 不用于新格式。本地 Core 必须显式传入 `keyProvider`；旧 Vault 保留并明确拒绝，不自动迁移。格式和恢复限制见[密钥与 Vault 契约](security-v1-vault-contract.md)。

**配置优先级**（同一键）：**CLI → `modeldb.config.json` → 环境变量 → 默认值**。`workspace`、`logDir`、`cacheSize`、`mode`、`autoBackup` 等文件专属字段没有对应 CLI 覆盖项；`MODEL_DB_ACCESS_LOG` 是只通过环境变量提供的访问日志开关。当 **`host`** 为 **`0.0.0.0`** / **`::`** 时，启动控制台会自动列出机器 hostname 和非回环网卡地址；这些地址才是其它机器应使用的直连地址。

`publicBaseUrl` 与 `host` 是两个不同概念：`host` 决定服务绑定在哪些网卡上，`publicBaseUrl` 告诉接口消费者应该复制哪个 HTTP(S) 地址。它可以是局域网地址（如 `http://192.168.1.20:9091`），也可以是反向代理后的公网地址（如 `https://api.example.com`）。留空时，绑定 `0.0.0.0`/`::` 的服务会从启动时列出的非回环网卡中自动选择一个地址；多网卡、VPN、容器或反向代理场景仍建议显式填写。它必须是绝对的 `http` 或 `https` URL，不能包含用户名、密码、查询参数或片段；服务不会因为配置了它而自动打开防火墙、端口映射或 TLS。

### 4.1 registry 网络安全配置（SEC-M4/S4.1）

`security.network` 只对 `security.version: 1` 的 registry 模式生效；legacy `connectToken` 模式不会自动获得这些边界。省略 `network` 时使用安全默认值：`loopback` 传输、数据面和管理面都只允许回环来源。网络模式决定传输方式，`publicBaseUrl` 只决定展示和生成调用地址，二者必须保持一致。

| 配置                         | 作用                                                                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `transport.mode: "loopback"` | 只允许本机回环连接；`host` 必须是 `localhost`、`127.0.0.0/8` 或 `::1`。                                                                      |
| `transport.mode: "tls"`      | 服务原生监听 HTTPS/WSS；必须配置 `certificateFile`、`privateKeyFile`，并使用 HTTPS `publicBaseUrl`。证书文件相对路径以配置文件所在目录解析。 |
| `transport.mode: "proxy"`    | 服务位于反向代理后；必须配置 `trustedProxies` CIDR、HTTPS `publicBaseUrl`，并只接受可信代理提供的转发头。                                    |
| `allowedOrigins`             | 精确匹配 Origin；不支持通配符、路径、凭据和查询参数。                                                                                        |
| `data` / `management`        | 分别控制数据面和管理面来源；allow-list 开启但为空时全部拒绝，deny 优先，规则可用 `expiresAt` 到期。                                          |

原生 TLS 配置示例（证书和私钥不应提交到 Git）：

```json
{
  "host": "0.0.0.0",
  "port": 9443,
  "publicBaseUrl": "https://db.example.com:9443",
  "security": {
    "version": 1,
    "network": {
      "transport": {
        "mode": "tls",
        "certificateFile": "security/server.crt",
        "privateKeyFile": "security/server.key"
      },
      "allowedOrigins": ["https://designer.example.com"],
      "data": {
        "allowListEnabled": true,
        "allow": [{ "id": "office", "source": "192.168.0.0/24" }],
        "deny": []
      },
      "management": {
        "allowListEnabled": true,
        "allow": [{ "id": "admin-lan", "source": "192.168.0.0/24" }],
        "deny": []
      }
    }
  }
}
```

反向代理配置示例：

```json
{
  "host": "127.0.0.1",
  "port": 9091,
  "publicBaseUrl": "https://db.example.com",
  "security": {
    "version": 1,
    "network": {
      "transport": {
        "mode": "proxy",
        "trustedProxies": ["127.0.0.1/32", "10.0.0.0/8"]
      },
      "allowedOrigins": ["https://designer.example.com"],
      "data": {
        "allowListEnabled": true,
        "allow": [{ "id": "office", "source": "192.168.0.0/24" }]
      },
      "management": {
        "allowListEnabled": true,
        "allow": [{ "id": "admin-office", "source": "192.168.0.0/24" }]
      }
    }
  }
}
```

proxy 只信任 `trustedProxies` 网段发来的 `X-Forwarded-For`/`X-Forwarded-Proto`；客户端不能直接把这些头添加到普通连接中绕过来源规则。URL 查询参数不得携带凭据，客户端统一使用 `Authorization: Bearer mdbt_v1_…`。配置错误、证书读取失败、非 HTTPS 远程调用和来源不在名单内时，服务会 fail-closed 并返回稳定的 `SECURITY_*` 错误码。

示例来源网段必须替换为实际客户端网段；省略 `data` / `management` 时仍只允许回环来源，不会因为部署了代理自动放行远程客户端。浏览器工具优先使用[短期会话与本机启动器](security-browser-sessions.md)，不需要把服务 Token 长期存入前端。

### 4.2 安全审计容量与保留（SEC-M5/S5.2）

`security.audit` 控制加密安全台账中的审计事件保留期和容量：

| 配置            |  默认值 |          范围 | 说明                                                                       |
| --------------- | ------: | ------------: | -------------------------------------------------------------------------- |
| `retentionDays` |   `365` |    `1`–`3650` | 超出保留期的事件在服务启动或下一次台账写入时清理，并记录清理数量。         |
| `maxEvents`     | `10000` | `100`–`50000` | 加密台账可保存的事件上限；使用率达到 80% 显示预警，达到 95% 显示严重告警。 |

审计事件与安全 registry 一起加密保存，不额外写入明文服务器日志文件。达到容量上限后，如果一次安全变更无法连同审计事件一起提交，变更会被拒绝（fail-closed），不会静默覆盖旧事件。安全中心只向安全管理员会话开放筛选和 JSONL 下载；Windows CLI 的 `security audit` / `security audit-export` 通过 OS 身份验证的本机管理管道操作。导出的 JSONL 是用户明确请求的明文副本，可能包含客户端 IP、主体、资源和请求标识，应保存到受保护的位置；不能放入 `security/` 台账目录。

```powershell
node packages/server/dist/cli.js security audit --config .\modeldb.config.json --category network --result denied --limit 50
node packages/server/dist/cli.js security audit-export --config .\modeldb.config.json --output .\secure-backups\security-audit.jsonl --from 2026-10-01T00:00:00.000Z --to 2026-10-31T23:59:59.999Z
```

`security audit-export` 使用新建文件模式，不覆盖已有文件，也不会替用户修改导出目录的 ACL。导出记录本身会在 JSONL 快照生成后写入审计台账，因而不会递归包含正在执行的这次导出事件。

---

## 5. Windows 上怎么做？

### 5.1 推荐目录布局

```text
D:\opt\modeldb-srv\
  modeldb.config.json    ← 配置文件
  logs\                    ← 若 logDir 为 ./logs 且配置文件在本目录下
  vault\                   ← 建议 workspace 指向的目录名
    Asset_Graph\
      atlas.mld
    AnotherDb\
      atlas.mld
```

### 5.2 配置文件示例（`modeldb.config.json`）

```json
{
  "port": 9091,
  "host": "127.0.0.1",
  "advertisedHost": "",
  "publicBaseUrl": "",
  "logDir": "./logs",
  "workspace": "D:/opt/modeldb-srv/vault",
  "bufferThreshold": 50000,
  "cacheSize": "2GB",
  "mode": "production",
  "designerWorkspace": "model_designer_workspace",
  "security": {
    "version": 1,
    "network": {
      "transport": {
        "mode": "loopback"
      }
    }
  },
  "autoBackup": {
    "enabled": false,
    "intervalMinutes": 60,
    "runOnStart": false,
    "reason": "auto",
    "databases": []
  },
  "dev": false
}
```

带逐项中文注释的 JSONC 模板见仓库根目录 **`modeldb.config.example.jsonc`**。标准 JSON 文件不能包含注释；实际启动文件请使用合法 JSON，或先删除 JSONC 中的注释。

### 5.3 启动方式（避免相对路径踩坑）

**方式 A：无参数启动（使用 `MODELDB_HOME` 下默认配置）**

```powershell
modeldb-server start
```

首次会在 **`%LOCALAPPDATA%\modeldb`**（或已设置的 **`MODELDB_HOME`**）生成 **`modeldb.config.json`**、**`logs`**、**`cache`**、**`vault`**。

**方式 B：任意目录启动，用 `-c` 指定配置路径**

```powershell
modeldb-server start -c D:\opt\modeldb-srv\modeldb.config.json
```

此时 **`workspace` / `logDir`** 中的相对路径是 **相对该 JSON 文件所在目录** 解析；生产仍建议 **`workspace` 写绝对路径**。

### 5.4 注意点

- **路径分隔符**：JSON 里推荐 **`/`** 或转义后的 **`\\`**，不要只写一个 **`\\`** 未转义导致 JSON 非法。
- **权限**：服务账号对 **`workspace`** 目录需有读写权（创建子目录、写 **`atlas.mld`**）。
- **防火墙**：放行 **`port`**（入站规则）。
- **直连地址**：启动后复制控制台列出的 **HTTP** 或 **WebSocket** 完整地址。若服务器有固定域名或端口映射，可配置 `"advertisedHost": "db.example.com"`；两台服务器之间必须存在可路由的网络路径，展示地址本身不能替代 VPN、端口映射或代理。

---

## 6. Linux 上怎么做？

### 6.1 推荐目录布局

```text
/opt/modeldb/
  modeldb.config.json
  logs/
  vault/
    asset_graph/
      atlas.mld
```

### 6.2 配置文件示例

```json
{
  "port": 9090,
  "host": "0.0.0.0",
  "advertisedHost": "db.example.internal",
  "publicBaseUrl": "https://db.example.com",
  "logDir": "./logs",
  "workspace": "/opt/modeldb/vault",
  "bufferThreshold": 50000,
  "cacheSize": "2GB",
  "mode": "production",
  "designerWorkspace": "model_designer_workspace",
  "security": {
    "version": 1,
    "network": {
      "transport": {
        "mode": "tls",
        "certificateFile": "security/server.crt",
        "privateKeyFile": "security/server.key"
      },
      "allowedOrigins": ["https://designer.example.com"]
    }
  },
  "autoBackup": {
    "enabled": false,
    "intervalMinutes": 60,
    "runOnStart": false,
    "reason": "auto",
    "databases": []
  },
  "dev": false
}
```

### 6.3 启动与 systemd 建议

**手动启动（开发）**

```bash
modeldb-server start
```

或 **`modeldb-server start -c /opt/modeldb/modeldb.config.json`** 使用固定路径下的配置。

**systemd 单元要点**

- **`ExecStart`**：可直接 **`/usr/bin/modeldb-server start`**（依赖默认 **`MODELDB_HOME`**），或 **`modeldb-server start -c /opt/modeldb/modeldb.config.json`**。
- 若使用 **`-c`** 且 **`logDir: "./logs"`**，则日志目录为 **`/opt/modeldb/logs`**（相对 JSON 所在目录）。
- 使用 **`User=` / `Group=`** 专用账号，并对 **`workspace`**（或 **`MODELDB_HOME/vault`**）授权 **`chown`**。

### 6.4 注意点

- **SELinux**：若开启，需为数据目录配置合适 context 或策略。
- **`host: "0.0.0.0"`**：表示监听所有网卡，请配合防火墙与 **TLS 反向代理**。

---

## 7. macOS 上怎么做？

与 **Linux** 类似：路径使用 **`/Users/<你>/...`** 或 **`/usr/local/var/...`**（Homebrew 常用数据目录）。

### 7.1 示例

```json
{
  "port": 9090,
  "host": "127.0.0.1",
  "advertisedHost": "127.0.0.1",
  "publicBaseUrl": "http://127.0.0.1:9090",
  "logDir": "./logs",
  "workspace": "/Users/yourname/Library/Application Support/MyApp/modeldb_vault",
  "bufferThreshold": 50000,
  "cacheSize": "2GB",
  "mode": "development",
  "designerWorkspace": "model_designer_workspace",
  "security": {
    "version": 1,
    "network": {
      "transport": {
        "mode": "loopback"
      }
    }
  },
  "autoBackup": {
    "enabled": false,
    "intervalMinutes": 60,
    "runOnStart": false,
    "reason": "auto",
    "databases": []
  },
  "dev": false
}
```

### 7.2 启动

```bash
modeldb-server start
```

或 **`modeldb-server start -c "/Users/yourname/Library/Application Support/MyApp/modeldb.config.json"`**。若路径含空格，**`-c` 参数要加引号**。

### 7.3 launchd

与 systemd 同理：可依赖默认 **`MODELDB_HOME`**，或在 plist 里为 **`ExecStart`** 传入 **`-c` 绝对路径**。

---

## 8. 与客户端、治理端的「路径一致」检查

| 组件                          | 必须一致的内容                                                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **`modeldb-server`**          | **`workspace`** 解析后的目录下，存在客户端使用的 **`dbName`** 子目录及 **`atlas.mld`**（或由治理端 **`flushAll`** 生成）。 |
| **`AuthoringEngine`（灌库）** | **`storageRoot` + atlas 名** 应对应同一磁盘位置（与 Server 的 **`workspace/{dbName}`** 一致）。                            |
| **registry 凭据**             | 由本机安全 CLI 创建/轮换后一次性交付；SDK 使用 `token` 通过 `Authorization: Bearer` 发送，凭据不写入 URL 或配置文件。      |

---

## 9. 自动备份配置

`autoBackup` 是可选配置。不写该字段，或设置 `enabled: false`，server 不会自动创建备份。

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

字段说明：

| 字段                  | 说明                                                       |
| --------------------- | ---------------------------------------------------------- |
| **`enabled`**         | 是否启用自动备份。只有 `true` 才启动调度器。               |
| **`intervalMinutes`** | 备份间隔，单位分钟。                                       |
| **`intervalMs`**      | 备份间隔，单位毫秒；优先于 `intervalMinutes`。             |
| **`runOnStart`**      | server 启动后是否立即执行一次备份。默认 `false`。          |
| **`reason`**          | 调度日志中的来源标记，默认 `auto`；v2 备份使用随机文件名。 |
| **`databases`**       | 要备份的逻辑库列表；空数组或省略表示所有逻辑库。           |

限制：

- 最小间隔为 `60000` ms。
- 备份文件写入 `<workspace>/modeldb/backups/`。
- 自动备份依赖 `modeldb-server` 进程存活；进程停止后不会继续调度。
- S6.2 使用 `modeldb.backup.v2` 加密包，与同库写请求共用锁并先刷盘；刷盘或审计失败不会报告成功。单个 Vault 最大 48 MiB、完整包最大 128 MiB。仅包含当前单库 Vault，不打包 registry、策略或旁文件；跨实例恢复需要独立恢复材料或显式接收方迁移。操作与限制见[安全 V1 使用手册](security-v1/user-guide.md)。

---

## 10. 延伸阅读

- 使用手册（安装、构建、启动、FAQ）：**[user-handbook.md](./user-handbook.md)**
- 仓库根 **[README.md](../README.md)** —「运行与配置」整节
- 操作手册 **[operations-manual.md](./operations-manual.md)**
- 配置加载源码：**`packages/server/src/config-loader.ts`**、默认主目录：**`packages/server/src/modeldb-default-home.ts`**
- 示例文件：**[modeldb.config.example.json](../modeldb.config.example.json)**

## 公钥登录配置补充（DR-P2.2）

`security.authentication` 可选且默认关闭；`enabled` 必须是布尔值，`allowStorageMigration` 可选且默认 false。启用时必须已有通过校验的 `security.registration.descriptor`、准确 DNS/RP 和可信 HTTPS；仅在明确允许迁移时把 V1/V2/V3 原子升级到 V4。关闭或到期的注册窗口不阻止已有批准身份登录；关闭新登录不自动注销已有会话。原 Token/配对保留，数据密钥和 Vault 格式不变。

完整接入示例、30 分钟/8 小时会话、迁移/回退及错误处理见[公钥登录手册](security-v1/device-registration-runtime-guide.md#8-公钥登录与浏览器会话dr-p22)。这是后端/SDK 功能，正式 Designer 页面尚未接入；不要直接据此修改正在使用的业务实例。

## DR-P3.1 同源托管与本机管理

可显式开启 `security.hosting`，同源 Designer/API 与专用 127.0.0.1 管理监听器分离；本机启动器无需手输 Token，管理 Cookie 空闲 15 分钟/绝对 60 分钟且无数据授权。静态内容启动时白名单快照，拒绝源码/秘密/路径穿越与链接，绑定失败不扩大监听范围。默认保持旧独立前端模式；正式注册/Passkey 状态页继续 DR-P3.2。配置、隔离命令、错误与验证见[手册](security-v1/device-registration-runtime-guide.md#12-同源页面与专用本机管理入口dr-p31)。

开发验证：`pnpm run test:security:hosting`、`node scripts/security-hosting-integration-check.mjs`；构建：`node scripts/security-hosting-build.mjs --output <new-directory>`。构建禁用本地 Vite 配置/env，原 dist 不覆盖；集成强制原生 Windows/Chrome，使用临时合成实例和随机回环端口，缺证据或 skip 不通过。复用现有三语言界面；Hello、LAN、新双机、生产性能与真实切换仍需后续验收。

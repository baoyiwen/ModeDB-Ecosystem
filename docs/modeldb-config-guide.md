# `modeldb.config.json` 配置指南（放置位置、数据根与磁盘路径）

本文说明 **`modeldb.config.json` 应如何写、放在哪、与「配置文件所在目录」和磁盘目录的关系**，并分别给出 **Windows、Linux、macOS** 下的推荐做法。实现以 **`packages/server/src/config-loader.ts`**、**`packages/server/src/modeldb-default-home.ts`** 与 **`modeldb-persisted-home.ts`**（**`set`** 持久路径）为准。

**仓库布局（与本文件字段无关）**：**ModeDB-Ecosystem** 为 **pnpm monorepo**；**`modeldb-server`** 在 **`packages/server`**，图谱引擎在 **`packages/core`**（**`@mode-db/core`**），根目录 **`package.json`**（**`modedb-ecosystem`**，**`private: true`**）仅做脚本编排。应用侧 **API** 见 **[developer-handbook.md](./developer-handbook.md)**。**引擎与 SDK 的 API 说明**见 **[developer-handbook.md](./developer-handbook.md)**。

---

## 1. 这个文件是做什么的？

**`modeldb.config.json`** 是 **`modeldb-server`** 的**静态配置文件**，用于提供：

- 监听 **`port` / `host`**
- 逻辑库根路径 **`workspace`**（在代码里解析后也叫 **`storageRoot`**）
- 客户端握手必需的 **`connectToken`**
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

| JSON 字段                    | 说明                                                                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`port`**                   | 监听端口，默认 **9090**；可被 **`MODEL_DB_PORT`** 或 CLI **`-p`** 覆盖。                                                                                 |
| **`host`**                   | 绑定地址，默认 **127.0.0.1**；可被 **`MODEL_DB_HOST`** 或 CLI **`-H`** 覆盖。                                                                            |
| **`advertisedHost`**         | 启动控制台优先展示的客户端主机名、IP 或域名；可被 **`MODEL_DB_ADVERTISED_HOST`** 或 CLI **`--advertised-host`** 覆盖。仅影响展示，不改变监听或网络路由。 |
| **`workspace`**              | **首选**：逻辑库根；每个库 **`{workspace}/{dbName}/atlas.mld`**。                                                                                        |
| **`storageRoot` / `dbPath`** | 与 **`workspace`** 同一条合并链上的别名（见 loader）。                                                                                                   |
| **`logDir`**                 | 日志目录；**相对路径时相对 `modeldb.config.json` 所在目录** 解析为 **`serverLogDirectory`**。                                                            |
| **`bufferThreshold`**        | 服务端写缓冲阈值；可被 **`MODEL_DB_BUFFER_THRESHOLD`** 覆盖。                                                                                            |
| **`cacheSize`**              | 当前为预留提示，不参与核心逻辑。                                                                                                                         |
| **`mode`**                   | **`"production"`**（不区分大小写）时等价打开访问日志等（与 **`MODEL_DB_ACCESS_LOG`** 协同）。                                                            |
| **`connectToken`**           | **必填**（文件、环境变量 **`MODEL_DB_CONNECT_TOKEN`** 或 CLI **`--token`** 三选一合并后非空）；否则服务启动失败。                                        |
| **`dev`**                    | 开发标志；可被 **`MODEL_DB_DEV`** 或 CLI **`--dev`** 覆盖。                                                                                              |

**Vault 磁盘密钥**：当前 **`ModelDBServerFileConfig`** 类型以 **`connectToken`** 与运行时环境为主；若 README 中仍提到 **`vaultSecret`**，请以你使用的 **`@mode-db/server` / 引擎版本** 的 **`config-loader`** 与 README 为准。读 **`atlas.mld`** 的进程通常还需与灌库时一致的 **`MODEL_DB_VAULT_SECRET`** 或 **`MODEL_DB_CONNECT_TOKEN`**（与集成测试 **`test/integration/vault-env.ts`** 一致）。

**配置优先级**（同一键）：**CLI → `modeldb.config.json` → 环境变量 → 默认值**。当 **`host`** 为 **`0.0.0.0`** / **`::`** 时，启动控制台会自动列出机器 hostname 和非回环网卡地址；这些地址才是其它机器应使用的直连地址。

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
  "port": 9090,
  "host": "127.0.0.1",
  "logDir": "./logs",
  "workspace": "D:/opt/modeldb-srv/vault",
  "connectToken": "在此填入长随机串-勿提交git",
  "mode": "development",
  "dev": false
}
```

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
  "logDir": "./logs",
  "workspace": "/opt/modeldb/vault",
  "connectToken": "在此填入长随机串",
  "mode": "production",
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
  "logDir": "./logs",
  "workspace": "/Users/yourname/Library/Application Support/MyApp/modeldb_vault",
  "connectToken": "在此填入长随机串",
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
| **`connectToken`**            | 配置文件 / 环境变量 / CLI 与 SDK **`connectRemote({ connectToken })`** 完全一致。                                          |

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

| 字段                  | 说明                                              |
| --------------------- | ------------------------------------------------- |
| **`enabled`**         | 是否启用自动备份。只有 `true` 才启动调度器。      |
| **`intervalMinutes`** | 备份间隔，单位分钟。                              |
| **`intervalMs`**      | 备份间隔，单位毫秒；优先于 `intervalMinutes`。    |
| **`runOnStart`**      | server 启动后是否立即执行一次备份。默认 `false`。 |
| **`reason`**          | 备份文件名中的 reason 后缀，默认 `auto`。         |
| **`databases`**       | 要备份的逻辑库列表；空数组或省略表示所有逻辑库。  |

限制：

- 最小间隔为 `60000` ms。
- 备份文件写入 `<workspace>/modeldb/backups/`。
- 自动备份依赖 `modeldb-server` 进程存活；进程停止后不会继续调度。

---

## 10. 延伸阅读

- 使用手册（安装、构建、启动、FAQ）：**[user-handbook.md](./user-handbook.md)**
- 仓库根 **[README.md](../README.md)** —「运行与配置」整节
- 操作手册 **[operations-manual.md](./operations-manual.md)**
- 配置加载源码：**`packages/server/src/config-loader.ts`**、默认主目录：**`packages/server/src/modeldb-default-home.ts`**
- 示例文件：**[modeldb.config.example.json](../modeldb.config.example.json)**

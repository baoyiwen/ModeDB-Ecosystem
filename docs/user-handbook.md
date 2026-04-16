# ModeDB-Ecosystem 使用手册

面向 **首次克隆仓库的开发者** 与 **需要起本地/内网服务的运维**：从环境、安装、构建到启动 **`modeldb-server`**、跑集成测试与压测的最短路径。设计细节、API 与链式查询语义仍以仓库根 **[README.md](../README.md)** 为准；**引擎与 SDK 的 API 索引**见 **[developer-handbook.md](./developer-handbook.md)**；部署与前后端接入见 **[operations-manual.md](./operations-manual.md)**；数据根与 **`modeldb.config.json`** 见 **[modeldb-config-guide.md](./modeldb-config-guide.md)**。

---

## 1. 文档地图

| 文档                                                     | 适合谁               | 内容侧重                                                                                   |
| -------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------ |
| **本文**                                                 | 新人、日常联调       | 安装 → 构建 → 启动 → 排障                                                                  |
| **[README.md](../README.md)**                            | 引擎使用者、架构评审 | 理念、存储、治理/DX、运行参数全集、SDK                                                     |
| **[operations-manual.md](./operations-manual.md)**       | 运维、后端、前端     | 部署、密钥、**`connectRemote`**、检查清单                                                  |
| **[modeldb-config-guide.md](./modeldb-config-guide.md)** | 运维                 | **`modeldb.config.json`** 放哪、相对路径、各 OS                                            |
| **[test/README.md](../test/README.md)**                  | 贡献者、CI           | 集成脚本说明与命令表                                                                       |
| **[developer-handbook.md](./developer-handbook.md)**     | 应用开发者           | **`@mode-db/core`** / **SDK** API 入口与典型调用                                           |
| **`@mode-db/common`**（`packages/common/src`）           | 引擎 / Server 贡献者 | 共享类型、**`PathResolver`**、**`EngineLogger`**、**`DiskAdapter`**、manifest 与存储根约定 |

---

## 2. 环境要求

| 项          | 要求                                                                                                                                                       |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Node.js** | **≥ 20**（与 **`@mode-db/server`** 的 **`engines`** 一致；仓库已在 Node 22 上验证过启动脚本）                                                              |
| **pnpm**    | **9.x**（根 **`package.json`** 中 **`packageManager`** 锁定为 **`pnpm@9.15.4`**，建议用 **Corepack**：`corepack enable` 后 `pnpm install` 会自动对齐版本） |
| **Git**     | 克隆仓库即可                                                                                                                                               |

**PATH 与终端**：`pnpm` 本质是调用 **`node`** 的脚本。若在 **Git Bash / MSYS** 下出现 **`exec: node: not found`**，而 PowerShell 正常，多半是 **Bash 未继承 Windows 的 Node 安装路径**——请用 **PowerShell / Windows Terminal / VS Code 集成终端** 跑命令，或把 Node 安装目录加入 **用户/系统环境变量 Path** 后重开终端。

---

## 3. 获取代码与安装依赖

```bash
git clone https://github.com/baoyiwen/ModeDB-Ecosystem.git
cd ModeDB-Ecosystem
pnpm install
```

---

## 4. 构建说明

### 4.1 全量构建（推荐第一次或发版前）

```bash
pnpm run build
```

顺序固定为：**`shared` → `common` → `core` → `server` → `sdk`**，与各包 **`package.json`** 依赖一致。**`@mode-db/server`** 在 **`pnpm run build:server`** 时还会通过 **`prebuild`** 确保 **`shared` / `common` / `core`** 已编译（顺序与根 **`build`** 一致）。

### 4.2 按需单独构建

| 命令                        | 作用                                                                  |
| --------------------------- | --------------------------------------------------------------------- |
| **`pnpm run build:shared`** | **`@mode-db/shared`** → **`packages/shared/dist/`**                   |
| **`pnpm run build:common`** | **`@mode-db/common`**（依赖已构建的 shared）                          |
| **`pnpm run build:core`**   | **`@mode-db/core`**（别名 **`build:lib`**）                           |
| **`pnpm run build:server`** | **`@mode-db/server`**（**`prebuild`** 会先拉起 shared、common、core） |
| **`pnpm run build:sdk`**    | **`@mode-db/sdk`**                                                    |

### 4.3 监听编译（仅引擎包）

```bash
pnpm run dev
```

等价于 **`pnpm --filter @mode-db/core run dev`**（**`packages/core`** 内 **`tsc --watch`**）。**不**自动编译 server；改 server 源码后仍需 **`pnpm run build:server`** 或见下节「加速启动」。

---

## 5. 启动 WebSocket / HTTP 服务（`modeldb-server`）

### 5.1 仓库根推荐命令

```bash
pnpm run start:server -- -c modeldb.config.json
```

根目录脚本 **`start:server`** 会先执行 **`pnpm run build:server`**，再执行 **`node ./packages/server/dist/cli.js`**。这样可避免「忘记编译导致找不到 `dist/cli.js`」；代价是每次启动都会跑一遍服务端及其 **`prebuild`** 依赖的编译（改代码频繁时可改用下面「加速」方式）。

**无 `-c`** 时，数据根为 **`MODELDB_HOME`** → **`~/.modeldb/home`（`modeldb-server set <dir>`）** → OS 默认；详见 **[modeldb-config-guide.md](./modeldb-config-guide.md)**。首次启动会在该根下自动创建 **`logs/`**、**`cache/`**、**`vault/`** 与默认 **`modeldb.config.json`**（若目录曾被删也会重建）。

其它子命令（见 **`packages/server/src/cli.ts`**）：

- **`modeldb-server set <目录>`**：持久化默认数据根到 **`~/.modeldb/home`**。
- **`modeldb-server export-token`**：根据当前（或 **`export-token -c <会话根>`**）配置打印 **`MODEL_DB_CONNECT_TOKEN`** 的 shell 写法并提示保存。

### 5.2 等价入口（需已有 `dist/`）

在已完成 **`pnpm run build:server`**（或 **`pnpm run build`**）的前提下，可直接：

```bash
node ./packages/server/dist/cli.js -- -c modeldb.config.json
pnpm exec modeldb-server -- -c modeldb.config.json
```

**`-c`** 可为**会话数据根目录**（内含 **`modeldb.config.json`** 与子目录），或如上例指向**已存在的 JSON 文件**（以父目录为根）。可选子命令 **`start`**（**`modeldb-server start -c ...`** 与 **`modeldb-server -c ...`** 均可）。

### 5.3 准备配置文件

1. 复制 **`modeldb.config.example.json`** → 数据根下的 **`modeldb.config.json`**（勿提交真实密钥）。
2. 至少填写 **`connectToken`**；若磁盘 **`atlas.mld`** 使用独立 Vault 口令，配置 **`vaultSecret`** 或环境变量 **`MODEL_DB_VAULT_SECRET`**（与 README「运行与配置」一致）。
3. 模板中 **`logDir`/`workspace`** 已为 **`logs`** / **`vault`**（与数据根下目录一致），一般无需再改。

### 5.4 双轨压测 `ignition`

需 **另一终端** 已长期运行 **`modeldb-server`**，且环境变量 **`MODEL_DB_URL`**、**`MODEL_DB_CONNECT_TOKEN`**、**`MODEL_DB_ATLAS`** 与配置一致。详见根 README **「双轨压测点火」** 与 **[test/README.md](../test/README.md)**。

---

## 6. 质量门禁与集成测试

```bash
pnpm run check    # check:sources + typecheck + lint + format:check
pnpm test         # 等价 pnpm run test:integration（会先 build shared/common/core/server）
```

**`verify.ts`** 会清空默认 **`data/`**；跑前请确认无未备份的本地图谱数据。

---

## 7. 常见问题（FAQ）

| 现象                                                       | 处理                                                                                                               |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **`exec: node: not found`**（pnpm）                        | 安装 Node 并保证 **`node`** 在当前终端 **`PATH`** 中（见 §2）。                                                    |
| **`Cannot find module '.../packages/server/dist/cli.js'`** | 使用 **`pnpm run start:server`**（含自动 **`build:server`**），或先手动 **`pnpm run build:server`**。              |
| **`@mode-db/shared` 找不到**（构建 common 失败）           | 先 **`pnpm run build:shared`**，或跑全量 **`pnpm run build`**；勿在 **`shared` 未构建**时单独 **`build:common`**。 |
| **端口占用**                                               | 改 **`port`** / **`MODEL_DB_PORT`** 或结束占用进程。                                                               |
| **握手失败**                                               | 客户端 **`connectToken`** 与服务端配置 **`trim` 后全等**（见 README）。                                            |

---

## 8. 延伸阅读

- 根 README：**「运行与配置」**、**「网络服务与远程客户端 SDK」**、**「快速开始」**
- **[logical-workspace-and-single-file.md](./logical-workspace-and-single-file.md)**：逻辑库与单文件 Vault
- **[engine-meta-crud-and-wire.md](./engine-meta-crud-and-wire.md)**：Meta-CRUD 与线协议
- **[PUBLISH.md](./PUBLISH.md)**：工作区包发布流程

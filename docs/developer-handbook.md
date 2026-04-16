# ModeDB 开发者手册

面向在应用或工具中**集成图谱存储与查询**的开发者：说明各 npm 包职责、`@mode-db/core` 的治理端与只读 API、以及 **`@mode-db/sdk`** 的网络用法。部署、密钥与 **`modeldb.config.json`** 见 **[operations-manual.md](./operations-manual.md)** 与 **[modeldb-config-guide.md](./modeldb-config-guide.md)**；环境搭建见 **[user-handbook.md](./user-handbook.md)**。

---

## 1. 文档地图

| 文档                                                                               | 用途                                                        |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **本文**                                                                           | 包结构、引擎与 SDK 的 API 入口与典型调用                    |
| **[README.md](../README.md)**                                                      | 架构、存储布局、链式查询与 DX 细节                          |
| **[engine-meta-crud-and-wire.md](./engine-meta-crud-and-wire.md)**                 | **`alterModel` / `dropRelation` / `dropModel`** 与 Wire RPC |
| **[logical-workspace-and-single-file.md](./logical-workspace-and-single-file.md)** | **`workspace`**、单文件 Vault、与分文件布局的关系           |
| **[test/README.md](../test/README.md)**                                            | 集成脚本与回归命令                                          |

---

## 2. Monorepo 包一览

| 包                                         | 说明                                                                                    |
| ------------------------------------------ | --------------------------------------------------------------------------------------- |
| **`@mode-db/core`**（`packages/core`）     | **AuthoringEngine**（写）、**ModelDBClient**（只读）、**QueryChain**、Vault、模板注册等 |
| **`@mode-db/common`**（`packages/common`） | **PathResolver**、**EngineLogger**、**DiskAdapter**、类型、manifest、诊断、存储根       |
| **`@mode-db/shared`**（`packages/shared`） | Wire 编解码、握手与 RPC 载荷类型（不依赖 core）                                         |
| **`@mode-db/server`**（`packages/server`） | HTTP/WebSocket 服务、配置加载、查询与 DDL 分发                                          |
| **`@mode-db/sdk`**（`packages/sdk`）       | **RemoteModelDBClient**、**connectRemote**；仅依赖 **shared**，经网络访问 Server        |

---

## 3. 引用方式

```bash
pnpm add @mode-db/core
# 或仅远程客户端
pnpm add @mode-db/sdk @mode-db/shared
```

```ts
import {
  AuthoringEngine,
  ModelDBClient,
  configureModelDBStorageRoot,
  deriveAtlasVaultSecretFromConnectToken,
} from '@mode-db/core';
```

同进程写读可共用 **`configureModelDBStorageRoot`** 与一致的 **`MODEL_DB_CONNECT_TOKEN`**（解密 **`atlas.mld`** 与 Server **`connectToken`** 对齐）。

---

## 4. 存储与逻辑库

- **存储根**：默认 **`<cwd>/data`**，可由 **`MODEL_DB_STORAGE_ROOT` / `STORAGE_ROOT`** 或 **`configureModelDBStorageRoot({ storageRoot })`** 覆盖（实现见 **`packages/common/src/default-storage-root.ts`**）。
- **单文件 Vault**：**`<storageRoot>/<atlas>/atlas.mld`**，魔数 **`MDB4SVLT`**；包内键 **`m:<Model>`**、**`r:<rid>`**、**`__manifest__`**。
- **PathResolver**：解析 atlas 目录、**`atlas.mld`**、分文件 **`models/`** / **`relations/`** 等路径；构造 **`new PathResolver(storageRoot, atlasName)`**。

---

## 5. 治理端：`AuthoringEngine`

**构造**（常用字段，完整类型见 **`AuthoringEngineOptions`**）：

- **`atlas`**：逻辑库目录名（与磁盘子目录一致）。
- **`storageRoot`**：存储根；缺省为 **`resolveModelDBStorageRoot()`**。
- **`vaultSecret`** / **`connectToken`**：与单文件 Vault 解密一致时择一配置（与 Server 文档对齐）。
- **`shadowDiskEncoding`**、**`enableSmartCache`**、**`engineLogger`** 等见类型定义。

**图谱建模**

| API                                               | 说明                                                                                                 |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **`registerModel(name, fields)`**                 | **`fields`** 可为 **`Set<string>`** 或 **`FieldDefsRecord`**（带 **DataType** / **`FieldTypeDef`**） |
| **`quickLink(source, target, forward, reverse)`** | 声明有向关系及反向别名                                                                               |
| **`bind(forwardName, strategy, options)`**        | 按策略写入关系索引（如 **MANUAL** 与 **pairs**）                                                     |

**实体写 API**（通过 **`engine.model('ModelName')`** 得到 **`ModelEntity`**）

| API                                          | 说明                                                        |
| -------------------------------------------- | ----------------------------------------------------------- |
| **`insert(data)`** / **`insertMany`**        | 插入行；可选 **`{ sync: true }`** 尽快刷缓冲                |
| **`update(id, patch)`** / **`updateFields`** | 按 id 更新；**`updateFields`** 支持字段名数组或带类型的记录 |
| **`delete(id)`** / **`deleteWhere`**         | 行级删除（墓碑语义，查询侧不可见）                          |
| **`findFirstByFieldEq`** 等                  | 缓冲与磁盘合并语义见根 README                               |

**持久化**

| API                        | 说明                                        |
| -------------------------- | ------------------------------------------- |
| **`flushAll()`**           | 缓冲、关系索引、**`__manifest__`** 一并落盘 |
| **`writeAtlasManifest()`** | 仅写 manifest（高级用法）                   |

**元数据（Meta-CRUD）**

| API                                | 说明                                                                                            |
| ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| **`alterModel(name, schema)`**     | 非破坏性合并 schema（仅追加可选字段等规则见专文）                                               |
| **`alterModelPatch(name, patch)`** | 增量片段合并后再走 **`alterModel`** 校验                                                        |
| **`dropRelation(forwardName)`**    | 删除关系及 Vault **`r:*`** 索引                                                                 |
| **`dropModel(modelName)`**         | 逻辑删除：清理触及关系、注册表与 manifest；**`m:*`** / 分文件 **`.mld`** 物理保留，运行时不可见 |

**查询（治理进程内）**

- **`engine.query(modelName, ids)`** → **`QueryChain`**（与只读端链式 API 一致）。

**关系侧**

- **`engine.relation('ForwardLabel')`** → **`RelationEntity`**：**`link` / `unlink`**、 **`explainRelate`** 等。

---

## 6. 只读运行时：`ModelDBClient`

| API                                    | 说明                                                                                         |
| -------------------------------------- | -------------------------------------------------------------------------------------------- |
| **`ModelDBClient.connect(atlasName)`** | 在存储根下打开 **`<atlas>/atlas.mld`**；需环境变量 **`MODEL_DB_CONNECT_TOKEN`** 与加密包一致 |
| **`client.model('ModelName')`**        | **只读** **`RuntimeModel`**：**`findById`**、**`where`**、**`relate`** 等                    |
| **`ModelDBClient.fromContext(ctx)`**   | 与 **`AuthoringEngine`** 同进程桥接（Server 内部等场景）                                     |

只读客户端**不包含** **`insert` / `update` / `delete` / `bind`**；写路径经 **Server + SDK** 或进程内 **AuthoringEngine**。

---

## 7. 链式查询与高级能力

- **`QueryChain`**：**`where`**、**`relate`**、**`includeRelates`**、分页、**`ComputeBuilder`** / 分析结果等，见根 **[README.md](../README.md)** 第六节与 **`@mode-db/core`** 中 **`QueryEngine`**、**`ComputeBuilder`** 导出。

---

## 8. 网络客户端：`@mode-db/sdk`

```ts
import { RemoteModelDBClient, connectRemote } from '@mode-db/sdk';
```

| API                                                                       | 说明                                                                                                            |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **`RemoteModelDBClient.connectNetwork({ host, port, token, database })`** | **`database`** 为逻辑库名（握手 **`dbName`**）；返回远程 façade，链式 API 与 **`ModelDBClient`** 对齐           |
| **`connectRemote(...)`**                                                  | 建立会话的底层入口（见 SDK 类型 **`ConnectRemoteOptions`**）                                                    |
| **`dropModel` / `dropRelation` / `alterModel`**                           | 经 Wire 调用服务端 **AuthoringEngine**（见 **[engine-meta-crud-and-wire.md](./engine-meta-crud-and-wire.md)**） |

SDK **不得**依赖 **`@mode-db/core`** 的磁盘 IO；仓库 **`pnpm run check:sources`** 会做静态约束。

---

## 9. 共享类型与校验：`@mode-db/common`

从 **`@mode-db/core`** 再导出常用项，也可直接 **`import { DataType, validateFieldValue, ... } from '@mode-db/common'`**。

- **`DataType`**、**`normalizeFieldDefs`**、**`ValueObject`**（I18N / Color / Unit 等）
- **`DiagnosticCenter`**、**`ValidationReport`**、**`ErrorCodes`**
- **`EngineLogger`**、**`DiskAdapter`**：日志与磁盘耗时采样（含寻址相关指标，见 **`EngineLogger`** 实现）

---

## 10. 构建与调试

```bash
pnpm install
pnpm run build          # shared → common → core → server → sdk
pnpm run build:core     # 仅引擎
pnpm run meta-crud-audit
```

---

## 11. 源码索引（精选）

| 能力                         | 路径                                                               |
| ---------------------------- | ------------------------------------------------------------------ |
| **AuthoringEngine**          | `packages/core/authoring/engine.ts`                                |
| **ModelEntity**              | `packages/core/authoring/entity.ts`                                |
| **ModelDBClient.connect**    | `packages/core/src/runtime/ModelDBClient.ts`                       |
| **QueryChain / QueryEngine** | `packages/core/src/runtime/query.ts` 等                            |
| **Wire 类型**                | `packages/core/src/network/wire-protocol.ts`（与 **shared** 对齐） |

更多表格式索引见根 **[README.md](../README.md)**「相关源码」表。

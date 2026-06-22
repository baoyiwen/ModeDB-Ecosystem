# ModeDB-Ecosystem 开发者手册

面向在应用、脚本或服务中**集成图谱存储、治理写入与只读查询**的开发者：汇总 **pnpm 工作区各包职责**、**`@mode-db/core`** 的公开 API（类、方法、典型用途），以及 **`@mode-db/sdk`** 的网络入口。实现细节与语义边界以源码与根目录 **[README.md](../README.md)** 为准。

| 需求                                                  | 文档                                                                                      |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 安装、构建、启动 **`modeldb-server`**、跑集成测试     | **[user-handbook.md](./user-handbook.md)**                                                |
| 部署、密钥、**`ModelDB` / `connectRemote`**、接入清单 | **[operations-manual.md](./operations-manual.md)**                                        |
| **`modeldb.config.json`** 路径与 **`workspace`**      | **[modeldb-config-guide.md](./modeldb-config-guide.md)**                                  |
| **`alterModel` / `dropModel` / Wire RPC**             | **[engine-meta-crud-and-wire.md](./engine-meta-crud-and-wire.md)**                        |
| 逻辑库目录与 **`atlas.mld`** 寻址                     | **[logical-workspace-and-single-file.md](./logical-workspace-and-single-file.md)**        |
| 架构、DX、链式查询深度说明                            | **[README.md](../README.md)**                                                             |
| 发布顺序与命令                                        | **[PUBLISH.md](./PUBLISH.md)**                                                            |
| 集成脚本命令                                          | **[test/README.md](../test/README.md)**（**`pnpm test`** / **`e2e-engine-workflow.ts`**） |

---

## 1. Monorepo 包职责

| 包                    | 路径              | 职责                                                                                                                                                                                   |
| --------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`@mode-db/core`**   | `packages/core`   | **AuthoringEngine**（写）、**ModelDBClient**（只读）、**QueryChain**、Vault、**registerPipeGalleryModels**、Wire 执行结果序列化等                                                      |
| **`@mode-db/common`** | `packages/common` | **PathResolver**、存储根、**manifest**、错误类、**DataType** / **ValueObject**、**DiagnosticCenter**、**EngineLogger**、**DiskAdapter**、**deriveAtlasVaultSecretFromConnectToken** 等 |
| **`@mode-db/shared`** | `packages/shared` | Wire 编解码、**WireQueryChain**、握手与 RPC 载荷类型（**不**依赖 core）                                                                                                                |
| **`@mode-db/server`** | `packages/server` | **modeldb-server** CLI、配置加载、WebSocket 查询与 Meta RPC 分发                                                                                                                       |
| **`@mode-db/sdk`**    | `packages/sdk`    | **ModelDB**、**connectRemote**、**RemoteModelDBClient**；仅依赖 **shared**                                                                                                             |

- **同进程**本地 Vault 读写：依赖 **`@mode-db/core`**（会拉取 **common** 等）。
- **仅远程**查询或 Meta：可只装 **`@mode-db/sdk`**（**不必**装 core）。

---

## 2. 引用方式

```bash
pnpm add @mode-db/core
pnpm add @mode-db/sdk
```

```ts
import {
  AuthoringEngine,
  ModelDBClient,
  configureModelDBStorageRoot,
  deriveAtlasVaultSecretFromConnectToken,
} from '@mode-db/core';
```

**密钥约定**

- **`AuthoringEngine`**：构造参数 **`connectToken`** 或环境变量 **`MODEL_DB_CONNECT_TOKEN`**（非空）；经 **`deriveAtlasVaultSecretFromConnectToken`** 打开 **`<storageRoot>/<atlas>/atlas.mld`**。
- **`ModelDBClient.connect(atlas)`**：要求 **`process.env.MODEL_DB_CONNECT_TOKEN`** 与治理端 / Server 的 **`connectToken`** **完全一致**（同一字符串派生 Vault 密钥）。

---

## 3. 存储与寻址（与 API 的关系）

- **存储根**：默认 **`<cwd>/data`**；由 **`MODEL_DB_STORAGE_ROOT` / `STORAGE_ROOT`**、**`configureModelDBStorageRoot({ storageRoot })`** 或 **`resolveModelDBStorageRoot()`** 决定（实现见 **`@mode-db/common`** 与引擎侧配置）。
- **推荐布局**：**`<storageRoot>/<atlasName>/atlas.mld`** 单文件 Vault（魔数 **`MDB4SVLT`**；**`fileLooksLikeAtlasSingleVault(path)`**、**`ATLAS_SINGLE_VAULT_MAGIC`**）。包内键含 **`__manifest__`**、**`m:<Model>`**、**`r:<Source>-<Target>-<Forward>`** 等。
- **`PathResolver`**：**`new PathResolver(storageRoot, atlasName)`**；**`atlasSingleVaultPath()`** 等。分文件树仍可能出现在兼容/迁移场景；**2.0 新库**以单文件 Vault 为准（见 **[logical-workspace-and-single-file.md](./logical-workspace-and-single-file.md)**）。
- **运行时配置别名**：**`configureModelDBRuntime`** 与 **`configureModelDBStorageRoot`** 在 facade 中为同一存储根配置（见 **`packages/core/facade/config.ts`**）。

---

## 4. 治理端：`AuthoringEngine`

**实现**：`packages/core/authoring/engine.ts`（入口亦经 `packages/core/src/authoring/AuthoringEngine.ts` 再导出）。

### 4.1 构造选项 `AuthoringEngineOptions`

| 字段                          | 作用                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------- |
| **`atlas`**（必填）           | 图谱目录名 → **`<storageRoot>/<atlas>/`**                                                         |
| **`storageRoot`**             | 存储根；缺省 **`resolveModelDBStorageRoot()`**                                                    |
| **`connectToken`**            | 与线协议一致；缺省 **`process.env.MODEL_DB_CONNECT_TOKEN`**。**须非空**（派生 Vault 密钥）        |
| **`currentLocale`**           | I18N 默认语言                                                                                     |
| **`paths`**                   | 注入 **`PathResolver`**（**`paths.atlasName`** 须等于 **`atlas`**）                               |
| **`registry`**                | 自定义 **`ModelRegistry`**（**`model()` / `relation()`** 需默认 **`AtlasRegistry`**，见源码断言） |
| **`shadowDiskEncoding`**      | 行级 shadow 编码（Vault 场景常关）                                                                |
| **`memoryShadowHydration`**   | 内存隐匿 + **`InternalVault`**                                                                    |
| **`enableSmartCache`**        | 查询指纹缓存                                                                                      |
| **`bufferFlushRowThreshold`** | 缓冲行阈值触发提前刷盘                                                                            |
| **`engineLogger`**            | 文件日志与诊断镜像                                                                                |

### 4.2 常用只读成员

| 成员                                                             | 说明                                            |
| ---------------------------------------------------------------- | ----------------------------------------------- |
| **`registry` / `storage` / `indexer` / `paths` / `persistence`** | 注册表、模型存储、关系索引、路径、持久化协调器  |
| **`atlasVault`**                                                 | **`AtlasSingleVault`**                          |
| **`internalVault`**                                              | 启用 **`memoryShadowHydration`** 时的内部 vault |

### 4.3 建模与关系

| 方法                                                                       | 说明                                                     |
| -------------------------------------------------------------------------- | -------------------------------------------------------- |
| **`registerModel(name, fields?, parentId?)`**                              | **`fields`**：**`Set<string>`** 或 **`FieldDefsRecord`** |
| **`registerRelation(source, target, forward, reverse, logic?, matchOn?)`** | 注册四元组关系                                           |
| **`quickLink(source, target, forward, reverse)`**                          | 自动注册缺失端点模型并 **`registerRelation`**            |
| **`updateModelFields(name, fields)`**                                      | 替换字段定义（数组或 **`FieldDefsRecord`**）             |
| **`updateRelationLogic(forwardName, logic, matchOn?)`**                    | 更新关系逻辑                                             |

### 4.4 入口句柄

| 方法                  | 说明                                                     |
| --------------------- | -------------------------------------------------------- |
| **`model(name)`**     | **`authoring/entity` 的 `ModelEntity`**：写 + 合并读查询 |
| **`relation(label)`** | **`RelationEntity`**（forward/reverse 标签解析）         |

### 4.5 按模型名的行级 API（与 `engine.model('X').insert` 等价类）

| 方法                                                       | 说明                                                  |
| ---------------------------------------------------------- | ----------------------------------------------------- |
| **`insert(modelName, data, options?)`**                    | **`options.sync`**：resolve 前 **`flushModelToDisk`** |
| **`update(modelName, id, partial, options?)`**             | 按 **`_id`** 合并                                     |
| **`delete(modelName, id, options?)`**                      | 软删 + 清理该实体出发的关系边                         |
| **`updateWhere(modelName, predicate, partial, options?)`** | 谓词命中批量更新                                      |
| **`deleteWhere(modelName, predicate, options?)`**          | 谓词命中批量删除                                      |

### 4.6 关系索引

| 方法                                        | 说明                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| **`bind(forwardName, strategy, options?)`** | **GLOBAL / PROTOCOL / CONDITIONAL / MANUAL**；先 **`flushPendingToDisk`** |
| **`unlink(forwardName, pairs)`**            | 移除 **[srcId, targetId]** 边                                             |

### 4.7 Meta-CRUD

| 方法                               | 说明                                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------- |
| **`alterModel(name, newSchema)`**  | 非破坏性：可增字段；**不可**删字段、改类型、放宽 **required**                             |
| **`alterModelPatch(name, patch)`** | 与当前 schema 合并后再 **`alterModel`**                                                   |
| **`dropRelation(relationName)`**   | 删关系定义与 **`r:*`** 索引，**`flushAll`**                                               |
| **`dropModel(modelName)`**         | **逻辑删**：清关系、注册表与 manifest；**`m:*` 物理块可能保留**（见源码注释与 Meta 文档） |

### 4.8 查询、运行时与刷盘

| 方法                        | 说明                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------- |
| **`query(modelName, ids)`** | 从 id 列表起步的 **`QueryChain`**（合并读）                                            |
| **`createRuntime()`**       | **`RuntimeContext`**：`registry` + 合并 **DataReader** + **IndexReader** + **`atlas`** |
| **`writeAtlasManifest()`**  | 将 manifest 写入 Vault **`__manifest__`** 并保存                                       |
| **`flushAll()`**            | 缓冲落盘 + 索引刷写 + manifest；供跨进程冷读                                           |

**别名**：**`Engine`** = **`AuthoringEngine`**（已弃用命名，建议用 **`AuthoringEngine`**）。

---

## 5. `ModelDBAdmin`

**`class ModelDBAdmin extends AuthoringEngine`**（`packages/core/authoring/admin.ts`）。

| 方法           | 说明                                                                  |
| -------------- | --------------------------------------------------------------------- |
| **`client()`** | **`ModelDBClient.fromContext(this.createRuntime())`**：同进程只读视图 |

---

## 6. 治理模型：`ModelEntity`（authoring）

**`packages/core/authoring/entity.ts`**：**`class ModelEntity extends RuntimeModel`**，带写缓冲与 **`RelationIndexer`** 访问。

| 方法 / 属性                                                                       | 说明                                                                            |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **`updateFields(fields)`**                                                        | **`string[]` 或 `FieldDefsRecord`**                                             |
| **`isDirty`**                                                                     | 是否有未刷盘暂存行                                                              |
| **`insert` / `insertMany` / `update` / `delete` / `updateWhere` / `deleteWhere`** | 写路径；**`InsertOptions` / `UpdateOptions` / `DeleteOptions`** 支持 **`sync`** |
| **`bind(relationForward, strategy, options?)` / `unlink(...)`**                   | 从当前模型解析关系后 **`indexer.bind` / `unlink`**                              |
| **`query(ids?)`**                                                                 | 省略 **`ids`** 则从**全表**起步                                                 |

**别名**：**`AuthoringModel`** → **`ModelEntity`**。

---

## 7. 治理关系：`RelationEntity`

**`packages/core/authoring/relation-entity.ts`**：**`extends RuntimeRelation`**。

| 方法                               | 说明                                                              |
| ---------------------------------- | ----------------------------------------------------------------- |
| **`updateLogic(logic, matchOn?)`** | 更新注册表内逻辑                                                  |
| **`bind(options?)`**               | **`strategy`**（默认 **PROTOCOL**）、**`pairs`**、**`condition`** |
| **`unlink(pairs)`**                | 移除边对                                                          |
| **`getStats()`**                   | 关系统计                                                          |
| **`clear()`**                      | 清空该关系索引                                                    |

**只读基类 `RuntimeRelation`**（`src/runtime/RuntimeRelation.ts`）：**`sourceModel` / `targetModel` / `forwardName` / `reverseName` / `logic` / `matchOn` / `getDefinition()`**。

**别名**：**`AuthoringRelation`** → **`RelationEntity`**。

---

## 8. 只读运行时：`ModelDBClient` 与 `RuntimeModel`

### 8.1 `ModelDBClient`（`packages/core/src/runtime/ModelDBClient.ts`）

| 成员                            | 说明                                                                             |
| ------------------------------- | -------------------------------------------------------------------------------- |
| **`static connect(atlasName)`** | 打开 **`<storageRoot>/<atlasName>/atlas.mld`**（**`MODEL_DB_CONNECT_TOKEN`**）   |
| **`static fromContext(ctx)`**   | 由 **`RuntimeContext`** 构造（Server 或 **`AuthoringEngine.createRuntime()`**）  |
| **`atlas`**                     | 当前图谱名                                                                       |
| **`getRuntimeContext()`**       | 取出 **`RuntimeContext`**                                                        |
| **`model(name)`**               | 返回 **`src/runtime/ModelEntity`**（**只读**薄包装，**无** `insert` / `update`） |
| **`relation(label)`**           | **`RuntimeRelation`** 元数据                                                     |

### 8.2 `RuntimeModel`（`src/runtime/RuntimeModel.ts`）

| 方法 / 属性                                    | 说明                                             |
| ---------------------------------------------- | ------------------------------------------------ |
| **`getSchema()` / `fields` / `parentId`**      | 模型定义                                         |
| **`getAncestors()` / `getInheritanceChain()`** | 继承链                                           |
| **`getAvailableRelations()`**                  | 可导航关系列表（**`RuntimeAvailableRelation`**） |
| **`query(ids?)` / `find(ids)`**                | 构造 **`QueryChain`**；省略 **`ids`** 为全表起点 |
| **`all()`**                                    | 返回当前模型全部行（大数据慎用）                 |

---

## 9. 链式查询：`QueryChain`

**文件**：`packages/core/src/runtime/query.ts`。由 **`RuntimeModel.query`** 或 **`AuthoringEngine.query`** 得到。

### 9.1 过滤与组合

| 方法                                         | 说明                                                                             |
| -------------------------------------------- | -------------------------------------------------------------------------------- |
| **`where(field, operator, value)`**          | 追加原子条件                                                                     |
| **`and(field, operator, value)`**            | 同 **`where`**                                                                   |
| **`or()`**                                   | 开始 OR 段                                                                       |
| **`filter(fn)`**                             | 自定义 **`RecordPredicate`**                                                     |
| **`matchAll(fn)`**                           | **`FilterBuilder`** 组合 AND                                                     |
| **`matchAllNodes(fn)`** / **`matchAny(fn)`** | **`PredicateComposer`** 产出 **`PredicateNode`** 树；**`matchAny`** 合并为 OR 段 |

### 9.2 关系跳转

| 方法                                                        | 说明                                                              |
| ----------------------------------------------------------- | ----------------------------------------------------------------- |
| **`relate(relationName, targetSetup?)`**                    | 沿关系前进；**`targetSetup`** 用 **`FilterBuilder`** 约束目标模型 |
| **`relateRecursive(relationName, options?, targetSetup?)`** | BFS 多级同关系；**`depth` / `maxDepth`** 默认 32，上限 10000      |

### 9.3 多维分析

| 方法                                      | 说明                                      |
| ----------------------------------------- | ----------------------------------------- |
| **`groupBy(fields)`** / **`pivot(keys)`** | 进入分析模式                              |
| **`aggregate(config)`**                   | 聚合配置（对象或 **`Aggregator`**）       |
| **`compute(spec)`** / **`compute(fn)`**   | 对象式指标或 **`ComputeBuilder`** 回调    |
| **`customReduce(outputKey, spec)`**       | 自定义桶内 reduce                         |
| **`wrapGroups()`**                        | 分组结果以 **`GroupInstance`** 暴露子查询 |

### 9.4 分页与执行

| 方法                                     | 说明                                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **`page(index)`** / **`limit(size)`**    | 0-based 分页；**`execute()`** 可返回 **`Paginated`**                                                                     |
| **`execute(options?)`**                  | 执行计划；**`QueryExecuteOptions`** 含 **`includeRelates`**、**`wrapGroups`** 等（分析路径对部分选项有限制，见源码校验） |
| **`analyze()`**                          | 分析管线入口（**`AnalysisResult`** / **`GroupInstance[]`**）                                                             |
| **`getQueryPlan()`**                     | 取 **`QueryPlanASTv2`**（调试 / 远程快照）                                                                               |
| **`getRemoteExecuteSnapshot(options?)`** | 供 **`@mode-db/shared`** 线计划序列化                                                                                    |

---

## 10. 查询结果：`HydratedEntity`

**`packages/core/src/runtime/HydratedEntity.ts`**：**`execute()`** 在 **`'rows'`** 模式下返回的实体包装。

| 方法                                                    | 说明                            |
| ------------------------------------------------------- | ------------------------------- |
| **`getModelName()`**                                    | 模型名                          |
| **`getData(deep?)` / `materializeRow()`**               | 明文行数据                      |
| **`getValue(fieldName)`**                               | **ValueObject**（含 I18N 等）   |
| **`getRelates()` / `getRelate(name)`**                  | 已加载的关联实体                |
| **`getRelationStatus(es)`** / **`getRelateDiagnostic`** | 关系追踪 / 诊断                 |
| **`explainRelate(relationName)`**                       | 异步展开 **`RelateDiagnostic`** |
| **`toNested()` / `toSnapshot()`**                       | 嵌套 JSON、不可变快照           |

---

## 11. Vault 与清单工具

| 符号                                                        | 说明                                                                          |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **`AtlasSingleVault`**                                      | 加密包读写（治理侧 **`AuthoringEngine`** 内部使用为主）                       |
| **`fileLooksLikeAtlasSingleVault`**                         | 文件头魔数检测                                                                |
| **`ATLAS_SINGLE_VAULT_MAGIC`**                              | 魔数字节串                                                                    |
| **`parseAtlasManifestJson` / `serializeAtlasManifestFile`** | manifest 文本 ↔ **`ModelRegistry`**                                           |
| **`ATLAS_MANIFEST_FILENAME` 等**                            | 常量（Vault 内键名为 **`__manifest__`**，与历史文件名常量区分见 common 文档） |

---

## 12. 数据类型、诊断与日志

从 **`@mode-db/core`** 再导出、亦可 **`@mode-db/common`** 直接引用：

- **`DataType`**、**`validateFieldValue`**、**`normalizeFieldDefs`**、**`ValueObject`** 族、**`ValidationError`**
- **`DiagnosticCenter`**、**`ValidationReport`**、**`ErrorCodes`**
- **`EngineLogger`**、**`DiskAdapter`**、**`SmartCache`**、**`InternalVault`**
- **`encodeMldLine` / `parseMldLine`**（shadow 行编解码辅助）

---

## 13. 网络与 Wire（core 侧辅助）

- **`serializeExecuteResultForWire`**、**`WireExecuteResultJson`**（**`execute-result-wire.ts`**）
- **`WireClientMessage`**、**`WireExecuteBody`** 等类型（**`wire-protocol.ts`**）
- **`deriveWireSessionKey` / `encodeWirePayload` / `decodeWirePayload`**（**`@mode-db/shared`** **`wire-codec.ts`**；SHA-256 与 Node **`crypto`** 字节级一致）
- **统一操作协议**：**`EngineOperation`**、**`apply` / `applyAll`**、**`executeDatabaseOperation`**；查询示例与 **`clearModelData` / `clearAllData`** 见 [engine-operation-protocol.md](./engine-operation-protocol.md)

**数据清除（保留 schema）**：**`AuthoringEngine.clearModelData(model)`**、**`clearAllData()`**；wire **`op: 'clearModelData' | 'clearAllData'`**；SDK **`RemoteModelDBClient.clearModelData` / `clearAllData`** 或 **`apply({ op: ... })`**。

---

## 14. 行业模板

- **`registerPipeGalleryModels()`**（**`templates/pipe-gallery/register.ts`**）：预置 **Pipe / Node / Monitor** 等模型。

---

## 15. 网络客户端：`@mode-db/sdk`

**入口**：`packages/sdk/src/index.ts`。

```ts
import { ModelDB, connectRemote, RemoteModelDBClient } from '@mode-db/sdk';
```

| API                                                                            | 说明                                                                                                                                                           |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`ModelDB`**                                                                  | **`constructor({ host, port, token, … })`**：**`listDatabases()`**、**`use(logicalDb)`** → **`RemoteModelDBClient`**                                           |
| **`connectRemote(options)`**                                                   | **`ConnectRemoteOptions`**：**`url`**、**`connectToken`**、**`atlas` 或 `dbName`**（逻辑库名）等；返回 **`RemoteModelDBClient`**                               |
| **`RemoteModelDBClient.connect(options)`**                                     | 同上                                                                                                                                                           |
| **`RemoteModelDBClient.connectNetwork({ host, port, token, database, ... })`** | **HTTP 源 + WebSocket stream** 的便捷封装（与 **`connectRemote`** 同协议）                                                                                     |
| **`toWsStreamUrl` / `toHttpOrigin`**                                           | URL 规范化                                                                                                                                                     |
| **`RemoteHydratedEntity`**                                                     | 与 **`HydratedEntity.getData`** 对齐的轻量行包装                                                                                                               |
| **Meta RPC**                                                                   | **`dropModel` / `dropRelation` / `alterModel`** 等经服务端 **`AuthoringEngine`** 执行（见 **[engine-meta-crud-and-wire.md](./engine-meta-crud-and-wire.md)**） |

SDK **不得**依赖 **`@mode-db/core`** 的磁盘实现；仓库 **`pnpm run check:sources`** 会约束来源。

**浏览器与二进制**：SDK 不依赖 **`buffer`** polyfill；线协议实现在 **`@mode-db/shared`** 中使用 **`Uint8Array`**、**`TextEncoder` / `TextDecoder`**、**`DataView`** 与 **`@noble/hashes`**。导出类型 **`WireBinaryBytes`**（**`Uint8Array` 别名**）便于与渲染管线对齐。详见 **[packages/sdk/README.md](../packages/sdk/README.md)** §「浏览器与二进制」。

---

## 16. `modeldb-server` CLI（建库与令牌）

安装 **`@mode-db/server`** 后，除 **`start`**、**`set`**、**`export-token`** 外，可使用：

| 子命令                     | 说明                                                                                                                                                                                                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`create-db <逻辑库名>`** | 在**当前会话根**解析出的 **`storageRoot`**（默认配置里 **`workspace: "vault"`** → **`<数据根>/vault`**）下创建 **`<逻辑库名>/atlas.mld`**。**无需**手工填绝对路径；可选 **`-c`** 指定会话根、**`-t`** 指定 **`connectToken`**。成功后 stderr 打印认证步骤（与 **`export-token`**、**`MODEL_DB_CONNECT_TOKEN`**、SDK **`dbName`** 对齐）。 |

实现：**`packages/server/src/cli-create-db.ts`**，内部使用 **`AuthoringEngine`** + **`loadModelDBServerConfig`**。详见 **[user-handbook.md](./user-handbook.md)** §5.1.1。

---

## 17. 构建与调试命令

```bash
pnpm install
pnpm run build          # shared → common → core → server → sdk
pnpm run build:core     # 仅 @mode-db/core
pnpm run dev            # packages/core tsc --watch
pnpm run meta-crud-audit
pnpm run check
```

---

## 18. 源码索引（精选）

| 能力                                 | 路径                                                          |
| ------------------------------------ | ------------------------------------------------------------- |
| **AuthoringEngine**                  | `packages/core/authoring/engine.ts`                           |
| **ModelEntity（写）**                | `packages/core/authoring/entity.ts`                           |
| **ModelDBClient**                    | `packages/core/src/runtime/ModelDBClient.ts`                  |
| **RuntimeModel / ModelEntity（读）** | `packages/core/src/runtime/RuntimeModel.ts`、`ModelEntity.ts` |
| **QueryChain**                       | `packages/core/src/runtime/query.ts`                          |
| **包入口导出**                       | `packages/core/index.ts`                                      |

更多表格见根 **[README.md](../README.md)**「相关源码」与第六节链式查询说明。

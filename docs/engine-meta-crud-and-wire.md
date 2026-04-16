# 引擎 Meta-CRUD、单文件 Vault 与线协议

本文说明治理端 **`AuthoringEngine`** 上的**元数据变更**（不改变行级数据的语义，但改变图谱拓扑或模型 schema），以及 **`@mode-db/server`** 上对应的 **Wire RPC** 与 **`@mode-db/sdk`** 的调用方式。阅读前建议已了解根目录 [README.md](../README.md) 中的单文件 Vault、`connectToken` 与存储根。

## 1. 单文件 Vault 与 `connectToken`

- 每个逻辑库目录 **`<storageRoot>/<atlas>/atlas.mld`** 为加密包；解密密钥由 **`deriveAtlasVaultSecretFromConnectToken(connectToken)`** 派生。
- 服务端 **`modeldb-server`** 的 **`connectToken`**（配置或 CLI）必须与治理端、**`ModelDBClient.connect`** / **`MODEL_DB_CONNECT_TOKEN`** 一致，否则无法读写同一 Vault。
- 包内键名约定（节选）：**`m:<Model>`** 模型 JSONL 明文负载；**`r:<source>-<target>-<forward>`** 关系双向索引 JSON；**`__manifest__`** 嵌入的拓扑与 **`fieldTypes`**。

## 2. `alterModel`（非破坏性 schema 合并）

**`AuthoringEngine.alterModel(name, newSchema: FieldDefsRecord)`**

- **允许**：在保留**已有全部字段名**的前提下**新增**字段；为新字段补充 **`FieldTypeDef`**；对已有字段，**类型不可变**；**`required: true` 不可改为 false**（避免放宽约束导致旧数据非法）。
- **拒绝**：删除字段、修改已有字段类型、将原必填改为非必填。
- 与 **`registerModel(..., FieldDefsRecord)`** / **`updateModelFields`** 使用同一套 **`normalizeFieldDefs`** 规则（**`DataType.*`** 或 **`'String'`** 等简写）。
- 成功后会写回 manifest 与 Vault 内 schema 头，并打 **`EngineLogger`** 的 **`[META]`** 行。
- **读侧兼容**：**`alterModel`** 追加可选字段后，持久化 JSONL 行可能仍缺少新键；**`ModelStorage`** 在解析行后按当前 schema **`materializeRowForCurrentSchema`** 补 **`default`** 或 **`undefined`**（不会为无 default 的必填字段捏造值）。

**`AuthoringEngine.alterModelPatch(name, patch: FieldDefsRecord)`**（Model Designer / 增量 DDL）

- 将 **`patch`** 与当前注册表中的字段定义**合并**后，再调用与 **`alterModel`** 相同的校验与落盘逻辑；调用方**只需**传新增或收紧的字段片段。

**典型用法**：上线后仅为某模型增加可选审计字段（如 `note: { type: 'String', required: false }`），且 **`newSchema` 必须仍包含原字段**（例如原有 `id`，则合并后的 record 要同时含 `id` 与 `note`）。若使用 **`alterModelPatch`**，可只传 **`{ note: { type: 'String', required: false } }`**。

## 3. `dropRelation`（移除关系与索引）

**`await engine.dropRelation(relationName: string)`**

- **`relationName`** 为关系的**正向边标签**（**`forward`**），与 **`bind(forwardName, ...)`** 一致。
- 行为：先 **`flushPendingToDisk`**；在 Vault 中删除对应 **`r:*`** 条目（或分文件布局下删除索引文件）；从注册表 **`unregisterRelation`**；**`flushAll`** 重写 manifest。
- 不删除两侧模型上的**行数据**；仅移除拓扑与邻接表。

## 4. `dropModel`（逻辑删除：注册表退役，物理 payload 暂留）

**`await engine.dropModel(modelName: string)`**

- 删除所有**触及该模型**的关系（与 **`dropRelation`** 相同的 Vault **`r:*`** 索引清理 + **`unregisterRelation`**）。
- **单文件 Vault**：**不**再搬迁 **`m:<model>`**；JSONL 仍留在包内，仅通过 **manifest / 注册表**使运行时**不可见**（为后续 **Compact / freelist** 预留空间回收；在未 compact 前**勿**复用同名模型，以免与陈旧行合并）。
- **分文件布局**：**`models/<Model>.mld`** 仍留在原路径；仅注册表 / manifest 退役，逻辑上不可见。
- 清空该模型的写缓冲、**`unregisterSchema`**、**`unregisterModel`**、**`AtlasRegistry.evictModelHandle`**、**`SmartCache`** 中与该模型相关的查询缓存，**`flushAll`** 重写 manifest。
- **`EngineLogger`** 输出 **`[META]`** 记录逻辑删除完成。

**注意**：**`ModelDBClient`** / 冷读 manifest **不会**再看到已 drop 的模型；取证或空间回收需离线读取仍存在的 **`m:*`** 分块（或日后专用 compact 工具）。

## 5. 线协议与 `modeldb-server`

RPC 明文 JSON 在发送前经 **`encodeWirePayload`**（**`@mode-db/shared`**：基于会话密钥的 XOR + **base64url**），对客户端表现为**混淆二进制**载荷（`WireRpcEnvelope.cipher`）；服务端 **`decodeWirePayload`** 还原后交给 **`WireRequestDispatcher`** 执行 **`AuthoringEngine`**。DDL 成功路径额外写入 **`EngineLogger`** 的 **`[REMOTE][META]`** 行（模块 **`Server`**），与治理端 **`[META]`** 区分。

请求体（**`WireExecuteBody`**）在 **`@mode-db/shared`** 中定义；服务端 **`request-dispatcher`** 在已解析逻辑库并构造 **`AuthoringEngine`** 后执行：

| `op`               | 载荷字段                                               | 服务端调用                                                                 |
| ------------------ | ------------------------------------------------------ | -------------------------------------------------------------------------- |
| **`dropModel`**    | `model`                                                | **`await engine.dropModel`**                                               |
| **`dropRelation`** | `relation`（正向名）                                   | **`await engine.dropRelation`**                                            |
| **`alterModel`**   | `model`, `schema`（JSON 对象）, 可选 **`patch: true`** | **`alterModelPatch`** 或 **`alterModel`**（cast 为 **`FieldDefsRecord`**） |

响应为 **`WireExecuteResultJson`** 中带 **`kind: 'mutation'`**、`**op**` 与 **`ok: true`** 的分支。

## 6. SDK：`RemoteModelDBClient` / `ModelDBClient.connect`

- **`RemoteModelDBClient.connectNetwork({ host, port, token, database, mode? })`**：`database` 即逻辑库目录名（与握手 **`dbName`** 一致）。
- **`ModelDBClient.connect(...)`**：与 **`connectNetwork`** 等价的薄别名，面向「仅网络、无本地引擎」场景。
- 元方法：**`dropModel(model)`**、**`dropRelation(relation)`**、**`alterModel(model, schema, opts?)`**（第三参 **`{ patch: true }`** 时走 **`alterModelPatch`**，载荷更小，适合 Designer）。

上述 RPC **仅在服务端进程内**执行写路径；客户端仍需合法 **`connectToken`** 与 WebSocket/HTTP 会话。

## 7. CLI：`modeldb-server start`

支持 **`modeldb-server start`**（可选前缀 **`start`**，参数见 **`packages/server/src/cli.ts`**），便于与进程管理器、文档中的「daemon + start」用法一致。

## 8. 集成测试与回归

- **`test/meta_crud_audit.ts`**：进程内 **`alterModel` → `dropRelation` → `dropModel`**（断言 **`dropModel` 后 `m:*` 仍在且非空**、**`orphan:m:*` 键未被创建**，以及 Vault **`r:*`** 在 **`dropRelation`** 后清空）；再起 **`startModelDBWebSocketServer`**，用 **`RemoteModelDBClient.connectNetwork`** 跑 RPC（含 **`alterModel(..., { patch: true })`**）。
- 默认串联在 **`npm run test:integration`** 末步（在 **`wire_server_audit`** 之后）；单跑：**`npm run meta-crud-audit`**。

## 9. 运维与后续工作

- **Compact**：未来可扫描 manifest 外的 **`m:*`** / 分文件 **`.mld`** 做空间回收；**`dropModel`** 当前不创建 **`orphan:m:*`** 键。
- 修改线协议或 dispatcher 时，应同步更新 **`@mode-db/shared`** 类型、**`@mode-db/sdk`** 的 **`executeWireBody`** 分支与 **`meta_crud_audit`**。

## 10. 物理层演进路线（与当前实现的差异）

当前实现（**单文件 Vault** + **JSONL `m:` 负载** / **分文件 `.mld`**）与「整块物理地址表 + Header 墓碑 + 同容量块复用」式引擎**不是同一套磁盘格式**。下列为**目标语义**与建议落地阶段，供后续大版本或独立存储后端演进：

| 目标                            | 当前行为                                                                                                                                                                    | 建议演进                                                                                         |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **模型级逻辑删除（Tombstone）** | Registry + manifest 退役；**`m:<name>`** / 分文件 **`.mld`** **原地保留**；内存 **`unregisterModel` / `evictModelHandle` / 缓冲清空**（见 **`AuthoringEngine.dropModel`**） | 未来可选 **`meta:inactive:m:<name>`**、Vault 内键搬迁或 Header 位图（需 Vault 版本号与迁移工具） |
| **碎片 / 空间回收**             | 行级删除走 **`PersistenceManager`** 缓冲墓碑 + flush 时 **compact rewrite**；逻辑删模型后 stale **`.mld`/`m:*`** 占位，**Compact** 未实现                                   | 维护 **freelist** 或扫描 manifest 外键回收；与 **Vault 加密块布局**强相关                        |
| **`alterModel` 仅追加字段**     | 内存 **`registry`/`ModelStorage.updateSchema`**；RPC 路径 **`flushAll`** 写 manifest；Vault 内模型体为 **JSONL 追加行**，schema 头在 flush 路径更新                         | 若引入定长列存，再在「仅追加列」时走 **segment 尾部 append**，避免全表 rewrite                   |

**`@mode-db/sdk`**：仅含 **`@mode-db/shared`** 上的连接、编解码与远程查询 façade；**不得**依赖 **`@mode-db/server`** / **`@mode-db/core`**。仓库根 **`pnpm run check:sources`** 含 **`scripts/assert-sdk-client-only.mjs`** 静态断言。

**Daemon**：**`startModelDBWebSocketServer`** 已可独立进程运行；**`buildDualTrackFastify`** 对 **`storageRoot`** **`mkdirSync(..., { recursive: true })`**；握手前 **`assertLogicalDatabaseExists`**——无 **`atlas.mld`**（或 workspace-flat 等价文件）则 **DATABASE_NOT_FOUND**。

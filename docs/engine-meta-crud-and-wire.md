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

**典型用法**：上线后仅为某模型增加可选审计字段（如 `note: { type: 'String', required: false }`），且 **`newSchema` 必须仍包含原字段**（例如原有 `id`，则合并后的 record 要同时含 `id` 与 `note`）。

## 3. `dropRelation`（移除关系与索引）

**`await engine.dropRelation(relationName: string)`**

- **`relationName`** 为关系的**正向边标签**（**`forward`**），与 **`bind(forwardName, ...)`** 一致。
- 行为：先 **`flushPendingToDisk`**；在 Vault 中删除对应 **`r:*`** 条目（或分文件布局下删除索引文件）；从注册表 **`unregisterRelation`**；**`flushAll`** 重写 manifest。
- 不删除两侧模型上的**行数据**；仅移除拓扑与邻接表。

## 4. `dropModel`（移除模型与邻接、保留数据快照）

**`await engine.dropModel(modelName: string)`**

- 删除所有**触及该模型**的关系（与 **`dropRelation`** 相同的索引清理 + unregister）。
- 若 Vault 中存在 **`m:<model>`** 负载，则将其**整体搬迁**到 **`orphan:m:<model>`**（便于日后 **Compact** 或取证；当前运行时与查询**不**再加载 orphan 键）。
- 清空该模型的内存缓冲、**`unregisterSchema`**、**`unregisterModel`**，并重写 manifest。
- **`EngineLogger`** 输出 **`[META]`** 说明已 drop。

**注意**：**`ModelDBClient`** 只读打开时**不会**看到已 drop 的模型；若需恢复数据，需离线工具读取 **`orphan:m:*`**（当前仓库未提供一键恢复命令）。

## 5. 线协议与 `modeldb-server`

请求体（**`WireExecuteBody`**）在 **`@mode-db/shared`** 中定义；服务端 **`request-dispatcher`** 在已解析逻辑库并构造 **`AuthoringEngine`** 后执行：

| `op`               | 载荷字段                       | 服务端调用                                               |
| ------------------ | ------------------------------ | -------------------------------------------------------- |
| **`dropModel`**    | `model`                        | **`await engine.dropModel`**                             |
| **`dropRelation`** | `relation`（正向名）           | **`await engine.dropRelation`**                          |
| **`alterModel`**   | `model`, `schema`（JSON 对象） | **`engine.alterModel`**（cast 为 **`FieldDefsRecord`**） |

响应为 **`WireExecuteResultJson`** 中带 **`kind: 'mutation'`**、`**op**` 与 **`ok: true`** 的分支。

## 6. SDK：`RemoteModelDBClient` / `ModelDBClient.connect`

- **`RemoteModelDBClient.connectNetwork({ host, port, token, database, mode? })`**：`database` 即逻辑库目录名（与握手 **`dbName`** 一致）。
- **`ModelDBClient.connect(...)`**：与 **`connectNetwork`** 等价的薄别名，面向「仅网络、无本地引擎」场景。
- 元方法：**`dropModel(model)`**、**`dropRelation(relation)`**、**`alterModel(model, schema)`**（**`schema`** 为普通 JSON 对象，与 **`FieldDefsRecord`** 同形）。

上述 RPC **仅在服务端进程内**执行写路径；客户端仍需合法 **`connectToken`** 与 WebSocket/HTTP 会话。

## 7. CLI：`modeldb-server start`

支持 **`modeldb-server start --workspace …`** 形式：第一个参数为 **`start`** 时，剩余参数按子命令解析，便于与进程管理器、文档中的「daemon + start」用法一致（详见 **`packages/server/src/cli.ts`**）。

## 8. 集成测试与回归

- **`test/meta_crud_audit.ts`**：进程内 **`alterModel` → `dropRelation` → `dropModel`**（断言 **`orphan:m:*`** 与 Vault **`r:*`** 清空）；再起 **`startModelDBWebSocketServer`**，用 **`RemoteModelDBClient.connectNetwork`** 跑一轮 RPC。
- 默认串联在 **`npm run test:integration`** 末步（在 **`wire_server_audit`** 之后）；单跑：**`npm run meta-crud-audit`**。

## 9. 运维与后续工作

- **Compact**：未来可扫描 **`orphan:m:*`** 做空间回收；当前行为仅为**搬迁**而非立即物理删除，避免误删后不可恢复。
- 修改线协议或 dispatcher 时，应同步更新 **`@mode-db/shared`** 类型、**`@mode-db/sdk`** 的 **`executeWireBody`** 分支与 **`meta_crud_audit`**。

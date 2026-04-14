# 集成测试说明（`test/`）

本目录包含 **集成 / 端到端脚本**（**非** Jest/Vitest 单元测试）。脚本通过 **`tsx`** 直接执行 TypeScript，默认读写仓库下的 **`data/`**（可用 **`MODEL_DB_STORAGE_ROOT`** / **`STORAGE_ROOT`** 覆盖）。**`integration-vault.ts`** 提供统一的 **`singleFileVault: true` + `MODEL_DB_VAULT_SECRET`**（集成密钥常量）。**`verify.ts`** 的 **`pipe` / `tran`** 以及 **`crud_audit`**、**`logic_integrity`**、**`query_chain_extended`**、**`logic_closure_audit`**、**`authoring_dx_audit`** 等脚本在集成场景下落盘为**仅 `atlas.mld` 的单文件 Vault**（不是 `atlas-manifest.json` + `models/` + `relations/` 分文件树；与根 README **「存储布局与 Atlas」** 一致）。除 **`vault_audit`** 故意测错密钥外，与 **`ModelDBClient.connect`** 共用同一密钥。

**引擎能力、治理端持久化、CRUD 缓冲区协议、合并读与 API 细节**见仓库根目录 **[README.md](../README.md)**（含 **「治理端持久化与开发者体验（DX）」** 与 **第六节** 链式查询 / 多维分析）。

---

## 如何运行

在仓库根目录执行：

```bash
npm run test:integration
```

顺序为：

1. **`verify.ts`**
2. **`query_filters.ts`**
3. **`logic_integrity.ts`**
4. **`logic_closure_audit.ts`**
5. **`query_chain_extended.ts`**
6. **`authoring_dx_audit.ts`**
7. **`crud_audit.ts`**
8. **`datatype_audit.ts`**
9. **`diagnostic_audit.ts`**
10. **`vault_audit.ts`**
11. **`wire_server_audit.ts`**

首项 **`verify.ts`** 启动时会**删除整个默认 `data/`**，保证从干净状态开始。其余脚本使用各自独立的 Atlas 名，互不覆盖；**末项 `wire_server_audit.ts` 复用 `verify` 已创建的 Vault 图谱 `pipe`**（依赖 **`data/pipe/atlas.mld`** 与集成 Vault 密钥环境）：

| 脚本                      | Atlas 名                       | 数据清理策略                                               |
| ------------------------- | ------------------------------ | ---------------------------------------------------------- |
| `verify.ts`               | `pipe` / `tran`                | **启动时删除整个 `data/`**                                 |
| `query_filters.ts`        | `query_filter_demo`            | 脚本内自删后重建                                           |
| `logic_integrity.ts`      | `integrity_pipe`               | 脚本内自删后重建                                           |
| `logic_closure_audit.ts`  | `pipe_system` / `tran_system`  | 脚本内自删后重建                                           |
| `query_chain_extended.ts` | `query_chain_extended`         | 脚本内自建 Atlas + Vault；**不**复用 `verify` 的 `pipe`    |
| `authoring_dx_audit.ts`   | `dx_audit`                     | 启动时仅删除 `data/dx_audit/`                              |
| `crud_audit.ts`           | `crud_audit`                   | 启动时仅删除 `data/crud_audit/`                            |
| `datatype_audit.ts`       | `datatype_audit`               | 启动时仅删除 `data/datatype_audit/`                        |
| `diagnostic_audit.ts`     | `diagnostic-audit`             | 启动时仅删除 `data/diagnostic-audit/`                      |
| `vault_audit.ts`          | `vault_audit_rt`               | 启动/结束清理 `data/vault_audit_rt/`（单文件 `atlas.mld`） |
| `wire_server_audit.ts`    | 复用 **`pipe`**（见 `verify`） | 不删目录；需 **`data/pipe/atlas.mld`** 已存在              |
| `million_stress_test.ts`  | `stress_atlas`                 | 启动时仅删除 `data/stress_atlas/`                          |

其他命令见下表。多维分析、高级审计等**未**默认并入 `test:integration`，合并前建议一并手跑或接入 CI。

---

## 命令对照表

| 命令                        | 入口文件                    | 说明                                                                                                                                                                                                                                                                                     |
| --------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run test:integration`  | 串联 11 个脚本（见上）      | 首步清空 `data/`；一键回归（含 **`vault_audit`**、**`wire_server_audit`**）                                                                                                                                                                                                              |
| `npx tsx test/verify.ts`    | `verify.ts`                 | 双图谱隔离、骨架补全、PROTOCOL 绑定、Runtime 只读                                                                                                                                                                                                                                        |
| `npm run query-filters`     | `query_filters.ts`          | 谓词树、AND/OR 短路、`matchAll` / `matchAny`、`getQueryPlan`、`includeRelates`                                                                                                                                                                                                           |
| `npm run integrity`         | `logic_integrity.ts`        | 句柄缓存、合并读、`insert({ sync: true })`、`explainRelate`、Vault **`r:*`** 关系索引注入                                                                                                                                                                                                |
| `npm run audit`             | `logic_closure_audit.ts`    | 多 Atlas 物理隔离、双向索引守恒、多级 `relate`、Runtime 只读                                                                                                                                                                                                                             |
| `npm run query-extended`    | `query_chain_extended.ts`   | `ComputeBuilder`、分析分页、`wrapGroups`、`relateRecursive`；**已**含于 `test:integration`                                                                                                                                                                                               |
| `npm run dx-audit`          | `authoring_dx_audit.ts`     | 合并辅助函数、`QueryEngine.execute`、句柄缓存、`updateFields` 去重、合并读、`insert sync`；**已**含于 `test:integration`                                                                                                                                                                 |
| `npm run crud-audit`        | `crud_audit.ts`             | CRUD 全链路（46 个断言）：update / delete / batch / 关系清理 / 模型独立性 / flush 压缩；**已**含于 `test:integration`                                                                                                                                                                    |
| `npm run datatype-audit`    | `datatype_audit.ts`         | DataType + ValueObject（114 个断言）：类型校验、required/default/isEmpty/save、I18N/Color/Unit、manifest；**已**含于 `test:integration`                                                                                                                                                  |
| `npm run diagnostic-audit`  | `diagnostic_audit.ts`       | DiagnosticCenter（**122** 个断言）：ErrorCodes 别名（含 **E3002**）、ErrorRegistry（含 E2005/E3002）、ValidationReport（isAllSuccess/getSummary/exportAsJSON/report 流式）、insertMany 批量、ValueObject 联动（required + type mismatch）、Emergency dump；**已**含于 `test:integration` |
| `npm run vault-audit`       | `vault_audit.ts`            | 单文件 Vault：目录零明文、`ModelDBClient.connect`、`relate`、manifest hydrate、错误密钥、**E3002**；**已**含于 `test:integration`                                                                                                                                                        |
| `npm run wire-server-audit` | `wire_server_audit.ts`      | WebSocket 服务 + **`@mode-db/sdk`**：`ConnectToken` 拒绝、**`connectRemote`**、**`RemoteHydratedEntity`**；**已**含于 `test:integration`（**必须**排在 `verify` 之后）                                                                                                                   |
| `npm run stress-test`       | `million_stress_test.ts`    | 压力测试（34 个断言）：100 万行灌入、1% 错误注入（E1001/E1003）、读写一致性、ValueObject 运行时监控、ErrorCodes 完整性、吞吐量报告。**未**并入默认集成                                                                                                                                   |
| `npm run first-run`         | `first_run.ts`              | 演示向；`pipe` 重建。**未**并入默认集成                                                                                                                                                                                                                                                  |
| `npm run transform`         | `transform_aggregate.ts`    | 多维分析全场景（语义见根 README **第六节 6.3**）。**未**并入默认集成                                                                                                                                                                                                                     |
| `npm run final-analysis`    | `final_analysis_test.ts`    | `global_atlas` / Stats 验收。**未**并入默认集成                                                                                                                                                                                                                                          |
| `npm run advanced-audit`    | `advanced_feature_audit.ts` | `geo_analytics`；`relateRecursive`、`wrapGroups`、`Paginated`。**未**并入默认集成                                                                                                                                                                                                        |

---

## 各脚本覆盖范围（断言什么）

### `verify.ts`

- 双图谱目录（`pipe` / `tran`）与注册表**物理隔离**；两图谱均 **`integrationVaultAuthoringOptions`** → 目录下**仅** **`atlas.mld`**（无 `models/` / `relations/` / 根级 `atlas-manifest.json`）。
- **骨架插入** + `updateFields` 补字段（滞后定义）。
- **PROTOCOL 绑定**与 **关系索引 `fwd` / `rev` 成对**：在 Vault 内校验 **`r:Pump-Zone-located_in`** 条目（语义与分文件 **`.rid`** 一致）。
- **`ModelDBClient.connect`** 与 Runtime **无写入 API**（`insert` / `updateFields` / `bind` 均为 `undefined`）。

### `query_filters.ts`

- **`QueryChain`** 谓词树：`where` / `is` / `gt` / `matchAll` / `matchAllNodes` / `matchAny`。
- **AND/OR 短路语义**：首假即停 / 首真即停，右侧兄弟不求值。
- **`getQueryPlan()`** → `QueryPlanASTv2` 结构验证。
- **`relate` 目标过滤** + **`includeRelates`**：`getRelateDiagnostic` / `failedPredicate` / `FILTERED_OUT_WHERE`。
- **`getRelationStatus`** / **`toSnapshot`**。
- **`FilterBuilder.compose`** + **`QueryEngine.matches`**（独立谓词树）。
- **`QueryEngine.evaluateInto`** + **`PredicateEvaluateContext`**。

### `logic_integrity.ts`

- **`engine.model(name)` 句柄缓存**：同一 `ModelEntity` 引用。
- **合并读**：`insert` 后、未 `flushAll` 时 `AuthoringEngine.query` 可见新行。
- **`insert(..., { sync: true })`** + `existsSync(atlas.mld)`（单文件 Vault）断言。
- **`explainRelate`** 各类原因：`NOT_REGISTERED` / `NO_LINK_IN_INDEX`。
- **Vault 包内 `r:*` 幽灵 target id** 注入 → `FILTERED_OUT_ORPHAN`（**`mutateVaultRelationData`**）。
- **`includeRelates`** + **`toNested()`** 级联结构。

### `logic_closure_audit.ts`

- 多 Atlas（`pipe_system` / `tran_system`）**物理隔离**（**单文件 Vault**）。
- **双向索引守恒**：`fwd` 边数 === `rev` 边数（包内 **`r:*`** 或分文件 **`.rid`** 同一语义）。
- **多级链式 `relate`**（Zone → Pump → Sensor 三级跳转）。
- **Runtime 只读安全性**。

### `first_run.ts`

演示用；**单文件 Vault**：治理 → **`flushAll`** → **`ModelDBClient.connect`** 查询（弱断言）。非严格回归核心。

### `transform_aggregate.ts` / `final_analysis_test.ts`

- 分组 / 透视 / `AnalysisResult` / `getTraceability` 等。
- **键名规则与管道语义**以根 README **第六节 6.3** 为准。
- 脚本内自建目录并断言具体指标与形态。

### `query_chain_extended.ts`

- 独立 Atlas **`query_chain_extended`** + **单文件 Vault**（与 **`verify`** 的 **`pipe`** 无依赖）。
- `ComputeBuilder` + `groupBy`。
- 分析按桶分页（`bucketCount` / `sliceBuckets` → `Paginated`）。
- `wrapGroups` + `GroupInstance`。
- `relateRecursive` BFS（含环防护）。

### `advanced_feature_audit.ts`

- `relateRecursive`、`wrapGroups` + `compute`、`Paginated`、`AnalysisResult` 单算子键名等。
- **默认不**在 `test:integration` 中。

### `authoring_dx_audit.ts`

- **`mergeDiskRowsWithAuthoringBuffer`**：同 `_id` 缓冲覆盖、仅磁盘 / 仅缓冲行、`pending` 为空等价磁盘快照。
- **`QueryEngine.execute` vs `evaluate`**：简单 atom 下单行结果一致。
- **`engine.model` 句柄缓存**、`updateFields(['id','name','id'])` 字段去重。
- **合并读**：`ModelEntity.insert` 后 `engine.query(...).execute()` 立即可见。
- **`engine.insert(..., { sync: true })`** + **`atlas.mld`** 存在性；结束 **`flushAll()`**。

### `crud_audit.ts`（46 个断言，10 个分组）

| 分组 | 覆盖点                                                                                                                                                              |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | **`mergeDiskRowsWithAuthoringBuffer`** `__deleted` 过滤：同 id 覆盖、墓碑行不出现、仅磁盘行保留、仅缓冲行追加                                                       |
| 2    | **`isDeletedRecord`** / **`DELETED_SENTINEL`** 工具函数正确性                                                                                                       |
| 3    | **insert 基线**：3 行插入成功                                                                                                                                       |
| 4    | **`ModelEntity.update(id, partial)`**：缓冲合并（`score` 覆盖）、未修改字段保留（`name`）、`_id` / `_createdAt` 不变、合并读即时可见、不存在 → `undefined`          |
| 5    | **`ModelEntity.delete(id)`**：墓碑写入缓冲、合并读立即不可见、全量查询行数正确、重复 delete → `false`、不存在 → `false`、已删行 update → `undefined`                |
| 6    | **`AuthoringEngine` facade**：`engine.update` 合并成功、`engine.delete` → `true` + query 不可见                                                                     |
| 7    | **`updateWhere` / `deleteWhere`**：条件批量更新（`status: active → archived`）、合并读行数一致、条件批量删除（`idle`）、`engine.updateWhere` / `engine.deleteWhere` |
| 8    | **关系层清理（模型独立性）**：bind → delete → 正向边清除、反向边不再含已删 id、其他实体边不受影响、目标模型 Zone 数据行不变                                         |
| 9    | **`deleteWhere` 批量关系清理**：条件删除后所有命中实体的**关系边**均被清理（Vault 为包内 **`r:*`**；分文件为 **`.rid`**）、未命中实体边不受影响、Pump 仅剩预期行    |
| 10   | **`{ sync: true }` + flush 压缩**：insert sync 后 **`atlas.mld`** 存在；delete/update sync 后 Vault 内 **`m:Item`** 明文 JSONL 无墓碑与已删 `_id`、含更新值         |

### `datatype_audit.ts`（114 个断言，20 个分组）

| 分组 | 覆盖点                                                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | **`updateFields`** typed record（含 Color/Unit）：`fields` 集合与 `fieldTypes` Map 同步更新；legacy `string[]` 路径 `fieldTypes` 为空 |
| 2    | **Pre-insert validation**：Int/Number/Boolean/DateTime/String/Color/Unit 各类型拒绝错误值；合法数据插入成功；null 非 required 通过    |
| 3    | **I18N insert auto-wrap**：plain string 自动包装为 `{ [locale]: value }`；object form 保持不变                                        |
| 4    | **I18N query**：`where('name', 'eq', '苹果')` 按 `currentLocale` 解析 `row.name[locale]` 命中；非当前 locale 值不命中                 |
| 5    | **Vault 模型 blob schema**：`m:HeaderTest` 首行以 `{"__schema__":` 开头；header 含 `fields` / `fieldTypes`；数据行正常解析            |
| 6    | **包内 `__manifest__` fieldTypes**：与 legacy manifest 相同字段；legacy model 无 `fieldTypes`                                         |
| 7    | **Backward compatibility**：untyped model（`string[]`）插入任意类型成功，不做校验                                                     |
| 8    | **DataType 常量**：9 个常量值与字符串一致（无 Enum）                                                                                  |
| 9    | **I18N without locale**：无 `currentLocale` 时 plain string 被拒绝；object form 接受                                                  |
| 10   | **Engine-level registerModel**：`registerModel(name, typedFields)` 与 `registerModel(name, Set)` 分别正确设置 `fieldTypes`            |
| 11   | **ValueObject — getValue()**：`I18NValue.get(lang)`、`IntValue.getData()`、`StringValue`、`JsonValue`、不存在字段 → `undefined`       |
| 12   | **Color type**：hex 插入成功、RGBA object 插入成功、无效 hex/数字被拒绝；`ColorValue.toHex()` / `.toCSS()` 输出正确                   |
| 13   | **Unit type**：`{value, unit}` 插入成功、字符串/NaN 被拒绝；`UnitValue.value` / `.unit` / `.convertTo()` 单位换算正确                 |
| 14   | **getData(deep)**：浅层返回**明文** record（含 memory shadow 场景）；深层包含 `_id` 与嵌套 `relates`                                  |
| 15   | **required 语义空值**：String 缺失/空串/全空格、I18N 空对象、Int null 均被拒绝；合法值通过；非 required 缺失通过                      |
| 16   | **default 值注入**：缺失字段自动填充 default（String/Int/Boolean/JSON）；显式值覆盖 default                                           |
| 17   | **default + required 组合**：缺失字段注入 default 后通过 required 校验；无 default 的 required 缺失抛错                               |
| 18   | **ValueObject.isEmpty()**：String 空串 true、I18N 有 key false / 空对象 true、Color 有效 false、Unit 有效 false、Int(0) false         |
| 19   | **ValueObject.update() required**：正常更新成功；required String update("") 抛错；非 required update("") 成功                         |
| 20   | **default 持久化到 manifest**：manifest fieldTypes 包含 `default` 字段值                                                              |

### `diagnostic_audit.ts`（122 个断言，18 个分组）

| 分组 | 覆盖点                                                                                                                                                                                                            |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | **ErrorCodes 命名别名**：14 个别名（含 **PHYSICAL_ADDRESS_CORRUPT → E3002**、SELF_REFERENTIAL_CYCLE 等）与数字码一一对应                                                                                          |
| 2    | **错误码注册表**：至少 **13** 个码（E1001–E3002，含 E2005）；各码 severity 正确（ERROR/FATAL/WARN）；中英文消息模板存在；E3001 消息含 "range"；**E3002=FATAL** 且消息含 vault/corrupt 语义                        |
| 3    | **report throw vs collect**：throw 模式抛 `ValidationError`；collect 模式推入 bag 不抛；返回 `Diagnostic` 含 code/severity/timestamp                                                                              |
| 4    | **report severity 覆盖**：第五参数 `severityOverride` 可将 ERROR 降级为 WARN；code 不变                                                                                                                           |
| 5    | **DiagnosticCenter.create**：不抛不通知，返回 Diagnostic；消息包含字段名                                                                                                                                          |
| 6    | **国际化消息**：`locale='en'` 消息含 "required"；`locale='zh'` 消息含 "必填"                                                                                                                                      |
| 7    | **onDiagnostic 监听器**：订阅捕获 diagnostic；取消订阅后不再捕获                                                                                                                                                  |
| 8    | **ValidationReport API**：rows/successCount/failureCount/totalSucceeded(deprecated)/totalFailed(deprecated)/ok/isAllSuccess()/hasWarnings/getSummary()/exportAsJSON()/errors()/warnings()/allDiagnostics() 全覆盖 |
| 9    | **validateFieldValue collect 模式**：合法值返回 true + 无 diagnostic；非法值返回 false + 收集 E1003；null required 收集 E1001                                                                                     |
| 10   | **validateFieldValue throw 向后兼容**：传 string locale 仍 throw；无第四参数仍 throw                                                                                                                              |
| 11   | **insertMany 批量校验**：5 行 → 2 成功 3 失败；失败行 index 正确；成功行有 data + \_id；query 仅返回成功行；exportAsJSON 含全部行                                                                                 |
| 12   | **insertMany 全部成功**：isAllSuccess()=true, successCount=3, errors 为空                                                                                                                                         |
| 13   | **ValueObject.update() DiagnosticCenter 联动**：`_diagCtx` 含 model/recordId；required empty → E1002；type mismatch → E1003；非 required 成功                                                                     |
| 14   | **Severity 分级**：IO_PERSISTENCE_FAIL=FATAL, SCHEMA_REQUIRED=ERROR, COLOR_AUTO_COERCED=WARN, VALUE_RANGE_OVERFLOW=ERROR                                                                                          |
| 15   | **toError 转换**：ERROR → ValidationError；FATAL + filePath → FileIOError                                                                                                                                         |
| 16   | **globalDiagnostics**：FATAL global 使 ok=false / isAllSuccess()=false；getSummary().hasFatal=true；allDiagnostics 包含 global                                                                                    |
| 17   | **ValidationReport 全成功场景**：isAllSuccess()=true, ok=true, exportAsJSON 所有行 success                                                                                                                        |
| 18   | **Emergency dump on flush failure**：磁盘写入失败时 flush 抛异常；.dump 文件已创建（primary 或 fallback）；.dump 包含缓冲数据                                                                                     |

### `vault_audit.ts`（13 个断言）

- **`singleFileVault`** + `vaultSecret`：`flushAll` 后仅存在 **`atlas.mld`**，无 **`atlas-manifest.json`** / **`models/`** / **`relations/`**。
- **`ModelDBClient.connect`**：依赖 **`MODEL_DB_VAULT_SECRET`**；**`getData()`** 返回明文字段；**`relate`** 从 Vault 内关系索引解析目标实体。
- **二次 `AuthoringEngine`**：从包内 **`__manifest__`** hydrate **Box / Item** 与关系定义。
- **错误密钥**：再次构造引擎时抛出 **`AtlasManifestError`**。
- **损坏文件**：覆写 `atlas.mld` 后 **`AtlasSingleVault.loadSync`** 返回 `false`，**`onDiagnostic`** 收到 **`E3002`（`PHYSICAL_ADDRESS_CORRUPT`）**。

### `wire_server_audit.ts`（6 个断言）

- **前置**：**`verify.ts`** 已创建 **`data/pipe/atlas.mld`**（Vault）；本脚本开头若缺少该文件则 **exit 1** 并提示先跑 **`verify`**。
- **环境**：调用 **`useIntegrationVaultEnv()`**，与服务端 **`loadModelDBServerConfig` 等价配置** 使用同一 **`INTEGRATION_VAULT_SECRET`**，保证 **`ModelDBClient.connect('pipe')`** 在服务端进程内可解密。
- **预检**：同进程 **`ModelDBClient.connect('pipe')`**，确保 Vault 密钥与 **`data/pipe`** 与线上一致后再起 WebSocket。
- **服务**：**`startModelDBWebSocketServer({ port: 0, storageRoot, connectToken, vaultSecret })`**，随机端口；**`getWebSocketServerListeningPort`** 读取实际端口。
- **SDK**：**`connectRemote`**（**`@mode-db/sdk`** 源码入口，**`tsx`** 直连 **`packages/sdk/src/index.ts`**）在 Node 下走 **`ws` 包**（与 **`ws` 服务器** 互操作）；**`model('Pump').query().execute()`**；断言 **`RemoteHydratedEntity`** 与 **`getModelName() === 'Pump'`**。
- **安全**：在成功 RPC 之后，**第二条**裸 **`ws`** 连接发送错误 **`connectToken`**，断言返回 **`{ type: 'error' }`**（避免与首次握手竞态干扰）。
- **收尾**：**`remote.close()`**、**`wss.close()`**。

### `million_stress_test.ts`（34 个断言，7 个阶段）

| 阶段 | 覆盖点                                                                                                                                                                       |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | **批量灌入**：100 万行 `Sensor`，每批 10,000；~0.5% 缺 `id`（→ E1001）、~0.5% `value` 类型错误（→ E1003）                                                                    |
| 2    | **诊断聚合**：`totalSuccess + totalFail = 1,000,000`；错误率 ~1%；拦截码包含 E1001 和 E1003                                                                                  |
| 3    | **读写一致性**：`Sensor.query().execute()` 行数 === `totalSuccess`                                                                                                           |
| 4    | **ValidationReport 聚合 API**：`getSummary()` 计数一致；`report()` 流式追加；`exportAsJSON()` 包含行与全局诊断                                                               |
| 5    | **ValueObject 运行时监控**：`update(null)` → E1002（SCHEMA_REQUIRED_EMPTY）；`update('not-a-number')` → E1003（TYPE_MISMATCH）                                               |
| 6    | **ErrorCodes 注册表完整性**：E1001/E1003/E2005/E3001/E1008 均已注册；`ErrorCodes` 别名对应正确；E2005 severity=ERROR 且消息含 "cycle"；E3001 severity=ERROR 且消息含 "range" |
| 7    | **Flush + 持久化**：`engine.flushAll()` 成功；**`atlas.mld`** 存在（含百万行 `m:Sensor`）                                                                                    |

---

## 写测试时的注意点

- **直读 `.mld` / manifest**：须在 **`await engine.flushAll()`** 或 **`insert/update/delete(..., { sync: true })`**（或等价刷盘）之后再 `existsSync` / `readFile`。
- **Vault**：断言「无分文件」时用 **`paths.atlasSingleVaultPath()`** 与 **`existsSync(paths.modelsDir()) === false`**；不要依赖读取明文 JSONL 文件（内容在密文包内）。集成脚本需设置与治理端一致的 **`MODEL_DB_VAULT_SECRET`** 再调用 **`ModelDBClient.connect`**。
- **同进程业务断言**：可依赖合并读，**不必**先 `flushAll`（见 `logic_integrity`、`crud_audit`）。
- **`delete` 后读 `.mld`**：flush 会触发压缩重写（全量读取 → 合并缓冲 → 过滤墓碑 → 原子写回），墓碑行不会残留在文件中。
- **关系层断言**：`delete` / `deleteWhere` 会清理**关系邻接表**（Vault：**`RelationIndexer`** 写回包内 **`r:*`**；分文件：**`.rid`**）。若需验证边状态，用 **`indexer.getForward` / `getReverse`** 或 **`loadVaultRelationData`**（Vault）即可。
- **Atlas 命名**：新测试脚本应使用独立的 Atlas 名，避免与已有脚本冲突。启动时用 `await rm(join(DATA_ROOT, ATLAS), { recursive: true, force: true })` 清理自身数据目录。
- **网络/SDK 测试**：**`wire_server_audit`** 依赖 **`verify`** 产出的 **`pipe`** 数据；单跑时执行 **`npx tsx test/verify.ts && npx tsx test/wire_server_audit.ts`**，或先保证 **`data/pipe/atlas.mld`** 存在后再 **`npm run wire-server-audit`**。修改 **`server/modeldb-server.ts`** 线协议时务必同步跑通本脚本。

---

## 与 CI / 本地检查

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm run check       # typecheck + lint + format:check
```

合并前建议：

```bash
npm run check
npm run build
npm run build:sdk
npm run test:integration   # 含 vault-audit + wire-server-audit（共 11 步）
npm run vault-audit        # 仅单文件 Vault 审计
npm run wire-server-audit  # 仅 WebSocket + SDK（需先有 verify 的 pipe）
# 按需补充：
npm run stress-test
npm run transform
npm run final-analysis
npm run advanced-audit
```

---

## 延伸阅读

- **产品说明、架构、CRUD 协议、使用指南、DX、链式查询、多维分析**：根目录 **[README.md](../README.md)**。

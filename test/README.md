# 集成测试说明（`test/`）

本目录包含 **集成 / 端到端脚本**（**非** Jest/Vitest 单元测试）。脚本通过 **`tsx`** 直接执行 TypeScript，默认读写仓库下的 **`data/`**（可用 `MODEL_DB_STORAGE_ROOT` / `STORAGE_ROOT` 覆盖；部分脚本会读取环境变量）。

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

首项 **`verify.ts`** 启动时会**删除整个默认 `data/`**，保证从干净状态开始。其余脚本使用各自独立的 Atlas 名，互不覆盖：

| 脚本                      | Atlas 名                      | 数据清理策略                        |
| ------------------------- | ----------------------------- | ----------------------------------- |
| `verify.ts`               | `pipe` / `tran`               | **启动时删除整个 `data/`**          |
| `query_filters.ts`        | `query_filter_demo`           | 脚本内自删后重建                    |
| `logic_integrity.ts`      | `integrity_pipe`              | 脚本内自删后重建                    |
| `logic_closure_audit.ts`  | `pipe_system` / `tran_system` | 脚本内自删后重建                    |
| `query_chain_extended.ts` | （复用前序数据）              | —                                   |
| `authoring_dx_audit.ts`   | `dx_audit`                    | 启动时仅删除 `data/dx_audit/`       |
| `crud_audit.ts`           | `crud_audit`                  | 启动时仅删除 `data/crud_audit/`     |
| `datatype_audit.ts`       | `datatype_audit`              | 启动时仅删除 `data/datatype_audit/` |

其他命令见下表。多维分析、高级审计等**未**默认并入 `test:integration`，合并前建议一并手跑或接入 CI。

---

## 命令对照表

| 命令                       | 入口文件                    | 说明                                                                                                                             |
| -------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `npm run test:integration` | 串联 7 个脚本（见上）       | 首步清空 `data/`；一键回归                                                                                                       |
| `npx tsx test/verify.ts`   | `verify.ts`                 | 双图谱隔离、骨架补全、PROTOCOL 绑定、Runtime 只读                                                                                |
| `npm run query-filters`    | `query_filters.ts`          | 谓词树、AND/OR 短路、`matchAll` / `matchAny`、`getQueryPlan`、`includeRelates`                                                   |
| `npm run integrity`        | `logic_integrity.ts`        | 句柄缓存、合并读、`insert({ sync: true })`、`explainRelate`、`.rid` 篡改                                                         |
| `npm run audit`            | `logic_closure_audit.ts`    | 多 Atlas 物理隔离、双向索引守恒、多级 `relate`、Runtime 只读                                                                     |
| `npm run query-extended`   | `query_chain_extended.ts`   | `ComputeBuilder`、分析分页、`wrapGroups`、`relateRecursive`；**已**含于 `test:integration`                                       |
| `npm run dx-audit`         | `authoring_dx_audit.ts`     | 合并辅助函数、`QueryEngine.execute`、句柄缓存、`updateFields` 去重、合并读、`insert sync`；**已**含于 `test:integration`         |
| `npm run crud-audit`       | `crud_audit.ts`             | CRUD 全链路（46 个断言）：update / delete / batch / 关系清理 / 模型独立性 / flush 压缩；**已**含于 `test:integration`            |
| `npm run datatype-audit`   | `datatype_audit.ts`         | DataType + ValueObject（87 个断言）：类型校验、I18N/Color/Unit、对象化访问、.mld header、manifest；**已**含于 `test:integration` |
| `npm run first-run`        | `first_run.ts`              | 演示向；`pipe` 重建。**未**并入默认集成                                                                                          |
| `npm run transform`        | `transform_aggregate.ts`    | 多维分析全场景（语义见根 README **第六节 6.3**）。**未**并入默认集成                                                             |
| `npm run final-analysis`   | `final_analysis_test.ts`    | `global_atlas` / Stats 验收。**未**并入默认集成                                                                                  |
| `npm run advanced-audit`   | `advanced_feature_audit.ts` | `geo_analytics`；`relateRecursive`、`wrapGroups`、`Paginated`。**未**并入默认集成                                                |

---

## 各脚本覆盖范围（断言什么）

### `verify.ts`

- 双图谱目录（`pipe` / `tran`）与注册表**物理隔离**。
- **骨架插入** + `updateFields` 补字段（滞后定义）。
- **PROTOCOL 绑定**与 `.rid` 正逆向成对校验。
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
- **`insert(..., { sync: true })`** + `existsSync(Pump.mld)` 文件存在断言。
- **`explainRelate`** 各类原因：`NOT_REGISTERED` / `NO_LINK_IN_INDEX`。
- **.rid 幽灵 id** 注入 → `FILTERED_OUT_ORPHAN`。
- **`includeRelates`** + **`toNested()`** 级联结构。

### `logic_closure_audit.ts`

- 多 Atlas（`pipe_system` / `tran_system`）**物理隔离**。
- **双向索引守恒**：`fwd` 边数 === `rev` 边数。
- **多级链式 `relate`**（Zone → Pump → Sensor 三级跳转）。
- **Runtime 只读安全性**。

### `first_run.ts`

演示用；治理 → `flushAll` → Runtime 查询的可读脚本（弱断言）。非严格回归核心。

### `transform_aggregate.ts` / `final_analysis_test.ts`

- 分组 / 透视 / `AnalysisResult` / `getTraceability` 等。
- **键名规则与管道语义**以根 README **第六节 6.3** 为准。
- 脚本内自建目录并断言具体指标与形态。

### `query_chain_extended.ts`

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
- **`engine.insert(..., { sync: true })`** + `Dx.mld` 存在性；结束 **`flushAll()`**。

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
| 9    | **`deleteWhere` 批量关系清理**：条件删除后所有命中实体的 `.rid` 边均被清理、未命中实体边不受影响、Pump 仅剩预期行                                                   |
| 10   | **`{ sync: true }` + flush 压缩**：insert sync 后 `.mld` 存在、delete sync 后 `.mld` 无已删 id 且无 `__deleted` 残留、update sync 后 `.mld` 含新值                  |

### `datatype_audit.ts`（87 个断言，14 个分组）

| 分组 | 覆盖点                                                                                                                                   |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | **`updateFields`** typed record（含 Color/Unit）：`fields` 集合与 `fieldTypes` Map 同步更新；legacy `string[]` 路径 `fieldTypes` 为空    |
| 2    | **Pre-insert validation**：Int/Number/Boolean/DateTime/String/Color/Unit 各类型拒绝错误值；合法数据插入成功；null 非 required 通过       |
| 3    | **I18N insert auto-wrap**：plain string 自动包装为 `{ [locale]: value }`；object form 保持不变                                           |
| 4    | **I18N query**：`where('name', 'eq', '苹果')` 按 `currentLocale` 解析 `row.name[locale]` 命中；非当前 locale 值不命中                    |
| 5    | **`.mld` schema header**：flush 后首行以 `{"__schema__":` 开头；header 包含 `fields` 数组与 `fieldTypes` 对象；数据行正常读取            |
| 6    | **`atlas-manifest.json` fieldTypes**：manifest model 条目包含 `fieldTypes`（含 Color/Unit 及 unit 元数据）；legacy model 无 `fieldTypes` |
| 7    | **Backward compatibility**：untyped model（`string[]`）插入任意类型成功，不做校验                                                        |
| 8    | **DataType 常量**：9 个常量值与字符串一致（无 Enum）                                                                                     |
| 9    | **I18N without locale**：无 `currentLocale` 时 plain string 被拒绝；object form 接受                                                     |
| 10   | **Engine-level registerModel**：`registerModel(name, typedFields)` 与 `registerModel(name, Set)` 分别正确设置 `fieldTypes`               |
| 11   | **ValueObject — getValue()**：`I18NValue.get(lang)`、`IntValue.getData()`、`StringValue`、`JsonValue`、不存在字段 → `undefined`          |
| 12   | **Color type**：hex 插入成功、RGBA object 插入成功、无效 hex/数字被拒绝；`ColorValue.toHex()` / `.toCSS()` 输出正确                      |
| 13   | **Unit type**：`{value, unit}` 插入成功、字符串/NaN 被拒绝；`UnitValue.value` / `.unit` / `.convertTo()` 单位换算正确                    |
| 14   | **getData(deep)**：浅层返回原始 record；深层包含 `_id`                                                                                   |

---

## 写测试时的注意点

- **直读 `.mld` / manifest**：须在 **`await engine.flushAll()`** 或 **`insert/update/delete(..., { sync: true })`**（或等价刷盘）之后再 `existsSync` / `readFile`。
- **同进程业务断言**：可依赖合并读，**不必**先 `flushAll`（见 `logic_integrity`、`crud_audit`）。
- **`delete` 后读 `.mld`**：flush 会触发压缩重写（全量读取 → 合并缓冲 → 过滤墓碑 → 原子写回），墓碑行不会残留在文件中。
- **关系层断言**：`delete` / `deleteWhere` 会自动清理 `.rid` 边；若需验证边状态，直接用 `indexer.getForward` / `getReverse` 即可，无需手动 flush 索引。
- **Atlas 命名**：新测试脚本应使用独立的 Atlas 名，避免与已有脚本冲突。启动时用 `await rm(join(DATA_ROOT, ATLAS), { recursive: true, force: true })` 清理自身数据目录。

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
npm run test:integration   # 含 dx-audit + crud-audit + datatype-audit
# 按需补充：
npm run transform
npm run final-analysis
npm run advanced-audit
```

---

## 延伸阅读

- **产品说明、架构、CRUD 协议、使用指南、DX、链式查询、多维分析**：根目录 **[README.md](../README.md)**。

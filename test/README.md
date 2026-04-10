# Mode DB Engine — 集成测试说明

本目录为**集成 / 端到端脚本**（非 Jest/Vitest 单元测试框架）。均通过 **`tsx`** 直接执行 TypeScript，默认读写仓库下的 **`data/`**（可通过 `MODEL_DB_STORAGE_ROOT` / `STORAGE_ROOT` 覆盖，其中 `logic_closure_audit` 会优先读环境变量）。

---

## 引擎是什么

**Mode DB Engine** 是一个面向**数据治理**与**数据资产图谱**的**超关系型**引擎：不依赖传统表内主外键来关联实体，而是通过**物理关系**（`Source` / `Target` / 正向 / 逆向四元组协议）把「点」与「线」解耦——**模型**只承载纯净属性（独立 `.mld`），**关系索引**单独落盘（`.rid`），二者在存储层隔离，便于多图谱、多进程与显式绑定策略。

交付上分为 **Authoring（治理端）** 与 **Runtime（客户端）**：治理端负责建模、插入、显式 `bind` 与写 `atlas-manifest.json`；Runtime 只读打开图谱，按 manifest 与文件查询，适合独立交付。

---

## 核心理念（与测试关注点）

| 理念         | 含义                                                          |
| ------------ | ------------------------------------------------------------- |
| **模型纯净** | 模型字段不承载外键污染；关联走关系协议与索引。                |
| **关系纯粹** | 关系为协议与索引，不混入业务数据列。                          |
| **物理隔离** | 一模型一 `.mld`、关系侧 `.rid`，Atlas 目录级图谱隔离。        |
| **显式绑定** | 索引不随 `insert` 自动全量重建；`bind` / `unlink` 显式控制。  |
| **双向守恒** | 正向 / 逆向索引成对写入，测试常校验 `.rid` 结构。             |
| **链式查询** | `QueryChain` 沿关系跳转再水合；谓词与聚合管道可复现、可断言。 |

**骨架优先**：`updateFields` 等可在后期补全 schema（字段名去重由引擎内部处理），与 `verify` 等「先插后补字段」场景一致。

---

## 技术优势（本仓库测试要守住的能力）

- **同进程读己写（透明合并）**：治理端 `insert` 先入**内存缓冲**，`MergedDataReader` 在 `QueryChain` / `DataReader` 路径上**合并磁盘与缓冲**；同一 `_id` 以**缓冲行为准**。同进程内**不必**为「立刻能查到」而先 `flushAll`（见 `logic_integrity` 中断言）。
- **写入与刷盘分层**：`insert` 为 **async**，返回 `Promise<ModelRecord>`；缓冲行由短间隔 **debounce**（约 80ms）触发 **`flushPendingToDisk`**，仅追加 `.mld`。**`flushAll()`** 才会在刷盘后再跑 **关系索引**与 **`atlas-manifest.json`**；`bind` / `unlink` 前会 `flushPendingToDisk` 以保证索引与文件一致。进程退出前 SIGINT/SIGTERM 会尽力注册过的 `flushAll`。
- **何时需要 `flushAll`**：另一进程要读**冷** atlas 文件、`ModelDBClient.connect` 依赖最新 manifest、或脚本用 `existsSync`/`readFile` **直接**检查 `.mld`/manifest 时，在断言前 **`await engine.flushAll()`**。
- **Runtime 只读**：`ModelDBClient.connect` 侧无 `insert`/`bind`/`updateFields`，审计脚本会校验。

---

## 治理端持久化与测试注意事项

- **合并读 vs 物理文件**：链式查询走合并读即可验证业务逻辑；**直读文件系统**时，行可能仍在缓冲或未写 manifest，须 **`await engine.flushAll()`** 后再断言（见 `logic_closure_audit` 等）。
- **`.mld` 与缓冲**：仅 `flushPendingToDisk` / `flushAll` 会把缓冲写入 `.mld`；未刷盘前，依赖 `MergedDataReader` 的查询仍可见新行。

---

## 一键跑全量集成（推荐）

在仓库根目录：

```bash
npm run test:integration
```

该脚本顺序执行：**`verify`** → **`query-filters`** → **`integrity`** → **`audit`** → **`query_chain_extended`**。首项 **`verify.ts`** 启动时会**删除整个默认 `data/` 目录**，保证从干净状态开始；后续脚本各自使用不同 Atlas 名（扩展测试在 `data/query_chain_extended` 自建目录），互不覆盖逻辑。

**多维分析管道**（根目录 [README.md](../README.md) 第六节「多维分析」小节）由 **`npm run transform`**（**`transform_aggregate.ts`**）覆盖，**未**并入 `test:integration`。**年份–国家–人口验收**由 **`npm run final-analysis`**（**`final_analysis_test.ts`**）覆盖，同样未并入全量集成。合并前建议与 **`test:integration`** 一并执行。

演示向脚本 **`first-run`**（会重建 `data/pipe`）未包含在全量命令中，需要时单独执行。

---

## 多维分析管道：实现逻辑与公开接口（现阶段）

以下与根目录 README **第六节** 多维分析描述一致，此处侧重**引擎顺序**、**键名规则**与**结果形态**，便于对照测试断言。

### 执行顺序（`QueryChain.execute()` 已配置 `groupBy` / `pivot`）

1. **过滤**：对候选行应用 **`QueryChain`** 谓词树（段内 AND、段间 OR 等）。
2. **分组**：按维度路径解析桶键元组。本地字段直接取值；**`关系名.目标字段路径`** 在注册表上解析关系后，取**首个**目标行（`_id` 字典序）再 **`readFieldPathSync`**。
3. **聚合**：每行落入一个桶，**`AggregatorEngine`** 流式写入 **`BucketAggregator`**；数值指标背后为 **`StatAccumulator`**（**Welford** 在线均值与 \(M_2\)，总体方差 \(\sigma^2=M_2/n\)，**`stdDev`** 为 \(\sqrt{\sigma^2}\)）。**`null` / `undefined` / 非有限数**等计入 **`missingCount`**，不参与 AVG / VARIANCE 等。

在无 **`relate` 跳步**、谓词不含 **`CallbackNode`**、且 **`DataReader.scanModelRecords`** 可用时，分析路径对 **`.mld` 行流**按上述顺序逐行处理。

### 分组键与 `__unlinked__`

- 解析关系时若**无边**（或无法得到目标行），或目标行上路径字段为 **`null` / `undefined`**，该维使用常量 **`__unlinked__`**（**`PIVOT_UNLINKED_KEY`**），与 **`PivotHydratedRecursiveBuilder` + `resolveHydratedPivotSegment`** 的语义对齐。
- 嵌套树键字符串化规则见 **`pivotSegmentKey`**（与桶键 JSON 元组一致）。

### `aggregate` / `compute` 输出键

- 配置形如 **`{ population: ['sum', 'avg', 'variance'] }`** 时，多算子展开为 **`{op}_{field}`**：如 **`sum_population`**、**`avg_population`**、**`variance_population`**（实现见 **`expandBuiltinAggregateSpec`**）。
- **同一字段仅一个算子时**（含 **`gdp: ['max']`** 这种单元素数组），输出键仍为**源字段名**（如 **`gdp`**），而非 **`max_gdp`**。
- **`count`** 表示桶内行数；与 **`customReduce`** 的输出键不可冲突。

### `QueryChain.execute()` 与分页 / 分组包装

- **无 `groupBy` / `pivot`**：先按谓词过滤（及可选 **`includeRelates`** 水合），再返回 **`HydratedEntity[]`**。
- **已配置 `groupBy` / `pivot`**：顺序仍为 **过滤 → 分组键 → 聚合**，返回 **`AnalysisResult`**；若链上 **`.wrapGroups()`** 或 **`execute({ wrapGroups: true })`**，则返回 **`GroupInstance[]`**（每桶含 **`getData()` / `getEntities()` / `query()`**）。
- **分页**：链式 **`.limit(n)`**、**`.page(i)`**（0 基）或 **`execute({ limit, page })`**。分页在 **过滤之后**应用；分析路径在 **聚合之后按桶**切片（内部 **`AnalysisResult.sliceBuckets`**），扁平 / 水合路径则对行数组切片。启用分页时 **`execute()`** 返回 **`Paginated<T>`**：**`{ items, total, page, limit, pageCount }`**，请用 **`isPaginatedExecuteResult`** 收窄类型（源码中 **`execute` 返回 `Promise<any>`** 以兼容旧调用）。
- **`analyze()`**：等价于已配置分组时的 **`execute()`**，但若启用了分页则只返回 **`items`**（**`AnalysisResult` 或 `GroupInstance[]`**），不带 **`Paginated`** 外壳。

### `compute` 与 **`ComputeBuilder`**

- **对象式**：**`compute({ field: 'sum' \| 'avg' \| …, population: ['sum','avg'] })`**，与 **`aggregate`** 的键合并规则一致（冲突抛错）。
- **回调式**：**`compute((f) => [f.sum('n'), f.avg('x')])`**，由 **`ComputeBuilder`** 生成与对象式相同的内部协议（见 **`mergeComputeTokens`** / **`isComputeMetricToken`**）。

### `relateRecursive`

- 自当前链起点沿关系名 **BFS** 展开；**`depth`** 上限；全局 **`seen`** 防止图中成环导致死循环。实现见 **`src/runtime/recursive-relate.ts`**（**`collectRecursiveRelationIdsBFS`** 等）。

### `AnalysisResult`

| 方法                                     | 含义                                                                                                                                                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`bucketCount`**（只读）                | 当前结果中的**分组桶数量**（键字典序与 **`sliceBuckets`** 一致）。                                                                                                                                                              |
| **`sliceBuckets(pageIndex, limit)`**     | 按桶键排序后切片，返回**新的** **`AnalysisResult`**（元数据子集同步），用于 **`execute` 分页**路径。                                                                                                                            |
| **`asTree()`**                           | 嵌套对象：按维度顺序下钻，**叶节点为扁平指标键值**（无 `aggregates` 包裹），便于 ECharts 等直接使用。                                                                                                                           |
| **`asMatrix()`** / **`asFlatTable()`**   | 行数组；**每行一个对象**，**维度列与指标列合并**（如 **`year`**, **`country`**, **`sum_population`**, **`gdp`**）。                                                                                                             |
| **`getMetadata()`**                      | **`AnalysisRunMetadata`**：`pipeline: 'filter_then_group_then_aggregate'`、**`dimensionKeys`**、各桶 **`dimensionValues`**、各指标 **`validSampleCount` / `missingSampleCount` / `resultHint`**（如全缺失 **`all_missing`**）。 |
| **`getTraceability()`**                  | 在元数据之上增加每桶 **`unlinkedOrBrokenPath`**（维度值中含 **`__unlinked__`**）及 **`summary`**（含 **`bucketsWithUnlinkedPath`**、**`bucketsWithMetricGaps`**）。                                                             |
| **`toAnalysisReport('tree' \| 'flat')`** | 兼容旧 **`AnalysisReport`** 形态。                                                                                                                                                                                              |

全缺失数值指标时，最终值为 **`traceableNull(reason)`**（**`isTraceableNull`**），与 **`0`** 区分。

### 递归透视（`HydratedEntity[]`）

- **`PivotTable.nestedTreeFromHydrated`** / **`createHydratedBuilder`**：对已 **`includeRelates`** 水合的实体按维度递归下钻，叶上 **`BucketAggregator`**，物化叶形与 **`asTree()`** 一致（扁平指标）。
- **`isMetricsLeafShape`**：判断嵌套对象是否为「仅含指标标量 / `traceableNull` 的叶形」，测试里用于统计子分组键。

### 相关源码索引

| 模块                                                                    | 路径                                 |
| ----------------------------------------------------------------------- | ------------------------------------ |
| 查询链、分析执行入口、`Paginated`、`ComputeBuilder` 导出                | `src/runtime/query.ts`               |
| 聚合引擎、分组键解析、`AnalysisResult`、**`buildAnalysisTraceability`** | `src/runtime/transform-engine.ts`    |
| Welford、`BucketAggregator`、`traceableNull`                            | `src/runtime/stat-accumulator.ts`    |
| 维度路径解析                                                            | `src/runtime/group-dimension.ts`     |
| 水合实体递归透视                                                        | `src/runtime/pivot-from-hydrated.ts` |
| **`ComputeBuilder`**、指标 token                                        | `src/runtime/compute-builder.ts`     |
| **`GroupInstance`**                                                     | `src/runtime/group-instance.ts`      |
| 递归关系 BFS、深度与防环                                                | `src/runtime/recursive-relate.ts`    |

---

## 命令对照表

| 命令                       | 入口文件                    | 典型 Atlas / 数据                                                                                                                          |
| -------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run test:integration` | 串联见上                    | 首步清空 `data/`                                                                                                                           |
| `npx tsx test/verify.ts`   | `verify.ts`                 | `pipe`、`tran`；**启动时删除 `data/`**                                                                                                     |
| `npm run query-filters`    | `query_filters.ts`          | `query_filter_demo`（脚本内自删子目录后重建）                                                                                              |
| `npm run integrity`        | `logic_integrity.ts`        | `integrity_pipe`（自删后重建）；含 **`.rid` 手工篡改**                                                                                     |
| `npm run audit`            | `logic_closure_audit.ts`    | `pipe_system`、`tran_system`（自删后重建）                                                                                                 |
| `npm run first-run`        | `first_run.ts`              | `pipe`（自删后重建）；Authoring → flush → Runtime 演示                                                                                     |
| `npm run transform`        | `transform_aggregate.ts`    | `transform_agg_demo`、`transform_audit_pipeline`；多维分析全场景（README 第六节）                                                          |
| `npm run final-analysis`   | `final_analysis_test.ts`    | `global_atlas`；**Stats** 年×国×人口/GDP 闭环验收                                                                                          |
| `npm run query-extended`   | `query_chain_extended.ts`   | `query_chain_extended`；**ComputeBuilder**、分析/扁平分页、**`wrapGroups`**、**`relateRecursive`**（亦已并入 **`test:integration`** 末尾） |
| `npm run advanced-audit`   | `advanced_feature_audit.ts` | `geo_analytics`；四大项：**`relateRecursive`**、**`wrapGroups`+`compute`**、**`Paginated`**、**`AnalysisResult`+单算子键名**               |

---

## 各文件职责与覆盖能力

### `verify.ts`

- **双图谱** `pipe` / `tran` 目录与注册表隔离。
- **滞后字段**：`quickLink` 骨架 → 先 `insert` → `updateFields` 再插入完整数据。
- **PROTOCOL** 绑定、**`.rid` 正反向边成对**。
- **`ModelDBClient.connect`**、链式 `query` / `relate` / `execute`，Runtime **无写入 API**。
- 使用 **`assert` 计数**汇总通过/失败（非遇错即停）。

### `query_filters.ts`

- 对应根目录 README **第六节** 与 `predicate-tree` / `filter-builder` / `query.ts`。
- 链式 **`where` / `is` / `gt` / `greaterThan`**、段内 **AND**、**`.or()`** 段间 **OR**。
- **`matchAll`**（闭包内 **`FilterBuilder`** 累积条件）、**`matchAllNodes`**（嵌套 **`PredicateComposer`**）、**`matchAny`** + **`getQueryPlan`（QueryPlanASTv2）**。
- **`filter`（CallbackNode）**、**`relate` 目标过滤**、**`includeRelates`**。
- **`getRelateDiagnostic`**（`FILTERED_OUT_WHERE` + **`failedPredicate`**）、**`getRelationStatus`**、**`toSnapshot().relationStatus`**。
- **`evaluatePredicate`** 的 **AND/OR 短路**；**`FilterBuilder.compose`** + **`QueryEngine.matches`**；**`QueryEngine.evaluateInto`** + **`PredicateEvaluateContext`**（如 `ATTRIBUTE_MISMATCH`、`OR_UNSATISFIED`）。

### `logic_integrity.ts`

- **合并读（DX）**：`Zone.insert` / `Pump.insert` 后、在调用 `flushAll` 之前，用 `AuthoringEngine.query(...).execute()` 断言可见新行（`MergedDataReader` 合并磁盘与缓冲）。
- **`HydratedEntity`**：**`explainRelate`**、未注册关系、**`NO_LINK_IN_INDEX`**。
- 向 **`.rid` 注入幽灵 target id** → **`FILTERED_OUT_ORPHAN`**；**`includeRelates`** + **`toNested()`** 级联。
- 扁平 **`execute`** 与链式跳转结果形态。

### `logic_closure_audit.ts`

- Atlas **物理隔离**（`pipe_system` / `tran_system`）、跨图谱 **不得** `model` 到对方模型。
- **双向索引守恒**、真实 **`.rid`** 读写校验。
- **多级链式** `relate`、`includeRelates`、Runtime 只读路径。

### `first_run.ts`

- **演示/点火**：治理端建图、**`flushAll`**、Runtime **`connect`** 与查询。
- 适合人工阅读控制台输出，**不作为**严格断言回归套件的核心依赖。

### `transform_aggregate.ts`（多维分析 / README 第六节）

对应根目录 README **第六节** 多维分析描述。脚本内自删 **`data/transform_agg_demo`**、**`data/transform_audit_pipeline`**（审计用）后重建 **Zone / Pump** 与 **`has_pump` / `in_zone`** 绑定。

**脚本开头（不连库）**

- **`assertStreamingAccumulatorContract`**：**`StatAccumulator`** 的 **`missingCount` / `validCount`** 与 **`BucketAggregator`** 单桶流式 **AVG / COUNT**。

**主图谱 `transform_agg_demo`**

- **`PivotTable.nestedTreeFromHydrated`**：维度 **`['year','country']`**、**`['year','in_zone.label','country']`**；断言叶上 **population / n** 与 **`getLeafAggregatorAtPath` → `StatAccumulator`** 状态。
- **`groupBy(['year','country'])` + `compute` + `execute()` → `AnalysisResult`**：**`asTree()`** 叶为扁平 **`population` / `growthRate` / `n`**。
- **`aggregate({ population: ['sum','avg'], n: 'count' })`**：**`asFlatTable()`** 行内 **`year` / `country` / `sum_population` / `avg_population` / `n`**；**`getMetadata()`** 中 **`sum_population`** 的样本统计；**`getTraceability()`** 汇总字段存在性。
- **`asMatrix()` + `stdDev`**：按 **`country`** 分组。
- **`groupBy(['in_zone.label','country'])`**：关系路径键 + **扁平行**访问（如 **`r['in_zone.label']`**）。
- **`between` + `aggregate(Aggregator)` + `pivot`**：管道式 **CN 2020** 的 **sum / avg**。
- **幽灵字段 `ghostAvg` + `avg`**：**`traceableNull(all_missing)`** 与 **`getMetadata().resultHint`**。
- **`customReduce` + `compute` 混用**；**同输出键冲突**须抛错；**`analyze()`** 与已配置透视时的 **`execute()`** 等价。

**审计图谱 `transform_audit_pipeline`（审计项 8–10 + 递归透视）**

- **审计 8**：**`pivot(['year','country'])` + `between(year)`**，树第一层年份键数量与第二层 **CN / US** 叶数量（**`isMetricsLeafShape`** 识别叶）。
- **审计 9**：**`groupBy(['varBucket'])` + `metricV: 'variance'`**，与手算 \(\sum(x-\mu)^2/n\)（如 **[10,20,30] → 200/3**）一致。
- **审计 10**：**`groupBy(['in_zone.label'])`**，华北/华南 **population** 行和。
- **递归透视 + `__unlinked__`**：**`includeRelates: true`** 的 **Pump** 经 **`PivotTable.nestedTreeFromHydrated(..., ['year','in_zone.label'], ...)`**，无效 **zoneId** 行落在 **`__unlinked__`** 下且 **population** 和正确。

### `final_analysis_test.ts`（验收脚本）

- 自删 **`data/global_atlas`**，**`registerModel('Stats')`**，字段 **year / country / population / gdp**，三条 **2026 + China** 样本（人口 10/20/30，GDP 不同）。
- **`matchAll((f) => { f.gt('year', 1990); })`**（注意：**`matchAll`** 接收 **`FilterBuilder` 回调**，不是返回数组）。
- **`aggregate({ population: ['sum','avg','variance'], gdp: ['max'] })` + `pivot(['year','country'])`**：断言 **`asTree()['2026']['China']`** 上 **`sum_population` / `avg_population` / `variance_population`** 与 **`gdp === 150`**（单算子 **`max`** 时键名仍为 **`gdp`**）。
- **`getTraceability()`**、**`asFlatTable()`** 合并列断言。

### `query_chain_extended.ts`（链式扩展回归）

- 自删 **`data/query_chain_extended`**，**`Node`** 自环 **`has_child`**（**`parentId`**）小图：**root → c1 → c2**。
- **`ComputeBuilder` + `compute((f) => [f.sum('n')])` + `groupBy`** → **`isAnalysisResult`**。
- **分析按桶分页**：**`groupBy(['label'])` + `compute({ n: 'count' })` + `limit(2)` + `page(0|1)`** → **`isPaginatedExecuteResult`**，断言 **`total` / `pageCount`** 与每页 **`items` 的 `bucketCount`**（覆盖 **`sliceBuckets`** 路径）。
- **扁平分页**：无分组时 **`.limit(2).page(0)`** → **`total === 3`**、**`items.length === 2`**。
- **`wrapGroups()`**：**`GroupInstance[]`**，**`isGroupInstance`**、**`getEntities()`** 计数、**`query().execute()`** 拉回成员 **`c1`**。
- **`relateRecursive('has_child', { depth: 4 })`**：自 **root** 展开，断言 **root / c1 / c2** 均在结果集中（环防护不死循环）。

单独运行：**`npm run query-extended`**；全量集成已包含本文件。

### `advanced_feature_audit.ts`（高级功能综合审计）

- 自删 **`data/geo_analytics`**，**Region** 自关联 **`sub_regions`**（**`parentId` → `id`**），三层样例数据。
- **审计 1**：**`query([种子 _id]).relateRecursive('sub_regions', { depth: 2 })`** — 引擎约定 **含种子**，共 **5** 条（R1 + 两省 + 两城）。
- **审计 2**：**`wrapGroups()` + `compute((f) => [f.sum, f.avg])`** — **`GroupInstance`**、**`sum_population`** / **`avg_population`**、**`getEntities()`**。
- **审计 3**：全表 **`.page(1).limit(2)`** — **`isPaginatedExecuteResult`**、**`total` / `pageCount`**。
- **审计 4**：同过滤+分组但**无** **`wrapGroups`** — **`isAnalysisResult`**；单字段单 **`sum`** 时扁平行键为 **`population`**（非 **`sum_population`**）。

运行：**`npm run advanced-audit`**（默认**不**并入 **`test:integration`**，合并前建议手跑或自行加入流水线）。

---

## 与 CI / 本地检查的配合

根目录还提供：

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm run check       # typecheck + lint + format:check
```

建议在合并前至少：**`npm run check`**、**`npm run test:integration`**（已含 **`query_chain_extended`**），以及 **`npm run transform`**、**`npm run final-analysis`**（覆盖透视、多算子键名、**`getTraceability`**、Welford 方差与扁平行形态）。若只调试链式扩展，可单独 **`npm run query-extended`**；高级四项合一审计见 **`npm run advanced-audit`**。

---

## 根文档索引

语义化查询、**`HydratedEntity`** 溯源、**`QueryEngine.evaluateInto`** 及 **多维分析管道**（**`AnalysisResult`**、**`pivot` / `aggregate`**）见仓库根目录 **[README.md](../README.md)** 第六节与「集成验证」小节。

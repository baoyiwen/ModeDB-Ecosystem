# 集成测试说明（`test/`）

本目录包含 **集成 / 端到端脚本**（**非** Jest/Vitest 单元测试）。脚本通过 **`tsx`** 直接执行 TypeScript，默认读写仓库下的 **`data/`**（可用 `MODEL_DB_STORAGE_ROOT` / `STORAGE_ROOT` 覆盖；部分脚本会读取环境变量）。

**引擎能力、治理端持久化、写缓冲、`insert({ sync: true })`、合并读与 API 细节**见仓库根目录 **[README.md](../README.md)**（含 **「治理端持久化与开发者体验（DX）」** 与 **第六节** 链式查询 / 多维分析）。

---

## 如何运行

在仓库根目录执行：

```bash
npm run test:integration
```

顺序为：**`verify.ts`** → **`query_filters.ts`** → **`logic_integrity.ts`** → **`logic_closure_audit.ts`** → **`query_chain_extended.ts`**。

首项 **`verify.ts`** 启动时会**删除整个默认 `data/`**，保证从干净状态开始；其余脚本使用各自 Atlas 名或自建子目录，互不覆盖逻辑。

其他命令见下表。多维分析、高级审计等**未**默认并入 `test:integration`，合并前建议一并手跑或接入 CI。

---

## 命令对照表

| 命令                       | 入口文件                    | 说明与数据目录                                                    |
| -------------------------- | --------------------------- | ----------------------------------------------------------------- |
| `npm run test:integration` | 串联见上                    | 首步清空 `data/`                                                  |
| `npx tsx test/verify.ts`   | `verify.ts`                 | `pipe`、`tran`；**启动时删除 `data/`**                            |
| `npm run query-filters`    | `query_filters.ts`          | `query_filter_demo`（脚本内自删后重建）                           |
| `npm run integrity`        | `logic_integrity.ts`        | `integrity_pipe`；合并读、`insert({ sync: true })`、`.rid` 篡改等 |
| `npm run audit`            | `logic_closure_audit.ts`    | `pipe_system`、`tran_system`                                      |
| `npm run first-run`        | `first_run.ts`              | 演示向；`pipe` 重建                                               |
| `npm run transform`        | `transform_aggregate.ts`    | 多维分析全场景（语义见根 README **第六节 6.3**）                  |
| `npm run final-analysis`   | `final_analysis_test.ts`    | `global_atlas` / Stats 验收                                       |
| `npm run query-extended`   | `query_chain_extended.ts`   | 已含于 `test:integration` 末尾；亦可单独调试                      |
| `npm run advanced-audit`   | `advanced_feature_audit.ts` | `geo_analytics`；**未**并入默认集成                               |

---

## 各脚本覆盖范围（断言什么）

### `verify.ts`

双图谱目录与注册表隔离；骨架插入 + `updateFields` 补字段；PROTOCOL 绑定与 `.rid` 成对；`ModelDBClient.connect` 与 Runtime **无写入 API**。

### `query_filters.ts`

`QueryChain` 谓词、`FilterBuilder` / `PredicateComposer`、`getQueryPlan`、`includeRelates`、短路语义、`QueryEngine` 等（与根 README **第六节** 链式查询小节对应）。

### `logic_integrity.ts`

- `engine.model(name)` **句柄缓存**（同一 `ModelEntity` 引用）。
- **合并读**：`insert` 后、未 `flushAll` 时 `AuthoringEngine.query` 可见新行。
- **`insert(..., { sync: true })`** + `existsSync(Pump.mld)`。
- `explainRelate` 各类原因、`.rid` 幽灵 id → `FILTERED_OUT_ORPHAN`、`includeRelates` / `toNested()`。

### `logic_closure_audit.ts`

多 Atlas 物理隔离、双向索引守恒、多级链式 `relate`、Runtime 只读。

### `first_run.ts`

演示用；非严格回归核心。

### `transform_aggregate.ts` / `final_analysis_test.ts`

分组 / 透视 / `AnalysisResult` / `getTraceability` 等，**键名规则与管道语义**以根 README **第六节 6.3** 为准；脚本内自建目录并断言具体指标与形态。

### `query_chain_extended.ts`

`ComputeBuilder`、分析分页、`wrapGroups`、`relateRecursive` 等。

### `advanced_feature_audit.ts`

`relateRecursive`、`wrapGroups`+`compute`、`Paginated`、`AnalysisResult` 单算子键名等；**默认不**在 `test:integration` 中。

---

## 写测试时的注意点

- **直读 `.mld` / manifest**：须在 **`await engine.flushAll()`** 或 **`insert(..., { sync: true })`**（或等价刷盘）之后再 `existsSync` / `readFile`。
- **同进程业务断言**：可依赖合并读，**不必**先 `flushAll`（见 `logic_integrity`）。

---

## 与 CI / 本地检查

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm run check       # typecheck + lint + format:check
```

合并前建议：**`npm run check`** + **`npm run test:integration`**，并按需 **`npm run transform`**、**`npm run final-analysis`**、**`npm run advanced-audit`**。

---

## 延伸阅读

- **产品说明、架构、使用指南、DX、链式查询、多维分析**：根目录 **[README.md](../README.md)**。

# Mode DB Engine

一个**超关系型数据引擎**，用于数据治理与数据资产图谱构建。

它不依赖传统数据库的主外键机制来关联数据，而是通过**物理关系**将实体连接在一起——模型只存储纯净的属性数据，关系作为独立的四元组协议存在，两者在物理层面完全隔离。

代码库在 **2.0** 之后分为两条交付线：

- **Authoring（治理端）**：建模、插入、显式绑定索引、写 `atlas-manifest.json`。
- **Runtime（客户端）**：仅按图谱名称打开只读视图，查询 `.mld` / `.rid`，不依赖写入路径，适合独立交付给第三方。

> 本项目处于早期设计与实现阶段。

---

## 核心理念

### 为什么不用主外键？

传统关系型数据库通过在模型中嵌入外键（`user_id`、`department_id`）来表达关联。这种做法将**关系信息污染到了模型本身**，导致：

- 模型字段随关系增多而膨胀
- 关系变更需要修改模型表结构
- 难以表达多对多、层级继承等复杂拓扑

Mode DB Engine 采用完全不同的思路：

```
传统方式:  User { name, email, department_id }     ← 外键嵌入模型
本引擎:    User { name, email }                     ← 模型纯净
           Relation(User → Department, "属于", "包含")  ← 关系独立存储
```

### 五条铁律

| 规则         | 说明                                                              |
| ------------ | ----------------------------------------------------------------- |
| **模型纯净** | 模型只存储属性，严禁存储外键、状态位或 ID 关联                    |
| **关系纯粹** | 关系仅为四元组协议 `(Source, Target, Forward, Reverse)`，不存数据 |
| **继承锁定** | 子模型在创建时锁定 `parentId`，且不可更改                         |
| **链式查询** | 查询通过模型跳转 ID 集合，最后才进行数据填充（Lazy Hydration）    |
| **存储隔离** | 每个模型的数据物理隔离，存储在独立的 `.mld` 文件中                |

### 2.0 核心原则

| 原则         | 说明                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------- |
| **原子注册** | 模型注册通过 `AuthoringEngine` 统一入口，同步初始化 Registry 与 Storage                           |
| **骨架优先** | 支持先注册空壳模型/关系，后期通过 `updateFields` / `updateLogic` 补全定义                         |
| **双向守恒** | 关系必须以「正向/逆向」四元组成对存在；索引写入与删除保证正向/逆向成对                            |
| **显式绑定** | 索引构建不随 `insert` 自动触发；支持 GLOBAL、PROTOCOL、CONDITIONAL、MANUAL，通过 `bind` 显式执行  |
| **物理隔离** | 模型属性存于 `.mld`，关系索引存于 `.rid`，互不交叉                                                |
| **图谱隔离** | 每个 **Atlas（图谱）** 在存储根下独占目录；多图谱并行时数据与 manifest 互不干扰                   |
| **双轨 OO**  | 「点」：`engine.model(name)` → `ModelEntity`；「线」：`engine.relation(label)` → `RelationEntity` |
| **双向对称** | `engine.relation('located_in')` 与 `engine.relation('contains_equip')` 共享同一底层定义，操作等价 |

---

## 架构：Authoring 与 Runtime

### 系统架构图

下图概括调用方向与落盘关系：**Runtime 只读路径**仅连接 `ModelFileReader` / `RelationIndexFileReader` 与 manifest，不经过 `ModelStorage` / `RelationIndexer` 的写入实现。

为在各类 Markdown 预览（含不支持 Mermaid 的环境）中稳定显示，架构图使用仓库内的 **SVG** 矢量图；图中标注为英文以避免字体与编码差异导致乱码。

![Mode DB Engine 系统架构](docs/architecture.svg)

源文件：[docs/architecture.svg](docs/architecture.svg)（可直接用浏览器或设计工具打开编辑。）

### 模块目录对照（文本）

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         index.ts（包入口）                                │
├────────────────────────────────────┬────────────────────────────────────┤
│  Authoring（治理端）                 │  Runtime（客户端 / 可独立分包）      │
│  authoring/                        │  src/runtime/                      │
│  ├─ engine.ts      AuthoringEngine │  ├─ ModelDBClient.connect(atlas)   │
│  ├─ admin.ts       ModelDBAdmin    │  ├─ ModelEntity（只读）             │
│  ├─ entity.ts      ModelEntity     │  ├─ RuntimeModel / RuntimeRelation │
│  ├─ relation-entity.ts             │  ├─ ModelFileReader（只读 .mld）   │
│  ├─ storage.ts     ModelStorage    │  ├─ RelationIndexFileReader(.rid)│
│  ├─ indexer.ts     RelationIndexer │  └─ query.ts → QueryChain          │
│  └─ atlas-registry.ts              │                                    │
│                                    │  runtime/index.ts → 再导出上述 API   │
├────────────────────────────────────┴────────────────────────────────────┤
│  common/          共享类型、Registry 接口、manifest、错误、存储根解析       │
│  src/common/      PathResolver（Atlas 下路径解析）                        │
└─────────────────────────────────────────────────────────────────────────┘
                                      │
                    STORAGE_ROOT / <atlasName>/
                    ├── atlas-manifest.json
                    ├── models/*.mld
                    └── relations/*.rid
```

**约束**：`src/runtime/` 下的实现**不**依赖 `authoring/storage`、`authoring/indexer` 等写入侧模块；`ModelDBClient.connect()` 仅通过只读 Reader 与 manifest 工作。

**别名**：`Engine` 为 `AuthoringEngine` 的兼容导出；`Runtime` 为 `ModelDBClient` 的兼容导出。

---

## 存储布局与 Atlas

默认存储根为 `<cwd>/data`（可通过环境变量 `MODEL_DB_STORAGE_ROOT` / `STORAGE_ROOT` 或 `configureModelDBStorageRoot` 覆盖）。

每个图谱（Atlas）对应一级子目录，例如管廊 `pipe`、轨道 `tran`：

```
data/
├── pipe/                          # 图谱「pipe」
│   ├── atlas-manifest.json        # 模型/关系清单与校验（Runtime connect 依赖）
│   ├── models/
│   │   ├── Pump.mld
│   │   └── Zone.mld
│   └── relations/
│       └── Pump-Zone-located_in.rid
└── tran/
    ├── atlas-manifest.json
    ├── models/
    │   └── Train.mld
    └── relations/
```

- **`.mld`**：JSONL，每行一条模型记录（仅 Schema 声明字段落盘）。
- **`.rid`**：JSON，`fwd` / `rev` 双向邻接表；由 `RelationIndexer` 成对维护，经 `flushAll()` 等落盘。

治理端写入或更新图谱后，应调用 `await engine.flushAll()`（或等价地刷新索引并写 manifest），以便 `ModelDBClient.connect('图谱名')` 能读到最新 `atlas-manifest.json`。

下文 **「治理端持久化与开发者体验（DX）」** 描述写缓冲、定时调度与合并读；若仅需快速上手，可跳到 **「使用指南」**。

---

## 治理端持久化与开发者体验（DX）

### `updateFields(fields: string[])`

- **入参**：`readonly string[]`；内部用 `new Set(fields)` **去重**，并保留 **首次出现顺序**。
- **效果**：同步更新 Registry 与 `ModelStorage` 的 schema，与后续 `.mld` 落盘字段一致。

### 写缓冲（Write-Behind，`Map<_id, ModelRecord>`）

- **`PersistenceManager`** 维护 `recordBuffers: Map<modelName, Map<recordId, ModelRecord>>`；同一 `_id` 再次写入时**覆盖**为较新行。
- **`ModelEntity`**：`private readonly _buffer` 与 `getOrCreateModelBuffer(name)` 为**同一引用**。
- **`AtlasRegistry.model(name)`**：**缓存** `ModelEntity` 实例，多次 `engine.model('Pump')` 返回**同一对象**，保证写缓冲与 `insert` 状态连续。

### 自动化调度与进程收尾

- **200ms 定时器**：`AuthoringEngine` 构造时启动 `setInterval`。若 `persistence.hasBufferedRows()` 为真，则调用 **`flushPendingToDisk()`**（仅将缓冲**追加到 `.mld`**，不更新关系索引与 manifest）。
- **`beforeExit`**：`process.once('beforeExit', () => void engine.flushAll())`，在进程即将退出事件循环前尽力执行 **`flushAll()`**（缓冲 → `.mld` → 关系索引 → `atlas-manifest.json`）。
- **信号**：`registerAuthoringShutdownTask` 在 **SIGINT / SIGTERM** 时调用各引擎注册的 **`flushAll()`**。
- **`process.on('exit')`** 中无法可靠执行异步 IO；强一致落盘请使用 **`insert(..., { sync: true })`** 或显式 **`await engine.flushAll()`**。

### 合并读与 `QueryEngine`

- **`MergedDataReader`**：`getAll` / `getByIds` / `scanModelRecords` 合并磁盘行与 `getPendingSnapshot`；**同一 `_id` 以缓冲为准**。
- **`findFirstByFieldEq`**：**先**查缓冲，**再**扫磁盘，避免未刷盘行被磁盘旧行抢先命中。
- **`mergeDiskRowsWithAuthoringBuffer(diskRows, pendingById)`**（`src/runtime/query-engine.ts`）：与「磁盘行 + 缓冲 Map」合并语义一致，便于工具层复用。
- **`QueryEngine.execute`** 与 **`evaluate`** 等价（单行谓词）；**完整查询**行集由 **`DataReader`**（已合并）再进入 `QueryChain.execute` / 聚合，**sum / avg** 等与合并后视图一致。

### `insert` 与可选 `{ sync: true }`

- **默认**：`await model.insert(data)` 将行放入写缓冲；同进程内 **`await query().execute()`** 可通过合并读立即看到新行，**不必**先 `flushAll`。
- **`{ sync: true }`**：`await model.insert(data, { sync: true })` 或 `await engine.insert(modelName, data, { sync: true })` 在该 promise **resolve 前**对该模型执行 **`flushModelToDisk`**（将该模型当前缓冲批量写入 `.mld`）。适用于**财务 / 强一致**等场景。
- **风险**：未刷盘前进程崩溃可能丢失缓冲内数据；跨进程读文件或 `existsSync('.mld')` 断言前，须 **`flushAll`** 或 **`insert(..., { sync: true })`**。

### 代码示例（治理端）

```typescript
import { AuthoringEngine } from 'mode-db-engine';

const engine = new AuthoringEngine({ atlas: 'my_atlas' });
engine.registerModel('Item', new Set(['id', 'name']));

const Item = engine.model('Item');

Item.updateFields(['id', 'name', 'id']); // 重复字段名会被去重

const row = await Item.insert({ id: 'i1', name: 'A' });
await engine.query('Item', [row._id]).execute();

await Item.insert({ id: 'i2', name: 'B' }, { sync: true });

await engine.flushAll();
```

**Runtime**：`ModelDBClient.connect(atlas)` **无** `insert` / `updateFields` / `bind`，只读已落盘数据与 manifest。

### 相关源码

| 模块                                                      | 路径                               |
| --------------------------------------------------------- | ---------------------------------- |
| 写缓冲、`flushPendingToDisk` / `flushModelToDisk`         | `authoring/persistence-manager.ts` |
| `ModelEntity`、`InsertOptions`、`insert`                  | `authoring/entity.ts`              |
| `AuthoringEngine`、调度、`beforeExit`                     | `authoring/engine.ts`              |
| `mergeDiskRowsWithAuthoringBuffer`、`QueryEngine.execute` | `src/runtime/query-engine.ts`      |
| 磁盘 + 缓冲合并读                                         | `authoring/merged-data-reader.ts`  |

---

## 使用指南

### 0. 存储根（治理端与 Runtime 共用）

```typescript
import { configureModelDBStorageRoot } from 'mode-db-engine';
import { join } from 'node:path';

configureModelDBStorageRoot({ storageRoot: join(process.cwd(), 'data') });
```

Runtime 的 `ModelDBClient.connect()` 使用同一套 `resolveModelDBStorageRoot()` 解析根路径。

### 1. 初始化治理端（多图谱示例）

推荐使用 **`AuthoringEngine`**（或兼容别名 `Engine`）。每个实例绑定一个 `atlas` 名称，数据落在 `STORAGE_ROOT/<atlas>/`。

```typescript
import { AuthoringEngine } from 'mode-db-engine';

const pipe = new AuthoringEngine({ atlas: 'pipe' });
const tran = new AuthoringEngine({ atlas: 'tran' });

// 也可显式指定 storageRoot（集成测试常用）
// new AuthoringEngine({ atlas: 'pipe', storageRoot: '/var/model-db' });
```

### 2. 注册模型与关系

```typescript
// 方式 A：完整注册
pipe.registerModel('User', new Set(['name', 'email']));
pipe.registerModel('Department', new Set(['code', 'label']));
pipe.registerRelation('User', 'Department', '属于', '包含', 'many-to-one', {
  sourceField: 'deptCode',
  targetField: 'code',
});

// 方式 B：quickLink 骨架（模型不存在则自动创建空壳）
pipe.quickLink('Pump', 'Zone', 'located_in', 'contains_pump');
```

### 3. ModelEntity —「点」的 OO 句柄（Authoring）

```typescript
const Pump = pipe.model('Pump');
const Zone = pipe.model('Zone');

// 骨架补全：先插入时未声明字段会被过滤，再 updateFields 后插入完整数据
Pump.updateFields(['name', 'zoneCode']);
Zone.updateFields(['code', 'label']);

const pump = await Pump.insert({ name: '主循环泵-1', zoneCode: 'Z-A' });

const allPumps = await Pump.all();
const zoneRows = await Pump.find([pump._id]).relate('located_in').execute();
const zones = zoneRows.map((h) => h.getData());

const relations = Pump.getAvailableRelations();
```

| 方法                                 | 说明                                                                |
| ------------------------------------ | ------------------------------------------------------------------- |
| `.updateFields(fields)`              | 传入 `string[]`，内部去重后更新 Schema 并同步存储层（见上文 DX 节） |
| `.insert(data, options?)`            | 插入记录（过滤未声明字段）；可选 **`{ sync: true }`** 见上文 DX 节  |
| `.all()` / `.find(ids)` / `.query()` | 全量、按 ID 或链式查询                                              |
| `.bind(fwd, strategy, …)`            | 从模型侧触发该关系的索引构建                                        |
| `.unlink(fwd, pairs)`                | 按对解除链接                                                        |
| `.getAvailableRelations()`           | 继承感知的关系列表                                                  |

### 4. RelationEntity —「线」的 OO 句柄

```typescript
const locRel = pipe.relation('located_in');
// 与 pipe.relation('contains_pump') 等价，共享同一 RelationDefinition

locRel.updateLogic('many-to-one', { sourceField: 'zoneCode', targetField: 'code' });
await locRel.bind({ strategy: 'PROTOCOL' });

await locRel.bind({
  strategy: 'CONDITIONAL',
  condition: (src) => ((src as Record<string, unknown>)['power'] as number) > 50,
});

const stats = await locRel.getStats();
await locRel.unlink([[srcId, targetId]]);
await locRel.clear();
```

### 5. 绑定策略

| 策略            | 说明                                               |
| --------------- | -------------------------------------------------- |
| **GLOBAL**      | Source × Target 全量笛卡尔连边                     |
| **PROTOCOL**    | 按已注册的 `matchOn` 字段相等匹配                  |
| **CONDITIONAL** | 在 PROTOCOL 匹配基础上再套用 `condition(src, tgt)` |
| **MANUAL**      | 显式传入 `pairs: [srcId, targetId][]`              |

绑定后需 **`await engine.flushAll()`**（或至少 flush 索引并写 manifest）再交给只读客户端连接。

### 6. 链式查询（QueryChain）与 HydratedEntity

Authoring 与 Runtime 共用同一 **`QueryChain`** 实现，底层只依赖 **`DataReader` / `IndexReader`**。过滤条件的**内部协议**定义在 **`src/runtime/predicate-tree.ts`**：**`PredicateNode`** = **`AtomNode`**（`field` + `op` + `value`）| **`GroupNode`**（`logic: 'AND' | 'OR'` + `children`）| **`CallbackNode`**（`filter(fn)`）。**`evaluatePredicate`** / **`QueryEngine.evaluate`** 对单行递归求值。

**短路语义（与布尔运算一致）**

- **AND**：按 `children` 顺序求值；**第一个为假的子节点**决定失败结果并**立即返回**，**右侧兄弟不再求值**（含嵌套子树内的 AND 同样短路）。
- **OR**：**第一个为真**即成功返回，**后续兄弟不再求值**；若**全部**为假，**`failedAt`** 指向该 **OR `GroupNode`**。

**`execute()`** 始终返回 **`HydratedEntity[]`**。**`execute({ includeRelates: true })`** 在边上填充 **`getRelate`**；若为空，**`getRelateDiagnostic`** 可区分 **`NOT_REGISTERED`** / **`NO_LINK_IN_INDEX`** / **`FILTERED_OUT_ORPHAN`** / **`FILTERED_OUT_WHERE`**。其中 **`FILTERED_OUT_WHERE`**（及源实体未过跳前过滤时）可带 **`failedPredicate`**：导致未命中的 **`PredicateNode`** 的 JSON 快照，便于溯源。

**粗粒度关系溯源（`RelationTraceStatus`）**：**`getRelationStatus(name)`** 返回 **`SUCCESS`** | **`NO_LINK`** | **`FILTERED_OUT`** | **`NOT_REG`**，与上述细因一一对应，便于 UI / 3D 管线做状态着色。**`toSnapshot()`** 生成 **`HydratedEntitySnapshot`**（纯 JSON：`model`、`data`、可选 **`relates`** 嵌套快照、可选 **`relationStatus`**），便于前端或渲染端做缓存加载。

**失败上下文（谓词调试）**：**`QueryEngine.evaluateInto(data, node, ctx)`** 在 **`ctx: PredicateEvaluateContext`** 上写入 **`failedAt`**（指向 **`PredicateNode`**）与 **`failureKind`**（**`ATTRIBUTE_MISMATCH`** | **`CALLBACK_FALSE`** | **`OR_UNSATISFIED`**），与 **`evaluatePredicate`** 的短路语义一致。

#### 6.1 链上组合（段模型 → 谓词树）

**`QueryChain`** 维护若干**段**，每段内节点为 **AND**；段与段之间编译为 **OR**（与原先「OR 组」语义一致）。**`filter(fn)`** 作为 **`CallbackNode`** 并入当前段，与其余条件 **AND**。

| 写法                                                                               | 语义                                                                                                              |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 连续 **`.where` / `.is` / `.gt` / `.greaterThan` / `.lt` …**（不调用 **`.or()`**） | 落在**当前段**，段内 **AND**                                                                                      |
| **`.or()`**                                                                        | 新开一段；编译为 **(段₁) ∨ (段₂) ∨ …**                                                                            |
| **`.matchAll((b) => { … })`**                                                      | 闭包内 **`FilterBuilder`** 累积为一棵子树，**压入当前段**（段内再 **AND**）                                       |
| **`.matchAllNodes((p) => [ … ])`**                                                 | **`PredicateComposer`** 返回多棵子树，依次压入当前段（彼此 **AND**）；可与 **`p.and` / `p.or`** 任意嵌套          |
| **`.matchAny((p) => [ … ])`**                                                      | **`PredicateComposer`** 返回若干 **`PredicateNode`**，与**当前段已有节点**做前缀展开：**(P ∧ b₁) ∨ (P ∧ b₂) ∨ …** |

**字段补全**：**`model.query<YourRowType>()`** 后 **`QueryChain<YourRowType>`** 上 **`.is('field', …)`** 的字段名会按泛型收窄（`YourRowType` 为业务行形状即可）。

**起点与优化**：`query()` 不传 id 为全表起步；**`query([ids])`** 先按 id 收窄。若谓词树**等价于**单独一条 **`_id`/`id` 的 `eq`** 且**不含** **`CallbackNode`**，Runtime 可走 **`getByIds` / `findFirstByFieldEq`**，避免无谓全表读。

#### 6.2 `FilterBuilder` / `PredicateComposer` 与嵌套

实现见 **`src/runtime/filter-builder.ts`**。

**`FilterBuilder<M>`**（**`relate` / `matchAll` 闭包**）：链式 **`.is` / `.not` / `.gt` / `.lt`**（**`.greaterThan` / `.lessThan`** 为别名）、**`.contains` / `.inside` / `.between` / `.where`**；字段参数在 **`M`** 上尽量用 **`keyof M & string`** 以补全。组合：**`.and(n1, n2, …)`**、**`.or(n1, n2, …)`** 可传入 **`PredicateNode`** 或其它 **`FilterBuilder`**。**`.filter(fn)`** → **`CallbackNode`**。**`FilterBuilder.compose<M>()`** 返回 **`PredicateComposer<M>`**，用于**不写 `new FilterBuilder`** 即可拼装独立 **`PredicateNode`**（例如 `const p = FilterBuilder.compose<Row>(); p.and(p.is('a',1), p.gt('b',2))`）。

**`PredicateComposer<M>`**（**`matchAllNodes` / `matchAny`** 回调参数）：原子方法返回 **`PredicateNode`**；**`.and(...)`** / **`.or(...)`** 返回 **`GroupNode`**，可任意嵌套。

**`getQueryPlan()`** 返回 **`QueryPlanASTv2`**（`version: 2`）：**`hops[].source` / `target`** 与 **`trailing`** 为 **`serializePredicate`** 后的 JSON（**`callback`** 仅占位）。

**`QueryEngine`**：对单行执行 **`evaluate`** / **`matches`** / **`explainFailure`** / **`evaluateInto`**（对外与链内求值一致）。

```typescript
const hydrated = await Pump.find([pumpId]).relate('located_in').execute();
const results = hydrated.map((h) => h.getData());

// AND：同一组内多条件同时成立（`.gt` 与 `.greaterThan` 等价）
const strict = await client
  .model('Pump')
  .query()
  .is('status', 'active')
  .gt('power', 50)
  .is('zoneId', 'Z-A')
  .execute();

// 与 matchAll 等价片段（均在当前 OR 组内 AND）
const sameIdea = await client
  .model('Pump')
  .query()
  .matchAll((b) => {
    b.is('status', 'active');
    b.greaterThan('power', 50);
  })
  .is('zoneId', 'Z-A')
  .execute();

// OR：level=1 或 level=2 的分区下的泵
const eitherLevel = await client
  .model('Zone')
  .query()
  .where('level', 'eq', 1)
  .or()
  .where('level', 'eq', 2)
  .relate('has_pump')
  .execute();

// OR + 前缀分配：(status∧power∧(id 含 P1)) ∨ (status∧power∧(id∈{P3})) — 回调参数为 PredicateComposer
const distributed = await client
  .model('Pump')
  .query()
  .is('status', 'active')
  .gt('power', 50)
  .matchAny((p) => [p.contains('id', 'P1'), p.inside('id', ['P3'])])
  .execute();

// 独立 PredicateNode（不经 QueryChain）：FilterBuilder.compose + QueryEngine
import { FilterBuilder, QueryEngine } from 'mode-db-engine';
type Row = { level: number };
const pc = FilterBuilder.compose<Row>();
const levelNode = pc.and(pc.is('level', 1), pc.lt('level', 99));
QueryEngine.matches({ _id: 'x', _createdAt: new Date().toISOString(), level: 1 }, levelNode);

// 任意嵌套：AND( status, OR( id∈P1, id∈P3 ) )
type PumpRow = { id: string; status: string; power: number; zoneId: string };
await client
  .model('Pump')
  .query<PumpRow>()
  .matchAllNodes((p) => [
    p.and(p.is('status', 'active'), p.or(p.inside('id', ['P1']), p.inside('id', ['P3']))),
  ])
  .execute();

// 全表起步 + 关联 + 目标侧 AND（FilterBuilder）
const filtered = await client
  .model('Zone')
  .query()
  .where('level', 'eq', 1)
  .relate('has_pump', (p) => p.is('status', 'active').where('power', '>', 50))
  .execute();

// 跳转目标上仅语义 API
const zone = await client
  .model('Pump')
  .query()
  .is('id', 'P1')
  .relate('in_zone', (z) => z.is('level', 1))
  .execute();

const roots = await Pump.find([pumpId]).relate('located_in').execute({ includeRelates: true });
console.log(roots[0]?.toNested());
console.log(roots[0]?.getRelationStatus('located_in')); // e.g. 'SUCCESS'
console.log(JSON.stringify(roots[0]?.toSnapshot()));

const why = await hydrated[0]?.explainRelate('some_rel');
```

#### 6.3 多维分析管道：分组、聚合与 `AnalysisResult`

在 **`QueryChain`** 末端增加 **「改形状」** 能力；**`execute()`** 时顺序为：**① 谓词树过滤行 → ② 解析分组键 → ③ 桶内流式聚合**（流式扫描路径对每条记录同样顺序执行）。核心实现位于 **`src/runtime/transform-engine.ts`**（**`AggregatorEngine`**、**`PivotTable`**、**`DataPivot`**）；数值稳定性由 **`src/runtime/stat-accumulator.ts`** 中的 **`StatAccumulator`**（**Welford**）支撑 **`variance` / `stdDev`**。

| 方法                           | 作用                                                                                                                                                                                                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`.groupBy(fields[])`**       | 多级分组维度；语义与 **`.pivot`** 相同。至少传入 **一个** 路径，否则抛 **`QueryError`**。普通字段用字段名；**关联路径**用 **`关系名.目标字段`**（如 **`in_zone.label`**），解析到**首个**目标行再取后续路径（点对多取 `_id` 字典序第一个，便于稳定复现）。                                             |
| **`.pivot(keys[])`**           | 与 **`.groupBy`** 等价，命名上强调「嵌套层级顺序」（如年份 → 国家）。                                                                                                                                                                                                                                  |
| **`.compute(spec)`**           | **整表替换**内置映射：**键 = 行上字段名**，值为单个算子或 **`Op[]`**（多算子时输出键为 **`{算子}_{字段}`**，如 **`sum_population`**、**`variance_population`**）。若未配置 **`.compute` / `.aggregate`** 且无 **`.customReduce`**，默认为 **`{ _count: 'count' }`**。**`count`** 表示桶内行数。        |
| **`.aggregate(config)`**       | **按源字段键合并**到已有映射：`config` 可为 **`Record<string, AggregateOp \| Op[]>`** 或 **`Aggregator`**。同一字段多个算子展开规则与 **`.compute`** 一致。与 **`.compute`**、**`.customReduce`** 冲突时抛 **`QueryError`**。                                                                          |
| **`.customReduce(key, spec)`** | 自定义折叠：**`spec.reduce(prev, current) → next`**。首行 **`prev`** 为 **`spec.initial`**（若给出），否则 **`undefined`**；**`current`** 默认取 **`row[key]`**，可用 **`valueField`** 指定另一字段。可与 **`.compute` / `.aggregate`** 混用，**输出键不可重复**。                                     |
| **`.execute()`**               | 已配置 **`.groupBy` / `.pivot`** 时返回 **`AnalysisResult`**；否则返回 **`HydratedEntity[]`**。透视路径下不支持 **`includeRelates`**（会抛 **`QueryError`**）。类型上：调用 **`groupBy` / `pivot`** 后链类型为 **`QueryChain<M, 'analysis'>`**，**`execute()`** 推断为 **`Promise<AnalysisResult>`**。 |
| **`.analyze()`**               | 在已配置至少一个分组维度时，等价于 **`execute()`**，返回 **`AnalysisResult`**；未配置维度时抛 **`QueryError`**。                                                                                                                                                                                       |

**`AnalysisResult`**（**`isAnalysisResult`**）：封装分组维度、桶内聚合值与元数据。

- **`.asTree()`**：嵌套 JSON（如 **`tree['2026']['China']`**），**叶节点上直接为指标键值**（如 **`sum_population`**），便于 **ECharts** 等消费。
- **`.asMatrix()`** / **`.asFlatTable()`**：扁平行数组；**每行一个对象**，**维度列与指标列合并**（如 **`{ year: 2026, country: 'China', sum_population: … }`**）。
- **`.getMetadata()`**：**`AnalysisRunMetadata`**（**`pipeline: 'filter_then_group_then_aggregate'`**、维度键、各桶 **`dimensionValues`**、各指标 **`validSampleCount` / `missingSampleCount` / `resultHint`**（如全缺失时的 **`all_missing`**））。
- **`.getTraceability()`**：在 **`getMetadata`** 之上标注 **`unlinkedOrBrokenPath`**（维度中含 **`__unlinked__`**）及汇总计数，便于审计「拓扑断裂 / 字段缺口」。

兼容旧形态可用 **`.toAnalysisReport('tree' \| 'flat')`**（**`isAnalysisReport`**）。

**缺失值与 0**：聚合时 **`null` / `undefined`** 视为缺失，不参与 **`sum` / `avg` / min / max / variance / stdDev`**；数值 **`0`** 为有效样本。若某桶内某数值指标**全部为缺失**，该指标结果为 **`traceableNull('all_missing')`**（**`isTraceableNull`**，**`TRACEABLE_REASON_ALL_MISSING`**），便于区分「真无数据」与 **`0`**。

**流式累加**：在 **无 `relate` 跳步**、谓词树**不含** **`CallbackNode`**、且 **`DataReader`** 实现了 **`scanModelRecords`**（**`ModelFileReader` / `ModelStorage`** 已提供）时，按 **`.mld` 行流**过滤并写入桶。带 **`relate`** 或多段跳步时，仍先按现有查询路径得到末端行集，再对该行集累加。

```typescript
import { Aggregator, isAnalysisResult } from 'mode-db-engine';

// 对象式 aggregate，与 groupBy 等价写法也可用 pivot
const report = await client
  .model('Population')
  .query()
  .between('year', 1990, 2026)
  .aggregate({ population: 'sum', growth: 'avg' })
  .pivot(['year', 'country'])
  .execute();

if (isAnalysisResult(report)) {
  console.log(report.asTree());
  console.table(report.asFlatTable());
  console.log(report.getMetadata());
}

// 链式 Aggregator + compute 混用示例见 test/transform_aggregate.ts
```

**方差**：桶内为**总体方差** \(\sigma^2 = M_2/n\)（**Welford** 稳定累加）；**`stdDev`** 为其算术平方根。

### 7. Runtime / ModelDBClient — 第三方只读接入

```typescript
import { ModelDBClient } from 'mode-db-engine';

const client = await ModelDBClient.connect('pipe');
const PumpRO = client.model('Pump');

const rows = (await PumpRO.query([somePumpId]).relate('located_in').execute()).map((h) =>
  h.getData(),
);
```

- **`connect(atlasName)`**：读取 `atlas-manifest.json`，用只读 Reader 打开该图谱下的 `.mld` / `.rid`。
- **返回的 `ModelEntity`（Runtime）**：仅提供查询与 Schema 自省，**没有** `insert`、`updateFields`、`bind` 等写入 API。
- **`ModelDBClient.fromContext(runtimeContext)`**：同进程内可由 `AuthoringEngine.createRuntime()` + `ModelDBAdmin.client()` 桥接（仍建议第三方只用 `connect`）。

### 8. ModelDBAdmin（可选）

全功能治理入口，继承 `AuthoringEngine`，并提供 **`client()`** 返回基于当前引擎状态的只读 `ModelDBClient`（内部 `fromContext`）。

---

## 存储格式

### 模型数据 — `.mld` (JSONL)

路径：`STORAGE_ROOT/<atlas>/models/<模型名>.mld`

```jsonl
{
  "_id": "a1b2c3d4-...",
  "_createdAt": "2026-04-09T10:00:00.000Z",
  "name": "张三",
  "email": "zhang@example.com"
}
```

### 关系索引 — `.rid` (JSON)

路径：`STORAGE_ROOT/<atlas>/relations/<Source>-<Target>-<Forward>.rid`

```json
{
  "fwd": {
    "srcId-1": ["targetId-A", "targetId-B"]
  },
  "rev": {
    "targetId-A": ["srcId-1"],
    "targetId-B": ["srcId-1"]
  }
}
```

`fwd` 与 `rev` 由索引层成对维护，保证可逆遍历一致。

---

## 错误体系

```
EngineError
├── AtlasIsolationError            ← Atlas / 路径段非法、跨图谱混淆
├── AtlasManifestError             ← manifest 缺失或解析失败（常见于 connect 早于 flush）
├── StorageError
│   ├── ModelNotRegisteredError
│   └── FileIOError
├── RegistryError
│   ├── DuplicateModelError
│   ├── ParentNotFoundError
│   ├── DuplicateRelationError
│   └── RelationModelNotFoundError
├── IndexerError
└── QueryError
    └── RelationNotFoundError
```

---

## 项目结构

```
mode-db-engine/
├── index.ts                    # 包入口，统一导出
├── docs/
│   └── architecture.svg        # README 系统架构图（矢量）
├── authoring/                  # 治理端：引擎、实体、存储、索引、Admin
├── common/                     # 共享：类型、registry、manifest、错误、存储根
├── runtime/                    # 对 src/runtime 的薄再导出（便于从包根 import）
├── src/
│   ├── runtime/                # 只读 Runtime SDK：query、transform-engine（分组/聚合）
│   ├── authoring/
│   │   └── AuthoringEngine.ts  # 指向 authoring/engine 的规范入口路径
│   └── common/
│       └── PathResolver.ts     # Atlas 目录路径解析
├── test/
│   ├── README.md               # 测试命令、Atlas 对照、与全量集成脚本说明
│   ├── verify.ts               # 端到端：双图谱、滞后字段、PROTOCOL、Runtime 只读（启动时清空 data/）
│   ├── query_filters.ts        # 谓词 / QueryChain / matchAny / 短路 / getQueryPlan / includeRelates / evaluateInto
│   ├── logic_integrity.ts      # HydratedEntity 溯源、幽灵 id、includeRelates 级联
│   ├── logic_closure_audit.ts  # Atlas 隔离、双向索引、多级 relate、Runtime
│   ├── transform_aggregate.ts  # §6.3：pivot / groupBy、aggregate、execute → AnalysisResult
│   └── first_run.ts            # 演示：治理 → flush → Runtime（点火脚本）
├── data/                       # 默认运行时数据（建议 git-ignore）
├── dist/                       # tsc 输出
├── eslint.config.js
├── tsconfig.json
├── .prettierrc
├── .editorconfig
└── .cursorrules
```

---

## 公共 API 概要

根入口 `index.ts` 主要导出（完整列表以源码为准）：

| 类别        | 导出                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 治理        | `AuthoringEngine`, `Engine`, `ModelDBAdmin`, `AtlasRegistry`, `ModelEntity`, `RelationEntity`, `ModelStorage`, `RelationIndexer`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 运行时      | `ModelDBClient`, `Runtime`, `RuntimeModel`, `RuntimeRelation`, `HydratedEntity`, `QueryChain`, `QueryEngine`, `FilterBuilder`, `PredicateComposer`, `mergeMatchAnyIntoSegment`, `compileSegments`, `RelateFilterBuilder`（别名）, `normalizeOperator`, `configureModelDBRuntime`, `resolveModelDBStorageRoot`；多维分析：`isAnalysisResult`, `AnalysisResult`, `PivotTable`, `Aggregator`, `AggregatorEngine`, `DataPivot`, `isAnalysisReport`, `AnalysisReport`（兼容）, `StatAccumulator`, `traceableNull`, `isTraceableNull`, `isStatMissing`, `coerceFiniteNumber`, `TRACEABLE_REASON_ALL_MISSING`；类型如 `TraceableNull`, `PredicateNode`, `QueryPlanASTv2`, `EvaluateResult`, `AggregateOp`, `AnalysisFlatRow`, `CustomReducerSpec`, `PredicateEvaluateContext`, `PredicateFailureKind`, `PredicateStandardOperator`, `PredicateAtomOperator`, `RelationTraceStatus`, `HydratedEntitySnapshot`, `LocalFilterState`, `QueryStartSpec` 等 |
| 类型 / 协议 | `ModelRegistry`, `PathResolver`, manifest 常量与解析函数，`DataReader`, `IndexReader`，各类 `export type { … }` 与错误类                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

---

## 集成验证与测试

**索引**：集成测试的命令、数据目录与各脚本覆盖点见 **[test/README.md](test/README.md)**（该文档**仅**写测试相关内容；引擎说明与 DX 见本文档）。

**推荐一键回归**（顺序：`verify` → `query-filters` → `integrity` → `audit`；首步会删除整个默认 **`data/`** 目录）：

```bash
npm test
# 等价于
npm run test:integration
```

**单项执行**：

```bash
npx tsx test/verify.ts          # 或单独跑 verify（同样会先清空 data/）
npm run query-filters
npm run integrity
npm run audit
npm run first-run               # 演示向，未包含在 test:integration 中
npm run transform               # pivot / groupBy / aggregate / execute → AnalysisResult（第六节 6.3）
```

| 脚本                         | 主要内容                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`verify.ts`**              | **pipe / tran** 双图谱隔离；**滞后 `updateFields`**；**PROTOCOL** 与 **`.rid` 正逆向成对**；**`ModelDBClient.connect`**、链式查询；Runtime **无 `insert` / `bind` 等**；**遇错计数**，失败时 **exit 1**。                                                                                                                                                 |
| **`query_filters.ts`**       | **第六节** 全链路：**谓词树**、**AND/OR 短路**、**`matchAll` / `matchAllNodes` / `matchAny`**、**`getQueryPlan`**、**`filter`（Callback）**、**`relate` 目标过滤**、**`includeRelates`**；**`getRelateDiagnostic`** + **`failedPredicate`**；**`getRelationStatus`**、**`toSnapshot`**；**`QueryEngine.evaluateInto`** + **`PredicateEvaluateContext`**。 |
| **`logic_integrity.ts`**     | **`model` 句柄缓存**、**合并读**、**`insert({ sync: true })` + 文件存在断言**；**`explainRelate`**、**`NOT_REGISTERED`** / **`NO_LINK_IN_INDEX`**；**.rid 幽灵 id** → **`FILTERED_OUT_ORPHAN`**；**`includeRelates` + `toNested()`**。                                                                                                                    |
| **`logic_closure_audit.ts`** | **pipe_system / tran_system** 物理隔离；**双向索引审计**；**多级 `relate`**；Runtime 只读。                                                                                                                                                                                                                                                               |
| **`transform_aggregate.ts`** | **第六节 6.3**：**`pivot` / `groupBy`**、**`aggregate`（对象与 `Aggregator`）**、**`between`**、**`compute` / `customReduce`**、**`execute()` → `AnalysisResult`**（**`asTree` / `asMatrix`**）、**`analyze()`**、**`traceableNull(all_missing)`**、关系路径分组键。                                                                                      |
| **`first_run.ts`**           | 治理 → **`flushAll`** → Runtime 查询的**可读演示**（弱断言）。                                                                                                                                                                                                                                                                                            |

---

## 技术栈

- **语言：** TypeScript（strict）
- **运行时：** Node.js（ES2022，Node16 模块解析）
- **模块：** ESM（`"type": "module"`）
- **检查：** ESLint 10 + @typescript-eslint
- **格式化：** Prettier
- **Git Hooks：** Husky + lint-staged
- **生产依赖：** 无（仅 Node 内置模块）

---

## 快速开始

```bash
npm install

# 集成验证（verify + query-filters + integrity + audit）
npm test

# 类型检查
npm run typecheck

# 代码检查
npm run lint

# 格式化
npm run format

# 类型 + lint + 格式
npm run check

# 编译
npm run build

# 监听编译
npm run dev
```

---

## 开发规范

- 源码使用 TypeScript；在 `authoring/`、`common/`、`src/`、`test/` 中避免手写可提交的业务 `.js`。
- 使用 ESM；类型使用 `import type { … }`。
- 公共 API 保持 JSDoc 与明确返回类型。
- 避免 `any`，优先 `unknown` 与类型收窄。
- 核心异步 I/O 使用 `fs/promises`，避免阻塞式文件 API。
- **Runtime 隔离**：新增只读客户端能力时，应放在 `src/runtime/`，且不要反向依赖 `ModelStorage` / `RelationIndexer` 的写入实现。

---

## 许可证

ISC

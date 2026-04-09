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
Pump.updateFields(new Set(['name', 'zoneCode']));
Zone.updateFields(new Set(['code', 'label']));

const pump = await Pump.insert({ name: '主循环泵-1', zoneCode: 'Z-A' });

const allPumps = await Pump.all();
const zones = await Pump.find([pump._id]).relate('located_in').execute();

const relations = Pump.getAvailableRelations();
```

| 方法                       | 说明                           |
| -------------------------- | ------------------------------ |
| `.updateFields(fields)`    | 更新 Schema 字段集并同步存储层 |
| `.insert(data)`            | 插入记录（过滤未声明字段）     |
| `.all()` / `.find(ids)`    | 全量或按 ID 起点查询           |
| `.bind(fwd, strategy, …)`  | 从模型侧触发该关系的索引构建   |
| `.unlink(fwd, pairs)`      | 按对解除链接                   |
| `.getAvailableRelations()` | 继承感知的关系列表             |

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

### 6. 链式查询（QueryChain）

Authoring 与 Runtime 共用同一 **`QueryChain`** 实现，底层只依赖 **`DataReader` / `IndexReader`** 接口。

```typescript
const results = await Pump.find([pumpId]).relate('located_in').execute();
```

### 7. Runtime / ModelDBClient — 第三方只读接入

```typescript
import { ModelDBClient } from 'mode-db-engine';

const client = await ModelDBClient.connect('pipe');
const PumpRO = client.model('Pump');

const rows = await PumpRO.query([somePumpId]).relate('located_in').execute();
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
│   ├── runtime/                # 只读 Runtime SDK 实现（不依赖 authoring 写入模块）
│   ├── authoring/
│   │   └── AuthoringEngine.ts  # 指向 authoring/engine 的规范入口路径
│   └── common/
│       └── PathResolver.ts     # Atlas 目录路径解析
├── test/
│   └── verify.ts               # 端到端集成验证（多图谱 / 滞后字段 / PROTOCOL / Runtime）
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

| 类别        | 导出                                                                                                                                |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 治理        | `AuthoringEngine`, `Engine`, `ModelDBAdmin`, `AtlasRegistry`, `ModelEntity`, `RelationEntity`, `ModelStorage`, `RelationIndexer`    |
| 运行时      | `ModelDBClient`, `Runtime`, `RuntimeModel`, `RuntimeRelation`, `QueryChain`, `configureModelDBRuntime`, `resolveModelDBStorageRoot` |
| 类型 / 协议 | `ModelRegistry`, `PathResolver`, manifest 常量与解析函数，`DataReader`, `IndexReader`，各类 `export type { … }` 与错误类            |

---

## 集成验证

```bash
npx tsx test/verify.ts
```

当前脚本覆盖：**pipe / tran 双图谱目录与模型隔离**、**骨架插入后 `updateFields` 补全**、**PROTOCOL 绑定与 `.rid` 正逆向成对**、**`ModelDBClient.connect` 链式查询与无写入方法**。

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

# 集成验证
npx tsx test/verify.ts

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

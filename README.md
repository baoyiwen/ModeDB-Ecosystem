# Mode DB Engine

一个**超关系型数据引擎**，用于数据治理与数据资产图谱构建。

它不依赖传统数据库的主外键机制来关联数据，而是通过**物理关系**将实体连接在一起——模型只存储纯净的属性数据，关系作为独立的四元组协议存在，两者在物理层面完全隔离。

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
| **继承锁定** | 子模型在创建时锁定 `ParentID`，且不可更改                         |
| **链式查询** | 查询通过模型跳转 ID 集合，最后才进行数据填充（Lazy Hydration）    |
| **存储隔离** | 每个模型的数据物理隔离，存储在独立的 `.mld` 文件中                |

---

## 架构概览

```
┌─────────────────────────────────────────────────┐
│                   index.ts                       │
│              （公共 API 入口）                     │
├─────────────────────────────────────────────────┤
│                    core/                         │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐ │
│  │  storage   │  │  registry  │  │   query    │ │
│  │  物理存储层 │  │  模型注册表 │  │  查询引擎  │ │
│  └─────┬──────┘  └────────────┘  └────────────┘ │
│        │         ┌────────────┐                  │
│        │         │  indexer   │                  │
│        │         │  索引管理   │                  │
│        │         └────────────┘                  │
├────────┼────────────────────────────────────────┤
│        ▼          data/（运行时数据）              │
│  ┌──────────┐  ┌─────────────┐                   │
│  │ models/  │  │ relations/  │                   │
│  │ *.mld    │  │ *.mld       │                   │
│  └──────────┘  └─────────────┘                   │
└─────────────────────────────────────────────────┘
```

### 模块职责

| 模块           | 文件               | 职责                                                 |
| -------------- | ------------------ | ---------------------------------------------------- |
| **物理存储层** | `core/storage.ts`  | 数据的持久化读写，JSONL 格式追加写入，流式按 ID 查询 |
| **模型注册表** | `core/registry.ts` | 模型 Schema 的注册与管理（开发中）                   |
| **查询引擎**   | `core/query.ts`    | 链式查询解析与执行，ID 集合跳转（开发中）            |
| **索引管理**   | `core/indexer.ts`  | 为高频查询字段建立索引，加速检索（开发中）           |
| **类型定义**   | `core/types.ts`    | 共享的 TypeScript 类型接口                           |
| **错误体系**   | `core/errors.ts`   | 领域专用的自定义错误类                               |

---

## 存储格式

每个模型的数据存储在 `data/models/{模型名}.mld` 文件中，采用 **JSONL**（每行一个 JSON 对象）格式：

```jsonl
{"_id":"a1b2c3d4-...","_createdAt":"2026-04-09T10:00:00.000Z","name":"张三","email":"zhang@example.com"}
{"_id":"e5f6g7h8-...","_createdAt":"2026-04-09T10:01:00.000Z","name":"李四","email":"li@example.com"}
```

**字段说明：**

- `_id` — 引擎自动生成的 UUIDv4，全局唯一标识
- `_createdAt` — 引擎自动生成的 ISO-8601 时间戳
- 其余字段 — 仅包含模型 Schema 中声明的属性（纯净性保证）

写入时，任何不在 Schema 中声明的字段会被**静默过滤**，确保模型数据的纯净性。

---

## 已实现功能

### ModelStorage — 物理存储层

```typescript
import { ModelStorage } from 'mode-db-engine';
import type { ModelSchema } from 'mode-db-engine';

const storage = new ModelStorage();

// 1. 注册模型 Schema
const userSchema: ModelSchema = {
  name: 'User',
  fields: new Set(['name', 'email', 'age']),
};
storage.registerSchema(userSchema);

// 2. 插入数据（自动生成 _id 和 _createdAt，自动过滤未声明字段）
const record = await storage.insert('User', {
  name: '张三',
  email: 'zhang@example.com',
  age: 28,
  department_id: 'dept-001', // ← 会被自动过滤，不会写入文件
});
// record._id       → "a1b2c3d4-..."
// record._createdAt → "2026-04-09T..."
// record.name      → "张三"
// record.department_id → undefined（已被过滤）

// 3. 按 ID 查询（流式读取，内存占用与结果集成正比）
const users = await storage.getByIds('User', [record._id]);
```

**设计要点：**

- `insert` 使用 `appendFile` 追加写入，天然支持并发追加
- `getByIds` 使用 `readline` 流式逐行读取，不会将整个文件加载到内存
- 当所有目标 ID 都已找到时，流式读取会**提前终止**，避免不必要的 I/O
- 操作未注册的模型会抛出 `ModelNotRegisteredError`
- 文件 I/O 失败会抛出 `FileIOError`，并通过 `cause` 保留原始异常链

---

## 错误体系

```
StorageError                    ← 存储层基础错误
├── ModelNotRegisteredError     ← 操作了未注册 Schema 的模型
└── FileIOError                 ← 文件读写失败（携带 filePath 属性）
```

所有错误都支持 `cause` 链，可以追溯到底层的原始异常。

---

## 项目结构

```
mode-db-engine/
├── index.ts                # 包入口，统一导出公共 API
├── core/
│   ├── types.ts            # 共享类型：ModelSchema、ModelRecord、RecordMeta
│   ├── errors.ts           # 自定义错误：StorageError、ModelNotRegisteredError、FileIOError
│   ├── storage.ts          # 物理存储层：ModelStorage 类
│   ├── registry.ts         # 模型注册表（开发中）
│   ├── query.ts            # 查询引擎（开发中）
│   └── indexer.ts          # 索引管理（开发中）
├── utils/                  # 纯函数工具库
├── data/                   # 运行时数据目录（已 git-ignore）
│   ├── models/             # 模型数据文件 (*.mld)
│   └── relations/          # 关系数据文件 (*.mld)
├── test/                   # 测试文件
├── dist/                   # 编译输出（已 git-ignore）
├── eslint.config.js        # ESLint 10 flat config
├── tsconfig.json           # TypeScript 配置
├── .prettierrc             # Prettier 格式化配置
├── .editorconfig           # 编辑器统一配置
└── .cursorrules            # Cursor AI 编码规则
```

---

## 技术栈

- **语言：** TypeScript（strict 模式）
- **运行时：** Node.js（ES2022，Node16 模块系统）
- **模块格式：** ESM（`"type": "module"`）
- **代码检查：** ESLint 10 + @typescript-eslint
- **代码格式化：** Prettier
- **Git Hooks：** Husky + lint-staged（提交前自动检查）
- **零运行时依赖** — 仅使用 Node.js 内置模块

---

## 快速开始

```bash
# 安装依赖
npm install

# 类型检查
npm run typecheck

# 代码检查
npm run lint

# 格式化
npm run format

# 一键检查（类型 + lint + 格式）
npm run check

# 编译
npm run build

# 监听模式编译
npm run dev
```

---

## 开发规范

- 所有源码使用 TypeScript，禁止在 `core/`、`utils/`、`test/` 中创建 `.js` 文件
- 使用 ESM 导入导出，禁止 `require()`
- 类型导入使用 `import type { ... }`
- 公共 API 必须有显式返回类型和 JSDoc 文档
- 避免 `any`，优先使用 `unknown` + 类型守卫
- 提交信息使用 Conventional Commits 格式（`feat:`、`fix:`、`refactor:` 等）
- 核心路径禁止同步 I/O，统一使用 `fs/promises`
- 动态键集合优先使用 `Map`/`Set`

---

## 许可证

ISC

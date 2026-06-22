# `@mode-db/common`

ModelDB 引擎与服务的**公共基础层**：领域类型、注册表、Vault/Atlas 路径约定、磁盘适配、诊断与日志。被 **`@mode-db/core`** 与 **`@mode-db/server`** 依赖；应用层一般**不**直接引用，除非扩展引擎或写服务端插件。

## 模块用途

| 能力              | 说明                                                          |
| ----------------- | ------------------------------------------------------------- |
| **领域类型**      | `ModelRecord`、关系定义、字段类型码、谓词节点等               |
| **Atlas / Vault** | 单文件 `atlas.mld` 段键、`PathResolver`、manifest、存储根解析 |
| **注册表**        | 模型/关系 schema 注册与查询                                   |
| **基础设施**      | `EngineLogger`、`DiskAdapter`、`SmartCache`、错误类型         |
| **编解码辅助**    | shadow codec、wire codec 公共部分                             |

依赖 **`@mode-db/shared`** 中的协议类型，不包含 AuthoringEngine 或网络服务实现。

## 安装与构建

```bash
pnpm install
pnpm run build:shared   # 前置
pnpm run build:common
```

产物：`packages/common/dist/`。

## 使用说明

### 在 core / server 内引用

```typescript
import { EngineLogger } from '@mode-db/common';
import { PathResolver } from '@mode-db/common';
import type { ModelRecord, RelationDefinition } from '@mode-db/common';
```

### 解析数据根目录

```typescript
import { resolveDefaultStorageRoot, loadStorageRootFromConfig } from '@mode-db/common';
```

与 **`modeldb.config.json`** 中的 `storageRoot` 配合，见 **[modeldb-config-guide.md](../../docs/modeldb-config-guide.md)**。

### 注册表（扩展引擎时）

```typescript
import { Registry } from '@mode-db/common';
```

治理端在 **`@mode-db/core`** 的 `AuthoringEngine` 内封装；仅在编写底层工具或测试时直接操作。

## 用户手册

### 包边界

- **可以**：在贡献 `packages/core` / `packages/server` 时使用 common 的类型与工具
- **不建议**：在 Model Designer、业务 App 中直接 `import '@mode-db/common'` — 请用 **`@mode-db/sdk`** 或 **`@mode-db/core`** 公开 API

### 与 `@mode-db/shared` 的分工

| 包         | 职责                                       |
| ---------- | ------------------------------------------ |
| **shared** | 线协议、远程查询 AST、EngineOperation JSON |
| **common** | 引擎域模型、物理存储布局、注册表、日志     |

### 相关文档

| 文档                                                      | 内容                               |
| --------------------------------------------------------- | ---------------------------------- |
| [README.md](../../README.md)                              | 引擎理念与 Vault 布局              |
| [developer-handbook.md](../../docs/developer-handbook.md) | AuthoringEngine / 运行时 API       |
| [user-handbook.md](../../docs/user-handbook.md)           | 构建顺序（shared → common → core） |

### 主要导出（索引）

| 模块                                   | 典型符号             |
| -------------------------------------- | -------------------- |
| `types.js`                             | 记录与关系核心类型   |
| `registry.js`                          | Schema 注册表        |
| `atlas-paths.js` / `atlas-manifest.js` | Atlas 文件布局       |
| `disk-adapter.js`                      | 异步文件 I/O 抽象    |
| `engine-logger.js`                     | 统一日志门面         |
| `data-types.js`                        | 引擎原生位宽类型映射 |

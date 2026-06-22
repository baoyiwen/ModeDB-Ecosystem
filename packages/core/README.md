# `@mode-db/core`

ModeDB **核心引擎**：治理端写入（**`AuthoringEngine`**）、只读运行时（**`ModelDBClient`** / **`QueryChain`**）、单文件 Vault（**`atlas.mld`**）、关系索引与查询分析。跨包共享类型与路径工具见 **`@mode-db/common`**。

## 模块用途

| 子系统           | 说明                                          |
| ---------------- | --------------------------------------------- |
| **authoring/**   | 模型/关系注册、行 CRUD、bind 策略、flush 落盘 |
| **src/runtime/** | HydratedEntity、递归 relate、聚合、透视       |
| **facade/**      | 对运行时的薄再导出                            |
| **templates/**   | 预置 Schema 注册                              |

关系以**正/逆四元组**成对存在；索引通过 **`bind()`** 显式构建（GLOBAL / PROTOCOL / MANUAL 等）。

## 安装与构建

```bash
pnpm install
pnpm run build:core
# 或全量
pnpm run build
```

监听编译：

```bash
pnpm run dev   # 等价于 --filter @mode-db/core run dev
```

产物：`packages/core/dist/`。

## 使用说明

### 进程内治理端（Node 脚本 / 集成测试）

```typescript
import { AuthoringEngine } from '@mode-db/core';

const engine = await AuthoringEngine.open({ atlasPath: '/path/to/workspace/MyLib/atlas.mld' });

await engine.registerModel('Country', { code: 'String', name: 'String' });
await engine.insert('Country', { code: 'CN', name: 'China' }, { sync: true });

await engine.flushAll();
```

### 只读查询

```typescript
import { ModelDBClient } from '@mode-db/core';

const client = ModelDBClient.open({ atlasPath: '...' });
const rows = await client.model('Country').query().filter({ code: 'CN' }).execute();
```

### 统一 JSON 操作（与 SDK 同协议）

```typescript
const result = await engine.apply({
  op: 'batchRegister',
  models: [{ name: 'City', schema: { id: 'Int32' } }],
});
```

协议定义：**[docs/engine-operation-protocol.md](../../docs/engine-operation-protocol.md)**。

### 远程场景

浏览器或分布式部署**不要**直接嵌 core 写盘；请起 **`@mode-db/server`**，用 **`@mode-db/sdk`** 的 `connectRemote` / `RemoteModelDBClient`。

## 用户手册

### 选型

| 场景               | 推荐                                |
| ------------------ | ----------------------------------- |
| 本地脚本、CI、e2e  | **AuthoringEngine** 直接 open atlas |
| 生产 API、多客户端 | **server + sdk**                    |
| Model Designer     | SDK + 固定设计器库 + 业务库 label   |

### 数据与存储

- 逻辑库对应 workspace 下目录，Vault 文件 **`atlas.mld`**
- 模型块 **`m:*`**、关系索引 **`r:*`** 分键存放
- 软删行带 **`__deleted`**，flush 后物理 compact

### 常见操作

```typescript
// 注册关系并 MANUAL 绑边
await engine.registerRelation('A', 'B', 'a_to_b', 'b_to_a', 'many-to-many');
await engine.bind('a_to_b', 'MANUAL', { pairs: [['id1', 'id2']] });

// 删除模型定义（meta）
await engine.dropModel('OldModel');

// 清空业务数据、保留 schema
await engine.clearModelData('Country');
```

### 布局

| 路径                                | 说明               |
| ----------------------------------- | ------------------ |
| `index.ts`                          | 包入口             |
| `authoring/engine.ts`               | AuthoringEngine    |
| `src/runtime/ModelDBClient.ts`      | 只读客户端         |
| `src/network/operation-executor.ts` | JSON op → 引擎映射 |

### 相关文档

| 文档                                                      | 内容                       |
| --------------------------------------------------------- | -------------------------- |
| [developer-handbook.md](../../docs/developer-handbook.md) | API 类/方法索引            |
| [user-handbook.md](../../docs/user-handbook.md)           | Monorepo 构建与启动        |
| [README.md](../../README.md)                              | 架构与 Relation-First 原则 |

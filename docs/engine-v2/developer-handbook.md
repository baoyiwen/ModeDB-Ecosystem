# 新版 Engine 开发手册

## 1. 模块分工

### 1.1 `@mode-db/common`

负责：

- 领域类型
- 注册表
- 存储根与 Atlas/Vault 路径
- 日志与诊断

### 1.2 `@mode-db/shared`

负责：

- `EngineOperation`
- wire 编解码
- RPC 请求/响应类型
- 远程查询计划

### 1.3 `@mode-db/core`

负责：

- `AuthoringEngine`
- `ModelDBClient`
- 查询运行时
- 持久化、索引与 flush

### 1.4 `@mode-db/server`

负责：

- 配置加载
- HTTP 管理面
- WebSocket RPC
- 写串行化

### 1.5 `@mode-db/sdk`

负责：

- 远程连接
- 远程查询链
- 远程 DDL / CRUD / bind
- `apply` / `applyAll`

## 2. 关键请求链路

### 2.1 远程写入

1. 应用构造 SDK 调用或 `EngineOperation`
2. SDK 编码为 wire body
3. server `WireRequestDispatcher` 解码并路由
4. mutating op 进入 `WriteSerializationGate`
5. `executeDatabaseOperation` 调用 core
6. core `flushAll` 后返回结果

### 2.2 远程查询

1. 应用通过 SDK 构造 `WireQueryChain`
2. SDK 发送 `executeQuery`
3. server 为读请求获取 `ModelDBClient`
4. core 查询运行时执行并返回 wire result

### 2.3 workspace 管理

`listDatabases` / `createDatabase` / `catalog` 不走单库 RPC，而是走管理面。

## 3. 关键代码入口

- 协议定义：[`../../packages/shared/src/engine-operations.ts`](../../packages/shared/src/engine-operations.ts)
- SDK 主实现：[`../../packages/sdk/src/remote-client.ts`](../../packages/sdk/src/remote-client.ts)
- server 分发：[`../../packages/server/src/request-dispatcher.ts`](../../packages/server/src/request-dispatcher.ts)
- core AuthoringEngine：[`../../packages/core/authoring/engine.ts`](../../packages/core/authoring/engine.ts)
- core 只读运行时：[`../../packages/core/src/runtime/ModelDBClient.ts`](../../packages/core/src/runtime/ModelDBClient.ts)

## 4. 修改原则

- 协议改动优先从 `shared` 出发，再同步 `sdk`、`server`、`core`
- 不要让 SDK 依赖 `core` 或 `server`
- 不要让 `shared` 引入 sibling workspace 依赖
- 写请求不要绕过 `WriteSerializationGate`
- 不要混淆 workspace-scope 和 database-scope

## 5. 推荐验证

```bash
pnpm run build
pnpm test
```

如果只是某个包的局部改动，也至少应补对应 `typecheck` 与联调验证。

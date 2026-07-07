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
- 备份 / 恢复 / 清除是 server management-plane 能力，不要塞入普通 database RPC
- 关系名不是全局唯一，端点局部同名关系必须可共存
- 关系重命名不等于解绑；底层索引和查询必须保留关系实体语义
- catalog 的 `displayName` / `fieldLabels` 必须完整透传，供 web、data-studio 和 designer 统一展示 `显示名[唯一名]`
- 自关联直接自环默认禁止，只有 `selfLoopPolicy: 'allow'` 才允许

## 5. 近期跨模块链路

### 5.1 显示名链路

1. `model-designer` 写入模型、字段、关系、库的 i18n 显示名。
2. `server` management catalog 返回 `displayName` / `fieldLabels`。
3. `sdk` 原样透传 catalog。
4. `data-studio` 和 `data-ui` 使用 `data-kit` 格式化为 `显示名[唯一名]`。

如果 Pivot 或导入面板显示默认字段名，优先检查 catalog 是否返回了正确 `fieldLabels`，再检查 UI 格式器。

### 5.2 导入关系绑定链路

1. `data-ui` 收集导入配置和关系绑定规则。
2. `data-kit` 生成 `insertMany` / upsert，并在提交后生成 `bindImportLookup`。
3. `shared` 定义 op 形状。
4. `core` 的 `executeDatabaseOperation` 校验端点、`importSide`、字段类型和 `selfLoopPolicy`。
5. 查询运行时必须支持正向和逆向读取同一条关系边。

### 5.3 备份管理链路

备份、恢复、清除和强制重置只在 `server` management plane 实现；前端经 `sdk` 调用，不进入 `EngineOperation`。

## 6. 推荐验证

```bash
pnpm run build
pnpm test
```

如果只是某个包的局部改动，也至少应补对应 `typecheck` 与联调验证。

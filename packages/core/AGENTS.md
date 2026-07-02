# Core Agent Rules

## 1. 模块边界

- `@mode-db/core` 是本地引擎，不是远程客户端。
- 真实 authoring / runtime 行为应留在这里，而不是复制到 `server` 或 `sdk`。

## 2. 核心入口

- `authoring/engine.ts`
- `authoring/persistence-manager.ts`
- `authoring/indexer.ts`
- `src/runtime/ModelDBClient.ts`
- `src/runtime/query.ts`
- `src/network/operation-executor.ts`

## 3. 修改原则

- DDL / CRUD / bind 的真实语义在 core
- 远程协议改动要和 `shared`、`sdk`、`server` 联动检查
- 不要破坏 flush、索引和 query 的一致性

# `@mode-db/core` 开发手册

## 1. 关键入口

- `authoring/engine.ts`
- `authoring/persistence-manager.ts`
- `authoring/indexer.ts`
- `src/runtime/ModelDBClient.ts`
- `src/runtime/query.ts`
- `src/network/operation-executor.ts`

## 2. 关键链路

### 2.1 本地写入

`AuthoringEngine` -> `PersistenceManager` -> storage / index -> `flushAll`

### 2.2 本地查询

`ModelDBClient` -> runtime context -> `QueryChain` -> query engine

### 2.3 JSON operation

`apply` / `applyAll` -> `executeDatabaseOperation`

## 3. 常见改动入口

### 改 DDL / CRUD

- `authoring/engine.ts`
- `src/network/operation-executor.ts`

### 改 flush / buffer

- `authoring/persistence-manager.ts`

### 改查询

- `src/runtime/query.ts`
- `src/runtime/query-engine.ts`

## 4. 风险点

- 改 schema 行为时破坏 non-destructive policy
- 改 bind / unlink 时破坏关系索引一致性
- 改 query result 形状时影响 `sdk` 与 `data-kit`

## 5. 验证命令

```bash
pnpm --filter @mode-db/core typecheck
pnpm --filter @mode-db/core build
```

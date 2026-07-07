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

### 改导入关系绑定

- `src/network/operation-executor.ts`
- `authoring/indexer.ts`
- `authoring/engine.ts`

`bindImportLookup` 是导入二阶段绑定入口。它必须：

- 校验 `importModel` 和 `peerModel` 都是目标关系端点。
- 自关联时使用 `importSide` 决定导入记录位于 source 还是 target。
- 按 `peerMatchFieldType` 对 lookup value 做规范化。
- 遵守 `selfLoopPolicy`，默认跳过直接自环。
- flush 后保证正向和逆向查询都能读到同一条边。

## 4. 风险点

- 改 schema 行为时破坏 non-destructive policy
- 改 bind / unlink 时破坏关系索引一致性
- 改 query result 形状时影响 `sdk` 与 `data-kit`
- 只验证正向关系而遗漏逆向关系
- 把关系名当全局唯一，导致局部同名关系解析错误
- 忘记把 `selfLoopPolicy` 从 wire / registry 写入 indexer

## 5. 验证命令

```bash
pnpm --filter @mode-db/core typecheck
pnpm --filter @mode-db/core build
```

# Common Agent Rules

## 1. 模块边界

- `@mode-db/common` 是引擎底层基础包。
- 不要在这里引入高层 RPC、SDK 或 UI 语义。

## 2. 核心入口

- `src/types.ts`
- `src/registry.ts`
- `src/atlas-paths.ts`
- `src/atlas-manifest.ts`
- `src/engine-logger.ts`
- `src/diagnostic.ts`

## 3. 修改后检查

- 是否影响 `core` 与 `server`
- 是否破坏路径或 manifest 假设
- 是否需要补文档与 `.agents/common`

# Data Kit Agent Rules

## Module boundary

- `@mode-db/data-kit` 是 headless 数据页与导入工具包。
- 不负责 React 视觉层。

## Key entry points

- `src/binding/binding-session.ts`
- `src/view-data/query-result-adapter.ts`
- `src/import/build-import-ops.ts`
- `src/import/relation-bind.ts`

## After changes

- 检查是否影响 `data-ui` 与 `data-studio`
- 检查是否影响 `EngineOperation` 兼容性

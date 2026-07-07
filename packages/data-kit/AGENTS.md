# Data Kit Agent Rules

## Module boundary

- `@mode-db/data-kit` 是 headless 数据页与导入工具包。
- 不负责 React 视觉层。

## Key entry points

- `src/binding/binding-session.ts`
- `src/view-data/query-result-adapter.ts`
- `src/view-data/field-display-label.ts`
- `src/import/build-import-ops.ts`
- `src/import/relation-bind.ts`
- `src/import/import-lookup-bind.ts`

## Critical rules

- 保持 headless：不要引入 React、DOM、浏览器 UI 状态。
- 字段显示名格式统一为 `显示名[唯一名]`；缺失显示名时返回唯一名。
- 导入关系绑定必须用 `forward + importModel + peerModel` 解析关系，不能只按关系名。
- 自关联导入要保留 `importSide` 和 `selfLoopPolicy` 语义。
- upsert 导入应交给 EngineOperation / SDK 提交链路，不要在 data-kit 写 UI 专属查询补丁。

## After changes

- 检查是否影响 `data-ui` 与 `data-studio`
- 检查是否影响 `EngineOperation` 兼容性

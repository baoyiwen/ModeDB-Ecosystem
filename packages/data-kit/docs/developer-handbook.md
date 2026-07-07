# `@mode-db/data-kit` Developer Handbook

## Key files

- `src/binding/binding-session.ts`
- `src/binding/sdk-binding-executor.ts`
- `src/view-data/query-result-adapter.ts`
- `src/view-data/field-display-label.ts`
- `src/pivot/pivot-snapshot.ts`
- `src/import/build-import-ops.ts`
- `src/import/relation-bind.ts`
- `src/import/import-lookup-bind.ts`

## Key principles

- 业务提交语义优先通过 `BindingSession` 统一管理
- 查询结果适配与 UI 渲染分离
- import / bind 规则尽量可复用、无 UI 耦合

## Guardrails

- 字段显示名格式只能在 `field-display-label.ts` 这类无头工具中统一维护；不要让 `data-studio`、`data-ui`、Pivot 各自拼 label。
- `formatDisplayWithUnique` 的稳定格式是 `显示名[唯一名]`，显示名不存在或等于唯一名时只返回唯一名。
- 导入关系解析不能只匹配 `forward`，必须同时匹配 import model 和 peer model，因为关系名是端点局部唯一。
- `bindImportLookup` 是导入二阶段绑定专用 op；生成 pairs 时要保持插入结果 `_id` 与原始 join value 顺序一致。
- upsert 导入要走已有 EngineOperation 的 upsert 语义，不能在 UI 层手动先查再改。

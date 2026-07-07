# `@mode-db/data-ui` Developer Handbook

## Key files

- `src/context/data-page-provider.tsx`
- `src/components/data-view-panel.tsx`
- `src/components/data-table.tsx`
- `src/components/pivot-table.tsx`
- `src/components/import-panel.tsx`

## Key principles

- 状态与提交语义优先复用 `data-kit`
- 组件层主要负责展示与交互
- 样式改动注意多视图一致性

## Guardrails

- 不要在组件内复制导入提交、关系绑定、upsert 等业务规则；这些属于 `@mode-db/data-kit`。
- `ImportPanel` 可以维护交互状态，但 staged ops 应通过 `collectImportOpsFromHandle` / `BindingSession` 链路提交。
- Pivot 表只消费 `ViewDataShape`，列名优先用 `columns[].label`，不要在 Pivot 内重新推导字段显示名。
- 字段和模型显示名必须尊重 `nameDisplayMode`：显示名模式为 `显示名[唯一名]`，唯一名模式只显示 name。
- 样式改动需要同时检查表格、Pivot、导入面板，避免 hover / active 状态出现文字对比度不足。

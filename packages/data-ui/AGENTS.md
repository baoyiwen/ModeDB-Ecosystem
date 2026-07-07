# Data UI Agent Rules

## Module boundary

- `@mode-db/data-ui` 是 React 组件层。
- 提交语义与数据逻辑优先留给 `data-kit`。

## Key entry points

- `src/context/data-page-provider.tsx`
- `src/components/data-table.tsx`
- `src/components/pivot-table.tsx`
- `src/components/import-panel.tsx`

## Critical rules

- 不要在 React 组件层复制 `data-kit` 的 staged operation、upsert、导入关系绑定规则。
- 字段显示名尊重 `nameDisplayMode`：显示名模式为 `显示名[唯一名]`，唯一名模式只显示 name。
- Pivot 列名优先消费 `ViewDataShape.columns[].label`，不要在 Pivot 内重新推导 catalog。
- ImportPanel 只负责交互配置，提交语义必须通过 `data-kit` / `DataPageProvider`。

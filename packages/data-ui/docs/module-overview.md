# `@mode-db/data-ui` Module Overview

`@mode-db/data-ui` 是新版 engine 数据页的 React 组件层，建立在 `@mode-db/data-kit` 之上，负责：

- `DataPageProvider`
- 数据表格
- 透视表
- 树表
- 导入面板
- 工具栏与错误展示

## Recent responsibilities

- `ImportPanel` 接收 catalog models、relations、fieldLabels、fieldTypes 和 `nameDisplayMode`，不自行查询引擎。
- 字段、模型展示应复用 `@mode-db/data-kit` 的格式化工具；显示名模式为 `显示名[唯一名]`。
- Pivot 列名来自 `ViewDataShape.columns[].label`，上游应在 snapshot / adapter 阶段注入稳定 label。
- 导入面板负责交互和配置收集，真正的 staged ops、upsert、bind-only lookup 语义由 `data-kit` 生成。

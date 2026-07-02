# `@mode-db/data-kit` Module Overview

`@mode-db/data-kit` 是新版 engine 的无头数据页工具包，负责：

- 数据页模式管理
- query snapshot 与 pivot snapshot
- batch binding session
- import / ingest / relation bind 规则
- 查询结果向 UI 友好形态转换

它不直接渲染 React UI，展示组件交给 `@mode-db/data-ui`。

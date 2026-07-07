# `@mode-db/data-kit` Module Overview

`@mode-db/data-kit` 是新版 engine 的无头数据页工具包，负责：

- 数据页模式管理
- query snapshot 与 pivot snapshot
- batch binding session
- import / ingest / relation bind 规则
- 查询结果向 UI 友好形态转换

它不直接渲染 React UI，展示组件交给 `@mode-db/data-ui`。

## Recent responsibilities

- 字段显示名统一由 `src/view-data/field-display-label.ts` 格式化，显示名模式为 `显示名[唯一名]`。
- Pivot、表格和导入面板应复用同一套字段标签格式器，避免各自兜底导致显示不稳定。
- 导入支持 upsert 语义，匹配字段存在时更新已有行，缺失时插入新行。
- 导入关系绑定通过 `bindImportLookup` 二阶段完成：先 `insertMany`，再按对端匹配字段查找并绑定关系。
- 关系名是端点局部唯一，导入绑定必须同时使用导入模型和对端模型解析关系。
- 自关联导入可通过 `importSide` 指定导入记录在 source 或 target 侧；直接自环还受关系 `selfLoopPolicy` 控制。

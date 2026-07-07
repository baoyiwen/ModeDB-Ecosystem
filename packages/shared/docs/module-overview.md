# `@mode-db/shared` 模块说明

`@mode-db/shared` 是新版 engine 的协议与传输层公共包，负责：

- `EngineOperation`
- wire request / result 类型
- 载荷编解码
- 外层二进制帧
- 远程查询计划

它必须保持浏览器与 Node 双端可用，并避免依赖 sibling workspace 包。

## Recent protocol surface

- `EngineOperation` 包含 `bindImportLookup`、`clearModelData`、`clearAllData` 等数据库级 op。
- 关系注册和修改可携带 `selfLoopPolicy`，只允许 `deny` / `allow`。
- management catalog 类型包含数据库 / 模型 `displayName`、字段 `fieldLabels`、关系 `displayName` 和 `selfLoopPolicy`。
- 备份、恢复、清除物理库、强制重置属于 server management API，不是 `EngineOperation`。

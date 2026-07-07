# Shared AI Context

`@mode-db/shared` 是新版 engine 的协议与传输层基础包。

高优先级事实：

1. 不能依赖 sibling workspace 包。
2. `EngineOperation` 描述数据库级 op，例如 `bindImportLookup`、`clearModelData`、`clearAllData`。
3. 备份、恢复、强制重置属于 management API，不是 `EngineOperation`。
4. management catalog 需要保留完整 i18n：`displayName`、`fieldLabels`、关系显示名。
5. `selfLoopPolicy` 要与 `common/core/server/sdk` 同步。

# Common AI Context

`@mode-db/common` 是新版 engine 的领域与存储基础层。

高优先级事实：

1. 它不承载高层协议或 UI 逻辑。
2. 路径、manifest、注册表和日志是核心。
3. 改动它通常会波及 `core` 与 `server`。
4. `RelationSelfLoopPolicy` 默认 `deny`，只有显式高级场景允许 `allow`。
5. 导入匹配值规范化需要同时兼容 `data-kit` 前端 staging 与 `core` 的 `bindImportLookup`。

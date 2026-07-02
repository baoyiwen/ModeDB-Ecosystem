# Core AI Context

`@mode-db/core` 是新版 engine 的本地核心执行层。

高优先级事实：

1. `AuthoringEngine` 负责写与 DDL。
2. `ModelDBClient` 与 query runtime 负责读。
3. `executeDatabaseOperation` 是 JSON op 到真实引擎行为的桥。

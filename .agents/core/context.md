# Core AI Context

`@mode-db/core` 是新版 engine 的本地核心执行层。

高优先级事实：

1. `AuthoringEngine` 负责写与 DDL。
2. `ModelDBClient` 与 query runtime 负责读。
3. `executeDatabaseOperation` 是 JSON op 到真实引擎行为的桥。
4. `bindImportLookup` 是导入二阶段关系绑定的 core 执行点。
5. 关系自环默认由 `selfLoopPolicy: 'deny'` 阻止。
6. 修改关系索引后必须同时验证正向和逆向查询。

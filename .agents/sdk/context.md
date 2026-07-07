# SDK AI Context

`@mode-db/sdk` 是新版 engine 的远程客户端层。

高优先级事实：

1. 只能依赖 `shared`。
2. 负责远程连接、查询、DDL、mutation、管理面访问。
3. 备份、恢复、清除、强制重置通过 management HTTP API 封装，不走 `apply`。
4. catalog 元数据必须完整透传：`displayName`、`fieldLabels`、`selfLoopPolicy`。
5. SDK 不直接读写服务端文件系统。

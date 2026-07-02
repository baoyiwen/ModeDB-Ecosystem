# Server AI Context

`@mode-db/server` 是新版 engine 的服务端网络层。

高优先级事实：

1. mutating op 必须经过 `WriteSerializationGate`
2. database RPC 委托给 `core`
3. 管理面与单库 RPC 是两条边界

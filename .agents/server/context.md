# Server AI Context

`@mode-db/server` 是新版 engine 的服务端网络层。

高优先级事实：

1. mutating op 必须经过 `WriteSerializationGate`
2. database RPC 委托给 `core`
3. 管理面与单库 RPC 是两条边界
4. 备份 / 恢复 / 清除属于管理面能力，不属于普通 database RPC
5. 自动备份默认关闭，仅当 `autoBackup.enabled === true` 时启动
6. management catalog 必须完整返回 `displayName`、`fieldLabels`、`fieldTypes`、`selfLoopPolicy`
7. 不要把唯一名兜底写成显示名；显示名为空应保持为空
8. `AuthoringBridge` 每库缓存一个 `AuthoringEngine`，server 运行期间常驻；不按文件 mtime 失效，只在恢复 / 清除 / 强制重置 / 删除库后 `evict` 重建。运行中外部改写 `atlas.mld` 需重启 server 才生效

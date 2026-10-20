# Server AI Checklist

- 是否保留写串行化
- 是否保留管理面 / 数据库面边界
- 是否和 `shared` / `sdk` 对齐
- 备份恢复是否仍校验文件名与恢复路径，避免路径逃逸
- 恢复 / 强制重置后是否清理 authoring/client 缓存
- 自动备份是否默认关闭，且间隔不小于 `60000ms`
- 破坏性 CLI 是否仍要求 `--yes`
- catalog 是否完整返回显示名、字段标签、字段类型和自环策略
- catalog 是否没有把唯一名写成默认显示名
- 是否区分配置所在的会话根与逻辑库 workspace，避免在 vault 下重复创建 logs/cache/vault
- 打开多个逻辑库后是否仍保留 server 的日志目录、诊断订阅和访问日志开关

# Engine V2 AI Checklist

## 提交前检查

- 是否区分了 workspace op 与 database op
- 是否同步更新了 shared / sdk / server / core 中的对应实现
- 写操作是否仍经过串行化门闩
- 文档与 agents 文件是否同步更新
- 是否完成至少一次构建或类型验证计划
- 若涉及备份 / 恢复，是否保留 management-plane 边界与安全备份逻辑
- 关系名局部唯一是否仍被支持
- 关系重命名是否不会解绑或破坏查询
- 正向和逆向关系查询是否都验证过
- catalog 是否完整返回 `displayName` / `fieldLabels` / `selfLoopPolicy`

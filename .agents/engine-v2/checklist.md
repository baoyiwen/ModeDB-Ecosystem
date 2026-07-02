# Engine V2 AI Checklist

## 提交前检查

- 是否区分了 workspace op 与 database op
- 是否同步更新了 shared / sdk / server / core 中的对应实现
- 写操作是否仍经过串行化门闩
- 文档与 agents 文件是否同步更新
- 是否完成至少一次构建或类型验证计划

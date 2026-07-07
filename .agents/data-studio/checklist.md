# Data Studio AI Checklist

## 提交前检查

- 是否仍然只通过远程 SDK 访问 engine
- 视图切换时脏数据保护是否还在
- 导入提交结果提示是否仍正常
- 多语言文案是否补齐
- 是否运行了 `pnpm --filter data-studio typecheck`
- 显示名模式是否仍统一为 `显示名[唯一名]`
- 表格、Pivot、导入面板是否共用同一套字段标签格式
- `fieldLabels` 为空时是否先检查 catalog 来源，而不是在 UI 里写兜底假数据
- 导入关系绑定是否同时考虑关系名、导入模型和对端模型
- 备份 / 恢复 / 清除入口是否仍通过 SDK management API
- 恢复 / 清除 / 强制重置后是否重新打开当前会话并刷新 catalog

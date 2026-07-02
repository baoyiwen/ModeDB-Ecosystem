# `@mode-db/data-kit` Operation Manual

## Typical usage

1. 提供 `BindingExecutor`
2. 创建 `BindingSession`
3. 刷新查询结果
4. stage update / delete / import ops
5. commit 批量提交

常用于：

- `data-studio`
- 后续数据页构建器
- 需要复用 binding / import 规则的前端模块

# Model Designer AI Checklist

## 提交前检查

- 改动是否限定在当前任务边界
- 是否保留了双库模型
- 是否保留 `sys_*` catalog 约束
- 是否更新了相关文档
- 是否补全了多语言文案
- 是否执行了 `pnpm --filter model-designer typecheck`

## UI 改动专项检查

- 右侧侧栏窄宽度下是否错位
- 输入框 / 下拉 / 按钮圆角是否风格统一
- 展开区是否有动画且不闪烁
- hover / focus / disabled 态是否仍清晰

## 数据流改动专项检查

- `DataManager` 是否仍能正确 `toMldgDocument`
- `loadMldgDocument` 是否受影响
- push / pull 链路是否仍可工作
- catalog 导入是否仍幂等
- 关系重命名后是否仍通过稳定 `relation.id` 保持端点和层级归属
- 模型重命名后是否不会让关系解绑
- 保存是否 update-first / upsert，避免 `sys_*` 追加重复行
- 空显示名是否仍保持为空，而不是被唯一名覆盖
- 层级高亮 / 置灰是否只在页模式或层级面板打开时生效
- 数据库备份 / 恢复入口是否只操作当前业务库，而不是设计器元数据库
- 恢复 / 清除 / 强制重置后是否重新拉取 catalog 并刷新画布

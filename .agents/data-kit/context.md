# Data Kit AI Context

`@mode-db/data-kit` 负责无头 binding、snapshot、import、query result adapter 与字段显示名格式化。

高优先级事实：

1. 不引入 React / DOM，保持 headless。
2. 字段显示名统一通过 `src/view-data/field-display-label.ts` 输出。
3. 显示名模式格式是 `显示名[唯一名]`；缺失显示名时返回唯一名。
4. 导入关系绑定通过 `relation-bind.ts` 与 `import-lookup-bind.ts` 解析，不能只按关系名匹配。
5. 自关联导入需要保留 `importSide`，直接自环受 `selfLoopPolicy` 控制。
6. upsert 导入使用 EngineOperation 语义，不在 UI 层手动改写。

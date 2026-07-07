# Data Kit AI Checklist

- 是否保持 headless 边界
- 是否影响 `data-ui` / `data-studio`
- 是否影响 `EngineOperation` 提交兼容性
- 字段显示名是否仍统一为 `显示名[唯一名]`
- 导入关系绑定是否仍按关系名 + 两端模型解析
- 自关联导入是否保留 `importSide` 与 `selfLoopPolicy`
- upsert 导入是否仍走 EngineOperation 语义

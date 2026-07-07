# Data UI AI Checklist

- 是否仍复用 `data-kit` 的 state / binding 语义
- 是否影响表格、透视、导入三类视图
- 是否保持 `nameDisplayMode` 在表格 / Pivot / 导入中一致
- Pivot 是否仍使用 `columns[].label`
- ImportPanel 是否没有复制 upsert / bindImportLookup 业务规则
- hover / active / disabled 状态文字是否仍清晰

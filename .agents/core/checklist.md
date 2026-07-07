# Core AI Checklist

- 是否影响 AuthoringEngine / ModelDBClient 边界
- 是否影响 flush / index / query 一致性
- 是否需要同步 `shared` / `server` / `sdk`
- 是否同时验证关系正向和逆向查询
- `bindImportLookup` 是否仍正确处理端点模型、`importSide` 和字段类型
- `selfLoopPolicy` 是否仍默认阻止直接自环

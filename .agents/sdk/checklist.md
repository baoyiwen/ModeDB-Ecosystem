# SDK AI Checklist

- 是否仍保持 client-only 边界
- 是否与 `shared` / `server` 协议一致
- 是否影响返回结果 revive
- management API 是否与 `management-types` 对齐
- catalog 是否完整保留显示名和字段标签
- 备份 / 恢复 / 清除是否没有混入 `EngineOperation`

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

## Import / relation binding

导入建议流程：

1. 读取 CSV / ingest rows。
2. 使用目标模型字段生成字段映射。
3. 根据字段类型执行预转换。
4. 生成 `insertMany` 或 upsert `insertMany`。
5. 对 bind-only 关系暂存 join value。
6. `insertMany` 返回 `_id` 后生成 `bindImportLookup`。

注意事项：

- `bindImportLookup` 需要 `forward`、`reverse`、`importModel`、`peerModel`、`peerMatchField` 和 `pairs`。
- 自关联关系需要 `importSide`，默认由 UI / profile 给出，缺省时按 `target` 侧处理。
- `peerMatchFieldType` 应优先从 catalog 的 `fieldTypes` 读取，避免数字编码和字符串编码匹配失败。
- 如果关系 `selfLoopPolicy` 是 `deny`，直接 `sourceId === targetId` 的绑定会被引擎跳过。

## Display labels

- 字段显示名统一使用 `formatFieldDisplayLabel(fieldLabels, fieldName, locale, useDisplayName)`。
- 显示名模式输出 `显示名[唯一名]`，唯一名模式输出字段名。
- `fieldLabels` 应来自 catalog，不要在 data-kit 中生成假标签写回业务数据。

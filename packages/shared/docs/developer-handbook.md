# `@mode-db/shared` 开发手册

## 1. 关键文件

- `src/engine-operations.ts`
- `src/wire-codec.ts`
- `src/binary-transport.ts`
- `src/wire-protocol-exports.ts`
- `src/wire-query-plan.ts`

## 2. 开发原则

- 保持无 sibling workspace 依赖
- 保持浏览器与 Node 可运行
- 协议变更必须同步考虑 `sdk` 与 `server`

## 3. 高风险改动

- 修改 op 名称或字段形状
- 修改 payload 编码规则
- 修改 query plan AST
- 修改 management catalog 字段，如 `displayName`、`fieldLabels`、`selfLoopPolicy`
- 把 management API 能力误塞进 `EngineOperation`

## 4. Current compatibility notes

- `bindImportLookup` 需要携带 `forward` / `reverse` / `importModel` / `peerModel`，自关联时可携带 `importSide`。
- `selfLoopPolicy` 是关系定义的一部分，wire 类型、common 类型、core executor、server catalog、SDK catalog 都要同步。
- `fieldLabels` 是 `Record<fieldName, Record<locale, label>>`，不要压平成当前语言字符串，否则 Data Studio 的语言切换会失效。
- 备份相关响应类型放在 `management-types.ts`，不经过 wire query codec。

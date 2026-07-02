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

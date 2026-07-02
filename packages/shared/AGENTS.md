# Shared Agent Rules

## 1. 模块边界

- `@mode-db/shared` 只放协议与传输层公共实现。
- 不能依赖 `core`、`server`、`sdk` 等 sibling workspace 包。

## 2. 核心入口

- `src/engine-operations.ts`
- `src/wire-codec.ts`
- `src/binary-transport.ts`
- `src/wire-query-plan.ts`

## 3. 修改后检查

- 是否仍浏览器可用
- 是否仍无 sibling workspace 依赖
- 是否同步评估 `sdk` 与 `server`

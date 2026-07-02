# Server Agent Rules

## 1. 模块边界

- `@mode-db/server` 负责传输、配置、调度。
- 真实引擎行为由 `core` 执行。

## 2. 核心入口

- `src/modeldb-server.ts`
- `src/dual-track-app.ts`
- `src/request-dispatcher.ts`
- `src/authoring-bridge.ts`
- `src/write-serialization-gate.ts`

## 3. 修改后检查

- 写请求是否仍经过 gate
- 管理面和 database RPC 是否仍清晰分离
- 是否与 `shared` / `sdk` 协议一致

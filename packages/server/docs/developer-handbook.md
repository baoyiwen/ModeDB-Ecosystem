# `@mode-db/server` 开发手册

## 1. 关键文件

- `src/modeldb-server.ts`
- `src/dual-track-app.ts`
- `src/request-dispatcher.ts`
- `src/authoring-bridge.ts`
- `src/config-loader.ts`
- `src/write-serialization-gate.ts`

## 2. 关键职责

- 组装 HTTP + WebSocket 服务
- 解码请求并路由到 `executeDatabaseOperation`
- 对 mutating op 加写串行化
- 缓存 / 复用逻辑库对应的 engine/client

## 3. 修改原则

- 不复制 core 的业务语义
- 不跳过写串行化门闩
- 协议改动以 `shared` 为准

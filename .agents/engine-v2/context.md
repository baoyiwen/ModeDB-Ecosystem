# Engine V2 AI Context

## 核心目标

新版 engine 的目标是把本地引擎、远程协议、服务端调度和浏览器客户端收敛到一套统一语义上。

## 高优先级事实

1. `EngineOperation` 是统一 JSON 操作协议。
2. workspace 操作与 database 操作是两条不同边界。
3. `shared` 不能依赖 sibling workspace 包。
4. `sdk` 不能依赖 `core` 或 `server`。
5. 写请求在 server 侧要经过 `WriteSerializationGate`。

## AI 首选入口

- `packages/shared/src/engine-operations.ts`
- `packages/sdk/src/remote-client.ts`
- `packages/server/src/request-dispatcher.ts`
- `packages/core/authoring/engine.ts`

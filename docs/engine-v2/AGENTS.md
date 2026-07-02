# Engine V2 Agent Rules

本文面向后续修改新版 engine 的开发者与 AI agent。

## 1. 范围定义

新版 engine 是跨模块体系，不等于单个包。核心涉及：

- `packages/common`
- `packages/shared`
- `packages/core`
- `packages/server`
- `packages/sdk`

## 2. 关键边界

- `shared` 只放协议与浏览器可复用实现
- `sdk` 只能做远程客户端，不能嵌入本地引擎
- `server` 负责传输、配置与调度，不复制 core 业务语义
- `core` 负责真实 authoring / runtime 行为
- `common` 负责底层领域与存储基础，不承载高层 RPC 规则

## 3. 修改顺序建议

### 改协议

先看：

- `packages/shared/src/engine-operations.ts`
- `packages/shared/src/wire-protocol-exports.ts`
- `packages/shared/src/wire-codec.ts`

再同步：

- `packages/sdk/src/remote-client.ts`
- `packages/server/src/request-dispatcher.ts`
- `packages/core/src/network/operation-executor.ts`

### 改本地引擎

先看：

- `packages/core/authoring/engine.ts`
- `packages/core/src/runtime/`

### 改服务端

先看：

- `packages/server/src/modeldb-server.ts`
- `packages/server/src/request-dispatcher.ts`
- `packages/server/src/authoring-bridge.ts`

## 4. 修改后检查

- 是否破坏 workspace/database 两级操作边界
- 是否破坏 SDK / server / core 的协议一致性
- 是否破坏写串行化
- 是否需要同步更新文档与 `.agents/engine-v2`

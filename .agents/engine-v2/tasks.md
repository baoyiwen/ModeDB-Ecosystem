# Engine V2 AI Task Guide

## 适合 AI 直接处理的任务

- 协议文档与类型补充
- SDK / server / core 协议对齐
- 管理面与数据库面边界梳理
- 示例代码、手册、联调指引完善

## 处理前建议先读

- `packages/shared/src/engine-operations.ts`
- `packages/shared/src/wire-protocol-exports.ts`
- `packages/sdk/src/remote-client.ts`
- `packages/server/src/request-dispatcher.ts`
- `packages/core/src/network/operation-executor.ts`

## 修改后建议验证

```bash
pnpm run build
pnpm test
```

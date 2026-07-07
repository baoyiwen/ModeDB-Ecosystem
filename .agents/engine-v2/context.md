# Engine V2 AI Context

## 核心目标

新版 engine 的目标是把本地引擎、远程协议、服务端调度和浏览器客户端收敛到一套统一语义上。

## 高优先级事实

1. `EngineOperation` 是统一 JSON 操作协议。
2. workspace 操作与 database 操作是两条不同边界。
3. `shared` 不能依赖 sibling workspace 包。
4. `sdk` 不能依赖 `core` 或 `server`。
5. 写请求在 server 侧要经过 `WriteSerializationGate`。
6. 备份 / 恢复 / 清除是 server management-plane 能力，不属于普通 `EngineOperation`。
7. 关系名是端点局部唯一，不能作为全局身份。
8. 关系重命名不应解绑；保存和查询都应保留关系实体语义。
9. `fieldLabels` / `displayName` 由 designer 写入、server catalog 返回、sdk 透传、data-kit/data-ui 展示。
10. 显示名模式统一为 `显示名[唯一名]`。
11. `bindImportLookup` 是导入二阶段关系绑定 op，自关联时需要 `importSide`，直接自环受 `selfLoopPolicy` 控制。

## AI 首选入口

- `packages/shared/src/engine-operations.ts`
- `packages/sdk/src/remote-client.ts`
- `packages/server/src/request-dispatcher.ts`
- `packages/core/authoring/engine.ts`
- `packages/core/src/network/operation-executor.ts`
- `packages/server/src/backup-manager.ts`
- `packages/server/src/auto-backup-scheduler.ts`

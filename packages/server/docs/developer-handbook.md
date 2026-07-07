# `@mode-db/server` 开发手册

## 1. 关键文件

- `src/modeldb-server.ts`
- `src/dual-track-app.ts`
- `src/request-dispatcher.ts`
- `src/authoring-bridge.ts`
- `src/config-loader.ts`
- `src/write-serialization-gate.ts`
- `src/backup-manager.ts`
- `src/auto-backup-scheduler.ts`
- `src/cli-backup.ts`

## 2. 关键职责

- 组装 HTTP + WebSocket 服务。
- 解码请求并路由到 `executeDatabaseOperation`。
- 对 mutating op 加写串行化。
- 缓存 / 复用逻辑库对应的 engine/client。
- 暴露管理面 API：数据库列表、catalog、备份、恢复、清除。
- 提供 `modeldb-server` CLI。

## 3. 修改原则

- 不复制 core 的业务语义。
- 不跳过写串行化门闩。
- 协议改动以 `shared` 为准，并同步 `sdk` / `server` / 前端入口。
- 管理面能力与普通 database RPC 保持边界清晰。

### 3.1 Management catalog 契约

`catalog` 是 web、data-studio、model-designer 的共同元数据来源，必须稳定返回：

- 数据库 `displayName`
- 模型 `displayName`
- 字段 `fieldLabels`
- 字段 `fieldTypes`
- 关系正逆向名称、端点、显示名、`selfLoopPolicy`

注意事项：

- `fieldLabels` 必须保持 `Record<fieldName, Record<locale, label>>`，不要只返回当前语言。
- 没有显示名时返回空对象或省略字段，不要把唯一名写成显示名。
- 关系名是端点局部唯一，catalog 不应暗示 `forward` 全局唯一。
- 修改 catalog 响应时同步检查 `packages/shared/src/management-types.ts`、`packages/sdk/src/remote-client.ts`、`apps/data-studio/src/components/DataWorkspace.tsx`。

## 4. 备份 / 恢复开发约束

设计边界：

- 备份是 **management plane** 能力，不属于普通 database RPC，也不走 `WriteSerializationGate`。
- 创建备份前应尽量 `AuthoringEngine.flushAll()`，保证内存写缓冲落盘。
- 恢复与强制重置后必须清理 server 侧 client/authoring 缓存，避免旧连接继续读旧文件。
- 恢复时必须校验备份文件名和写出路径，禁止路径逃逸。
- `force-reset` 是数据损坏恢复后门，允许目标库文件缺失时重建；普通 `clear-data` 仍应要求逻辑库存在。
- 自动备份默认关闭；只有 `autoBackup.enabled === true` 且间隔不小于 `60000ms` 才启动调度器。

CLI 破坏性命令必须要求显式 `--yes`：

```bash
modeldb-server restore <db-name> <backup-file> --yes
modeldb-server clear-data <db-name> --yes
modeldb-server force-reset <db-name> --yes
```

## 5. 验证建议

```bash
tsc --noEmit -p packages/server/tsconfig.json
```

如改动了 shared 管理类型或 SDK 管理方法，还需同步运行：

```bash
tsc --noEmit -p packages/sdk/tsconfig.json
```

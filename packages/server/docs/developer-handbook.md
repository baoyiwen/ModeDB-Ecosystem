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

### 3.2 AuthoringBridge 引擎缓存生命周期

`src/authoring-bridge.ts` 为每个逻辑库缓存一个 `AuthoringEngine`。server 运行期间它是该库 `atlas.mld` 的唯一所有者：

- 缓存只按库名命中，**不再**根据 `atlas.mld` 的修改时间（原 `atlasCatalogSignature`）判断失效。每次成功写入都会改变文件 mtime，若按 mtime 重建引擎，下一个排队请求可能在上一个引擎仍在刷盘时重新打开文件，在 Windows 上表现为间歇性的 `open(...atlas.mld)` 错误，并可能丢失内存中的 registry。
- 初始化中的 Promise 会立即写入缓存，并发请求共享同一次初始化，同一个库不会被打开两次。
- 初始化失败时会从缓存中移除该 Promise，修复原因后（如临时的文件访问失败）可以重试。
- 只有显式调用 `evict(dbName)` 才会重建引擎。`dual-track-app.ts` 在恢复备份、清除数据 / 强制重置、删除逻辑库这些会替换或删除磁盘文件的管理操作后调用它。

因此，在 server 运行时用外部工具直接改写 `atlas.mld`，不会被已缓存的引擎感知；需要重启 server，或走管理面 API。新增任何会替换库文件的管理操作时，必须同时调用 `evict`。

### 3.3 会话根与逻辑库工作区

`configFilePath` 的父目录是会话根，默认保存同级的 `logs/`、`cache/` 和 `vault/`；`workspace` / `storageRoot` 只表示逻辑库的父目录，通常是 `<会话根>/vault`，也可以位于另一块磁盘。启动服务不得再在 workspace 中创建额外的 `vault/`、`cache/`、`logs/` 或 `.modeldb-server/`。

日志由 server 启动时统一配置：显式 `logDir` 优先，否则写入 `<会话根>/logs/`。诊断订阅同样由 server 注册，`AuthoringBridge` 创建引擎时关闭引擎自身的日志配置，避免切换逻辑库改变全局日志目录或关闭访问日志。

旧版误建的空目录可以在确认为空后移除；非空历史日志和库数据不自动删除或迁移。回归检查见 `test/unit/server-directory-layout.test.ts`，覆盖重复启动、打开多个库、自定义 workspace / logDir 和平铺 vault。

## 4. 备份 / 恢复开发约束

设计边界：

- 备份是 **management plane** 能力，不属于普通 database RPC，也不走 `WriteSerializationGate`。
- 创建备份前应尽量 `AuthoringEngine.flushAll()`，保证内存写缓冲落盘。
- 恢复与强制重置后必须清理 server 侧 client/authoring 缓存，避免旧连接继续读旧文件。
- 恢复时必须校验备份文件名和写出路径，禁止路径逃逸。
- 外部导入文件必须校验 `modeldb.backup.v1` payload，并拒绝空路径、`.`、`..` 和不属于源库的文件条目。
- 下载接口返回原始 `*.modeldb-backup.json`；上传接口使用 `application/octet-stream`，避免 JSON 再包装造成体积膨胀。
- 导入同名备份时生成带时间戳的新文件名，不覆盖服务器已有备份。
- 创建接口可传可选 `name`（1-120 个字符，不允许控制字符），存入 `modeldb.backup.v1` 的可选字段并通过列表、下载、导入、恢复保留；旧备份无需迁移。
- 展示名与文件标识分离，系统文件名使用安全字符及唯一后缀，写入使用 `wx`，禁止因同秒创建或同名导入覆盖已有文件。创建时间继续使用 ISO-8601，客户端按本地时区显示年月日时分秒。
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

# `@mode-db/common` 模块说明

## 1. 模块定位

`@mode-db/common` 是新版 engine 的底层公共基础包，负责：

- 领域类型
- 注册表与 schema 元信息
- Atlas / Vault 路径与布局
- 磁盘适配
- 日志与诊断

它不直接承载 AuthoringEngine、RPC 或浏览器 SDK 逻辑。

## 2. 模块边界

- 可以被 `core`、`server`、底层工具依赖
- 不负责 WebSocket / HTTP 协议
- 不负责高层查询链或前端交互

## 3. 关键导出

- `types.ts`
- `registry.ts`
- `atlas-paths.ts`
- `atlas-manifest.ts`
- `disk-adapter.ts`
- `engine-logger.ts`
- `diagnostic.ts`
- `storage-root-config.ts`

## 4. 典型角色

- 为 `core` 提供领域对象和存储布局
- 为 `server` 提供路径、日志与配置底座
- 为维护脚本提供统一类型和路径工具

# `@mode-db/shared` 操作手册

## 1. 典型用途

- 远程客户端构造 `EngineOperation`
- server / SDK 共用 wire codec
- 自定义协议测试
- 浏览器侧 query plan 序列化

## 2. 常见入口

- `deriveWireSessionKey`
- `encodeWirePayload`
- `decodeWirePayload`
- `WireQueryChain`
- `isEngineOperation`

## Operation boundary

数据库级操作使用 `EngineOperation`，例如：

- `insertMany` / `update` / `batchUpdate`
- `registerModel` / `registerRelation`
- `bind` / `bindPair` / `bindImportLookup`
- `executeQuery`
- `clearModelData` / `clearAllData`

管理面操作不放入 `EngineOperation`：

- 列出备份
- 创建备份
- 从备份恢复
- 清除或强制重置物理库

这些管理面能力由 `packages/shared/src/management-types.ts` 描述响应形状，由 SDK 和 server HTTP route 对齐。

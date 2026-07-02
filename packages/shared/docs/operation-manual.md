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

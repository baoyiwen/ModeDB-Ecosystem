# SDK Agent Rules

## 1. 模块边界

- `@mode-db/sdk` 只做远程客户端。
- 不能嵌入本地引擎或服务端实现。

## 2. 核心入口

- `src/remote-client.ts`
- `src/model-db.ts`
- `src/index.ts`

## 3. 修改后检查

- 是否仍只依赖 `shared`
- 是否与 `server` / `shared` 协议一致
- 是否破坏 revive 结果形状

# `@mode-db/sdk` 开发手册

## 1. 关键文件

- `src/remote-client.ts`
- `src/model-db.ts`
- `src/index.ts`

## 2. 关键链路

- 握手与会话建立
- WebSocket / short mode 请求
- wire result revive
- 管理面 HTTP 请求

## 3. 修改原则

- 不要引入 `core` 或 `server` 依赖
- 协议定义变化要以 `shared` 为准
- 远程返回的 revive 逻辑要和 wire result 保持一致

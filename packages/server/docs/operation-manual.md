# `@mode-db/server` 操作手册

## 1. 启动

```bash
pnpm run build:server
pnpm run start:server -- -c modeldb.config.json
```

## 2. 常见职责

- 列出逻辑库
- 提供 catalog
- 接收 SDK 查询与 mutation
- 串行执行写请求

## 3. 排查重点

- 配置是否加载正确
- 端口与 token 是否正确
- WebSocket 与管理面是否都可用

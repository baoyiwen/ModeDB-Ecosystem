# 新版 Engine 操作手册

## 1. 常见使用场景

新版 engine 主要有两种使用方式：

1. 本地进程内使用 `@mode-db/core`
2. 远程部署 `@mode-db/server` 后通过 `@mode-db/sdk` 访问

## 2. 启动服务端

在仓库根目录执行：

```bash
pnpm run build
pnpm run start:server -- -c modeldb.config.json
```

如果只需要 server 相关构建，也可以执行：

```bash
pnpm run build:server
```

## 3. 创建逻辑库

可通过：

- `modeldb-server create-db`
- SDK 管理面 `createDatabase`
- 管理接口相关工具

完成逻辑库初始化。

## 4. 远程连接流程

### 4.1 列出逻辑库

使用 SDK 或应用先列出逻辑库：

- `listDatabases`

### 4.2 打开逻辑库

提供：

- server 地址
- `connectToken`
- `dbName`

建立远程会话。

### 4.3 执行操作

建立会话后可以：

- `query().execute()`
- `insertMany`
- `batchUpdate`
- `registerModel`
- `alterModel`
- `bind`
- `apply`

## 5. 本地引擎流程

当场景是脚本或集成测试时：

1. `AuthoringEngine.open()`
2. 注册模型 / 关系
3. 插入或更新数据
4. `flushAll()`
5. `ModelDBClient.open()` 读取验证

## 6. 常见排查

### 6.1 握手失败

检查：

- `connectToken` 是否一致
- `dbName` 是否存在
- server 是否已启动

### 6.2 写入成功但刷新看不到

检查：

- 是否走了 `flushAll`
- 是否连接了正确逻辑库
- 是否查询条件过严

### 6.3 管理面可用但 RPC 不通

重点检查：

- WebSocket 路径
- 线协议版本一致性
- server 的 request dispatcher 是否正常工作

## 7. 推荐操作习惯

- 浏览器或远程客户端统一走 SDK
- 进程内脚本统一走 core
- 协议类自动化尽量走 `EngineOperation`
- 每次改动协议后同步验证 `shared + server + sdk`

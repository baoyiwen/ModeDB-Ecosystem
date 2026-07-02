# `@mode-db/sdk` 操作手册

## 1. 典型使用

- `connectRemote`
- `RemoteModelDBClient.connect`
- `ModelDB.listDatabases`
- `client.model('X').query().execute()`
- `client.apply(op)`

## 2. 常见流程

1. 列出逻辑库
2. 打开逻辑库
3. 查询或执行 mutation
4. 关闭客户端

## 3. 注意事项

- `connectToken` 必须与 server 一致
- `dbName` 是逻辑库名，不是物理路径
- 协议层问题优先检查 `shared`

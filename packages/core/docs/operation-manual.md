# `@mode-db/core` 操作手册

## 1. 适用场景

这个包主要用于：

- Node 脚本直接治理逻辑库
- 集成测试
- server 内部实际执行引擎行为

## 2. 本地打开引擎

```ts
const engine = await AuthoringEngine.open({ atlasPath: '...' });
```

## 3. 常见操作

- `registerModel`
- `registerRelation`
- `insert`
- `update`
- `delete`
- `bind`
- `bindImportLookup`（通过 `apply` / `applyAll`）
- `dropModel`
- `dropRelation`
- `clearModelData`
- `clearAllData`

## 4. 落盘

重要语义：

- 普通写入会先进入缓冲
- `flushAll()` 会强制刷写数据、索引与 manifest
- 某些远程写路径会由 server 侧统一触发 flush

## 5. 注意事项

- 不适合直接在浏览器中使用
- schema 变更要区分 destructive / non-destructive
- relation 相关改动要同步关注索引与查询行为
- 自关联关系默认不允许直接自环；需要在关系定义中显式设置 `selfLoopPolicy: 'allow'`
- 修改或排查关系查询时必须同时验证正向和逆向，例如 `children` 与 `parent`
- `bindImportLookup` 用于导入后按对端匹配字段补关系，错误通常来自端点模型、`importSide` 或字段类型不一致

# `@mode-db/core` 模块说明

## 1. 模块定位

`@mode-db/core` 是新版 engine 的本地核心引擎包，负责：

- `AuthoringEngine` 治理写入
- `ModelDBClient` 只读运行时
- `QueryChain` 查询链与查询执行
- 落盘、索引、flush、bind、drop、truncate 等核心行为
- `bindImportLookup` 二阶段导入关系绑定
- 关系 `selfLoopPolicy` 与自环写入保护

## 2. 模块结构

- `authoring/`
  写入、DDL、bind、persistence
- `src/runtime/`
  查询、HydratedEntity、聚合、透视、递归关系
- `src/network/`
  JSON op 到引擎行为的映射
- `facade/`
  便捷导出

## 3. 核心对象

- `AuthoringEngine`
- `ModelDBClient`
- `QueryChain`
- `RelationIndexer`
- `PersistenceManager`

## 5. Recent semantics

- `registerRelation` / `alterRelation` 需要保留 `selfLoopPolicy`，默认 `deny`。
- `RelationIndexer` 和 database operation executor 都必须阻止未授权的 `sourceId === targetId` 自环。
- `bindImportLookup` 通过关系端点、`importModel`、`peerModel` 和 `importSide` 解析导入记录应该写入 source 还是 target。
- 关系查询正向 / 逆向都依赖同一份双向索引；修改 bind / unlink / index clear 时必须同时验证两个方向。

## 4. 典型使用场景

- 本地脚本
- 集成测试
- server 侧真实读写执行

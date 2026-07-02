# `@mode-db/core` 模块说明

## 1. 模块定位

`@mode-db/core` 是新版 engine 的本地核心引擎包，负责：

- `AuthoringEngine` 治理写入
- `ModelDBClient` 只读运行时
- `QueryChain` 查询链与查询执行
- 落盘、索引、flush、bind、drop、truncate 等核心行为

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

## 4. 典型使用场景

- 本地脚本
- 集成测试
- server 侧真实读写执行

# 新版 Engine 说明文档

## 1. 新版 engine 是什么

新版 engine 指当前仓库中围绕以下模块形成的一整套引擎体系：

- `@mode-db/core`
- `@mode-db/common`
- `@mode-db/shared`
- `@mode-db/server`
- `@mode-db/sdk`

它提供：

- 基于逻辑库的单文件 Vault 存储
- AuthoringEngine 治理写入
- ModelDBClient / QueryChain 只读查询
- 远程 WebSocket / HTTP 协议
- 统一 JSON `EngineOperation`

## 2. 架构分层

### 2.1 存储与领域基础

- `@mode-db/common`
  负责领域类型、注册表、Atlas/Vault 路径、诊断与日志

### 2.2 协议层

- `@mode-db/shared`
  负责握手、线协议、远程查询计划、引擎操作协议

### 2.3 本地引擎层

- `@mode-db/core`
  负责 AuthoringEngine、ModelDBClient、查询运行时、落盘与索引

### 2.4 服务层

- `@mode-db/server`
  负责 CLI、配置、HTTP 管理面、WebSocket RPC 与写串行化

### 2.5 远程客户端层

- `@mode-db/sdk`
  负责浏览器 / Node 侧远程连接、查询、DDL、批量操作

## 3. 两类操作范围

### 3.1 workspace-scope

面向逻辑库管理，例如：

- `createDatabase`
- `dropDatabase`
- `listDatabases`
- `catalog`

### 3.2 database-scope

面向单个逻辑库的数据、模型、关系、查询与绑定，例如：

- `registerModel`
- `alterModel`
- `insertMany`
- `executeQuery`
- `bind`

## 4. 典型使用方式

### 4.1 本地脚本 / 测试

直接使用 `AuthoringEngine.open()` 与 `ModelDBClient.open()`。

### 4.2 生产服务 / 浏览器应用

启动 `modeldb-server`，前端或服务通过 `@mode-db/sdk` 远程连接。

### 4.3 设计器与数据工作台

- `model-designer` 使用 SDK + 设计器专属库
- `data-studio` 使用 SDK + data-kit/data-ui

## 5. 新版 engine 的核心特点

- 逻辑库以 workspace 中的目录组织
- 单逻辑库核心数据由 `atlas.mld` 承载
- 本地引擎与远程协议共用统一操作语义
- 关系是 first-class object，支持显式 bind / unlink / preview / stats

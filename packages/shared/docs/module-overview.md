# `@mode-db/shared` 模块说明

`@mode-db/shared` 是新版 engine 的协议与传输层公共包，负责：

- `EngineOperation`
- wire request / result 类型
- 载荷编解码
- 外层二进制帧
- 远程查询计划

它必须保持浏览器与 Node 双端可用，并避免依赖 sibling workspace 包。

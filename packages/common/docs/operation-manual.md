# `@mode-db/common` 操作手册

## 1. 什么时候会接触这个包

通常只有在以下场景会直接使用：

- 扩展引擎底层能力
- 写 server 辅助工具
- 处理 Atlas/Vault 路径与存储根
- 写诊断或日志集成

## 2. 常见使用方式

### 2.1 读取存储根

通过 `resolveModelDBStorageRoot()` 或相关配置工具读取存储根。

### 2.2 操作路径解析

通过 `PathResolver` 统一生成：

- atlas 根目录
- `atlas.mld` 路径
- 模型数据路径
- 关系索引路径

### 2.3 使用日志与诊断

通过 `EngineLogger` 与 `DiagnosticCenter` 接入诊断与文件日志。

## 3. 注意事项

- 业务应用通常不应直接依赖该包
- 修改路径规则时要同步检查 `core` 与 `server`
- 修改领域类型时要注意对上层序列化与查询的影响

# 生产运行数据目录（可选）

与源码中的 **`facade/`**（原 **`runtime/`** 薄再导出层）**无关**。此目录用于放置：

- **`modeldb_vault/`** — 逻辑库工作区根（与 **`modeldb.config.json`** 中 **`workspace`** 对齐时可指向此处）
- **`logs/`** — 若将 **`logDir`** 指到此处，可集中存放 **`system.log`** / **`access.log`**

默认单机开发更常见的是使用 **`MODELDB_HOME`**（见 **`docs/modeldb-config-guide.md`**）。本目录仅提供与「ModeDB-Ecosystem」文档一致的**约定式树形占位**，可按部署需要挂载或忽略。

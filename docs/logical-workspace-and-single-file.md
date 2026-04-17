# 逻辑库工作区与单文件寻址（千万级 / 行业闭环）

本文与 **ModeDB-Ecosystem** 引擎 **2.0** 行为一致：**`@mode-db/server`** 的磁盘根来自配置 **`workspace`**；**`@mode-db/core`** 的 **`ModelDBClient.connect(<atlas>)`** 使用 **`resolveModelDBStorageRoot()`** 下的 **`<storageRoot>/<atlas>/atlas.mld`**（须设置 **`MODEL_DB_CONNECT_TOKEN`** 与治理端相同）。API 总览见 **[developer-handbook.md](./developer-handbook.md)**。

## 配置：`workspace`

服务端 **`modeldb.config.json`** 使用 **`workspace`**（或兼容别名 **`storageRoot` / `dbPath`**）指向**逻辑库根目录**。  
每个逻辑库对应子目录 **`<workspace>/<dbName>/`**；推荐该目录下仅保留 **Vault 单文件** **`atlas.mld`**（混淆二进制），由 **`ModelDBClient.connect(dbName)`** 在**同一存储根约定**下打开。

客户端握手与 HTTP 头使用 **`dbName`**（**`atlas`** 仍为兼容别名）；会话密钥仍按 **`deriveWireSessionKey(connectToken, logicalDb)`** 派生。

## 与「分文件 `models/*.mld`」的关系

分文件布局（**`atlas-manifest.json` + `models/` + `relations/`**）在引擎内仍为**兼容路径**，用于存量数据与渐进迁移。  
**千万级压测与管廊类闭环**建议：**新数据**采用 **`singleFileVault: true`** + **`atlas.mld`**，减少 inode 与目录抖动，统一物理寻址。

## 管廊 Schema 模板

见仓库 **`templates/pipe-gallery/register.ts`** 及根入口 **`registerPipeGalleryModels`**：预置 **Pipe / Node / Monitor** 模型（**Unit**、**Color**、**required**）。

API 与包依赖索引见 **[developer-handbook.md](./developer-handbook.md)**。

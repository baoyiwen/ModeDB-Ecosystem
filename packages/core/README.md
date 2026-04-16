# `@mode-db/core`

黑盒存储引擎、治理端（**`AuthoringEngine`**）与只读运行时（**`ModelDBClient`** / **`QueryChain`**）、单文件 Vault（**`atlas.mld`**）等。跨包共享类型、**`PathResolver`**、**`EngineLogger`**、**`DiskAdapter`** 等见 **`@mode-db/common`**（**`packages/common`**）。API 索引见仓库 **[docs/developer-handbook.md](../../docs/developer-handbook.md)**。

## 布局

| 路径             | 说明                                                                                                 |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| **`index.ts`**   | 包入口                                                                                               |
| **`src/`**       | 运行时实现、网络辅助等                                                                               |
| **`authoring/`** | 治理端写入路径                                                                                       |
| **`facade/`**    | 对 **`src/runtime`** 的薄再导出                                                                      |
| **`templates/`** | 预置 Schema 等                                                                                       |
| **`dist/`**      | 根目录 **`pnpm run build:core`** 或包内 **`pnpm run build`**（**`tsc -p tsconfig.build.json`**）输出 |

## 构建

在仓库根执行：

```bash
pnpm run build:core
```

或完整链 **`pnpm run build`**（shared → common → **core** → server → sdk）。仓库根 **[docs/user-handbook.md](../../docs/user-handbook.md)** 汇总了 monorepo 安装、构建与启动服务步骤。

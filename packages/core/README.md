# `@mode-db/core`

黑盒存储引擎、治理端（**`AuthoringEngine`**）与只读运行时（**`ModelDBClient`** / **`QueryChain`**）、单文件 Vault（**`atlas.mld`**）等。

## 布局

| 路径             | 说明                                                                                                 |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| **`index.ts`**   | 包入口                                                                                               |
| **`src/`**       | 运行时实现、网络辅助等                                                                               |
| **`authoring/`** | 治理端写入路径                                                                                       |
| **`common/`**    | 与 **`@mode-db/common`** 互补的引擎侧类型与 PathResolver 等                                          |
| **`facade/`**    | 对 **`src/runtime`** 的薄再导出                                                                      |
| **`templates/`** | 预置 Schema 等                                                                                       |
| **`dist/`**      | 根目录 **`pnpm run build:core`** 或包内 **`pnpm run build`**（**`tsc -p tsconfig.build.json`**）输出 |

## 构建

在仓库根执行：

```bash
pnpm run build:core
```

或完整链 **`pnpm run build`**（shared → common → **core** → server → sdk）。

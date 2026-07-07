# modedb-web-playground

React + TypeScript + Vite。左侧配置 **ModelDB** 连接参数与逻辑库/模型名，右侧 JSON 展示查询结果；启动时可选探测 **WebGPU**（`navigator.gpu`），与查询无关。

## 运行

```bash
# 仓库根：先启动 modeldb-server，再开本应用
pnpm run dev:web
```

默认 **<http://127.0.0.1:5174>**。主机、端口、令牌、库名、模型名会写入 **localStorage**；也可用环境变量 **`VITE_DEFAULT_*`**（见 **`src/vite-env.d.ts`**）。

依赖 **`@mode-db/sdk`**（workspace）。SDK 侧线协议为 **`Uint8Array`** 等浏览器原生 API，**不**再依赖全局 **`Buffer`** 注入；本应用 **`vite.config.ts`** 中 **`vite-plugin-node-polyfills`** 仅保留 **`process`** 等按需项。

若遇 Vite **Outdated Optimize Dep**，删除 **`node_modules/.vite`** 后重启 dev server。首次 **`pnpm run dev`** 前会 **`predev`** 构建 **`@mode-db/sdk`**（生成 **`dist/`** 入口）。

## 数据库备份与恢复

Web playground 的操作区提供数据库级管理入口：

- 创建备份
- 恢复备份
- 管理清除数据
- 强制重置

这些能力走 `@mode-db/sdk` 的 management API 方法，最终由 `modeldb-server` 写入或读取服务端 workspace 下的 `modeldb/backups/`。恢复、清除、强制重置会重新加载数据库目录并刷新当前连接。

## 显示名与查询注意事项

- 数据库、模型、字段和关系展示优先使用当前语言显示名，格式为 `显示名[唯一名]`。
- 当前语言没有显示名时直接显示唯一名。
- 字段显示名来自 server catalog 的 `fieldLabels`，不要在 web 侧写死默认翻译。
- 关系名不是全局唯一；如果后续增强查询构造器，需要同时结合端点模型判断关系。
- 排查关系查询时要同时验证正向和逆向，例如 `children` 与 `parent`。

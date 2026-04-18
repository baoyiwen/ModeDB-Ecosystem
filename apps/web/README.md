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

# `@mode-db/common` 开发手册

## 1. 目录重点

- `src/types.ts`
- `src/registry.ts`
- `src/atlas-paths.ts`
- `src/atlas-manifest.ts`
- `src/disk-adapter.ts`
- `src/engine-logger.ts`
- `src/diagnostic.ts`

## 2. 开发原则

- 保持低层、稳定、可复用
- 不在这里引入高层协议或 UI 语义
- 尽量避免和 `server` / `sdk` 的实现细节耦合

## 3. 常见改动

### 3.1 改 Atlas 布局

优先看：

- `src/atlas-paths.ts`
- `src/atlas-manifest.ts`
- `src/storage-root-config.ts`

### 3.2 改日志 / 诊断

优先看：

- `src/engine-logger.ts`
- `src/diagnostic.ts`

### 3.3 改模型与关系类型

优先看：

- `src/types.ts`
- `src/registry.ts`

## 4. 验证命令

```bash
pnpm --filter @mode-db/common typecheck
pnpm --filter @mode-db/common build
```

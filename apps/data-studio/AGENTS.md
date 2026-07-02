# Data Studio Agent Rules

本文面向后续继续修改 `apps/data-studio` 的开发者与 AI agent。

## 1. 模块边界

- `data-studio` 是浏览器侧数据工作台，不是本地引擎宿主。
- 它依赖 `@mode-db/sdk` 连接远程 server。
- 它主要负责把 `data-kit` 与 `data-ui` 组合成可交互页面。

## 2. 核心入口

- `src/App.tsx`
- `src/components/ConnectionPanel.tsx`
- `src/components/DataWorkspace.tsx`
- `src/context/studio-context.tsx`
- `src/config/open-library-session.ts`

## 3. 改动原则

- 连接逻辑优先放在 `config/` 与 session 辅助层
- 批量编辑、导入、提交逻辑优先复用 `@mode-db/data-kit`
- UI 组件尽量只做展示、交互与装配
- 新文案同步 `zh/en/ja`

## 4. 常见任务入口

### 改连接流程

- `src/components/ConnectionPanel.tsx`
- `src/config/open-library-session.ts`

### 改表格 / 透视 / 导入装配

- `src/components/DataWorkspace.tsx`
- `src/components/StudioToolbar.tsx`

### 改通知或语言

- `src/context/studio-context.tsx`
- `src/managers/notification-manager.ts`
- `src/managers/i18n-manager.ts`

## 5. 修改后检查

- 运行 `pnpm --filter data-studio typecheck`
- 检查脏数据拦截是否仍有效
- 检查视图切换与模型切换是否还能正确刷新
- 检查 `zh/en/ja` 是否补齐

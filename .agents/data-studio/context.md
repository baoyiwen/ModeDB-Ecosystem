# Data Studio AI Context

## 模块目标

`apps/data-studio` 是新版 engine 的浏览器侧数据工作台，用来验证远程连接、表格/透视浏览、导入和批量提交链路。

## 高优先级事实

1. 只通过 `@mode-db/sdk` 连接 engine。
2. 绑定会话与 staged operation 语义来自 `@mode-db/data-kit`。
3. 表格、透视、导入组件来自 `@mode-db/data-ui`。
4. 当前模块内有会话恢复与脏数据拦截逻辑。

## AI 首选入口

- `apps/data-studio/src/App.tsx`
- `apps/data-studio/src/components/ConnectionPanel.tsx`
- `apps/data-studio/src/components/DataWorkspace.tsx`
- `apps/data-studio/src/config/open-library-session.ts`

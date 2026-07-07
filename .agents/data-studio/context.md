# Data Studio AI Context

## 模块目标

`apps/data-studio` 是新版 engine 的浏览器侧数据工作台，用来验证远程连接、表格/透视浏览、导入和批量提交链路。

## 高优先级事实

1. 只通过 `@mode-db/sdk` 连接 engine。
2. 绑定会话与 staged operation 语义来自 `@mode-db/data-kit`。
3. 表格、透视、导入组件来自 `@mode-db/data-ui`。
4. 当前模块内有会话恢复与脏数据拦截逻辑。
5. 显示名模式统一为 `显示名[唯一名]`；没有当前语言显示名时展示唯一名。
6. 字段标签来自 management catalog 的 `fieldLabels`，父模型字段标签需要递归合并。
7. 导入关系绑定不能只按 `forward` 查关系，必须结合导入模型和对端模型。
8. 备份、恢复、清除、强制重置只走 SDK management API，并在完成后刷新 catalog。

## AI 首选入口

- `apps/data-studio/src/App.tsx`
- `apps/data-studio/src/components/ConnectionPanel.tsx`
- `apps/data-studio/src/components/DataWorkspace.tsx`
- `apps/data-studio/src/config/open-library-session.ts`
- `packages/data-kit/src/view-data/field-display-label.ts`
- `packages/data-ui/src/components/import-panel.tsx`

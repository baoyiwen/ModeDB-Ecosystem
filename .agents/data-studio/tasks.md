# Data Studio AI Task Guide

## 适合 AI 直接处理的任务

- 连接页与会话恢复优化
- 表格 / 透视 / 导入界面装配优化
- toast 与 i18n 文案补齐
- 文档完善

## 处理前先读

- `apps/data-studio/src/App.tsx`
- `apps/data-studio/src/components/ConnectionPanel.tsx`
- `apps/data-studio/src/components/DataWorkspace.tsx`
- `apps/data-studio/src/context/studio-context.tsx`

## 修改后建议验证

```bash
pnpm --filter data-studio typecheck
pnpm --filter data-studio build
```

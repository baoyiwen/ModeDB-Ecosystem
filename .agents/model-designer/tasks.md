# Model Designer AI Task Guide

## 适合 AI 直接处理的任务

- 表单/字段编辑区样式优化
- 侧栏布局与信息层级调整
- 字段表格交互优化
- 连接页与提示文案改进
- i18n 文案补齐
- 文档完善
- 对 `DataManager` 的局部安全增强

## 处理前先读的文件

### UI / 样式任务

- `apps/model-designer/src/components/PropsEditor.tsx`
- `apps/model-designer/src/components/i18n-locale-rows.tsx`
- `apps/model-designer/src/components/base/designer-select.tsx`
- `apps/model-designer/src/styles/designer-shell.css`

### 同步 / 数据任务

- `apps/model-designer/src/managers/data-manager.ts`
- `apps/model-designer/src/managers/graph-sync-manager.ts`
- `apps/model-designer/src/sync/engine-catalog-import.ts`
- `apps/model-designer/src/bootstrap/designer-storage-init.ts`

### 连接 / 工作区任务

- `apps/model-designer/src/components/ConnectionFlow.tsx`
- `apps/model-designer/src/engine/workspace-session.ts`
- `apps/model-designer/src/engine/business-library-session.ts`

## 修改后建议验证

```bash
pnpm --filter model-designer typecheck
```

如果需要构建验证：

```bash
pnpm --filter model-designer build
```

## 常见风险点

- 在业务库和设计器专属库之间写错库
- 改动 `MldgDocument` 结构但漏掉序列化/反序列化
- 只改 JSX 不改 CSS，导致侧栏窄宽度错位
- 新增文案漏掉 `zh/en/ja`

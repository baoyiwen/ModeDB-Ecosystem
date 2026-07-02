# Model Designer AI Context

## 模块目标

`apps/model-designer` 是一个图形化模型设计器。AI 在介入该模块时，默认目标是：

- 不破坏“设计器专属库”和“业务库”的边界
- 优先理解 `DataManager` 持有的内存模型
- 在 UI 改动时同步关注窄侧栏、动画、i18n 和 TypeScript 类型

## 高优先级事实

1. 设计器专属库固定为 `FIXED_MODEL_DESIGNER_DATABASE`。
2. `sys_*` catalog 只应写入设计器专属库。
3. 用户选择的业务库只是 schema/catalog 的来源和业务数据目标。
4. 画布并非 DOM 图编辑器，而是 HTML5 Canvas。
5. 复杂逻辑应优先放在 managers 或 sync 层，而不是组件内堆条件。

## AI 改动首选入口

- 连接与工作区：`src/components/ConnectionFlow.tsx`
- 应用根流程：`src/App.tsx`
- 数据中心：`src/managers/data-manager.ts`
- 画布交互：`src/components/CanvasContainer.tsx`
- 字段编辑：`src/components/PropsEditor.tsx`
- 样式系统：`src/styles/designer-shell.css`

## AI 介入时必须检查

- 是否破坏双库模型
- 是否破坏 `sys_*` 结构假设
- 是否需要同步更新 i18n
- 是否需要同步更新样式与响应式布局
- 是否需要同步更新文档或 `AGENTS.md`

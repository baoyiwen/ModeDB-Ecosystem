# Model Designer Agent Rules

本文面向后续继续修改 `apps/model-designer` 的开发者与 AI agent。

## 1. 模块边界

- `apps/model-designer` 是浏览器侧图形建模工具，不是通用业务后台。
- 它维护的是“模型设计视图”和“设计器专属元数据”，不是业务库本身的唯一真相。
- 业务 schema 的真实来源是业务库 catalog；设计器专属库负责布局、图层、快照与导入后的可视对象。

## 2. 双库约束

必须始终区分两类逻辑库：

1. 设计器专属库
   默认 `model_designer_workspace`
   用于存放 `sys_*` catalog、图层、画布快照与设计器中间数据。
2. 业务库
   用户连接页选择的目标库。
   用于提供真实模型/关系目录，并承接数据清理等操作。

禁止：

- 把 `sys_*` 元模型写入业务库
- 把业务库当成设计器画布快照库使用
- 在 UI 层混淆两种库的会话职责

## 3. 核心代码入口

- 应用根流程：`src/App.tsx`
- 连接页：`src/components/ConnectionFlow.tsx`
- 编辑器外壳：`src/components/EditorChrome.tsx`
- 画布交互：`src/components/CanvasContainer.tsx`
- 数据中心：`src/managers/data-manager.ts`
- 设计器 catalog 初始化：`src/bootstrap/designer-storage-init.ts`
- 业务库 catalog 导入：`src/sync/engine-catalog-import.ts`
- 字段编辑区：`src/components/PropsEditor.tsx`
- 主样式：`src/styles/designer-shell.css`

## 4. 改动原则

### 4.1 逻辑放置

- 复杂业务逻辑优先放在 `managers/`、`sync/`、`bootstrap/`。
- 组件尽量只负责展示、局部交互和绑定。
- 不要在多个组件里复制同一条业务规则。

### 4.2 画布约束

- 画布是 HTML5 Canvas，不要改成 DOM 模拟式编辑器。
- 坐标体系要和现有 `CanvasContainer` 的 CSS 像素逻辑保持一致。
- 任何命中、拖拽、缩放改动都要谨慎处理 DPR 和 viewport。

### 4.3 样式约束

- 所有输入框、下拉、按钮、详情块应保持统一视觉系统。
- 侧栏宽度有限，改布局时必须考虑窄宽度下表现。
- 新交互建议配套适度动画，但不要牺牲稳定性。

### 4.4 i18n 约束

- 新增长期文案必须同步更新 `zh/en/ja`。
- 不要把长期 UI 文案硬编码在 JSX 中。

## 5. 典型任务路径

### 改字段编辑体验

优先读：

- `src/components/PropsEditor.tsx`
- `src/components/i18n-locale-rows.tsx`
- `src/components/base/designer-select.tsx`
- `src/styles/designer-shell.css`

### 改连接/开库流程

优先读：

- `src/components/ConnectionFlow.tsx`
- `src/engine/workspace-session.ts`
- `src/sync/library-registry.ts`

### 改同步/持久化

优先读：

- `src/managers/data-manager.ts`
- `src/managers/graph-sync-manager.ts`
- `src/sync/sdk-designer-sync.ts`
- `src/sync/engine-catalog-import.ts`

## 6. AI 修改前后检查

修改前：

- 确认当前任务是 UI、交互、同步还是 catalog
- 确认涉及的是设计器专属库还是业务库

修改后：

- 运行 `pnpm --filter model-designer typecheck`
- 检查是否需要补 i18n
- 检查是否需要补文档
- 检查右侧侧栏与字段编辑区是否在窄宽度下变形

## 7. 配套资料

- 模块说明：`README.md`
- 模块说明文档：`docs/module-overview.md`
- 操作手册：`docs/operation-manual.md`
- 开发手册：`docs/developer-handbook.md`
- AI 上下文：`../../.agents/model-designer/`

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
- 备份恢复必须使用共享主题化列表/确认组件，禁止退回 `window.prompt` 或 `window.confirm`；本地迁移文件通过 SDK management API 上传、下载。
- 侧栏宽度有限，改布局时必须考虑窄宽度下表现。
- 新交互建议配套适度动画，但不要牺牲稳定性。

### 4.4 i18n 约束

- 新增长期文案必须同步更新 `zh/en/ja`。
- 不要把长期 UI 文案硬编码在 JSX 中。

### 4.5 关系、层级与保存红线

- 关系是实体，不是字符串别名；保存、层级归属、画布选择都应优先使用 `relation.id`。
- 修改模型名或关系名不能导致关系解绑；端点关系必须随对象身份保留。
- 关系唯一名只在端点模型对内局部唯一，自关联按单个模型形成局部范围。
- `Main` 是默认页，所有模型和关系默认属于 `Main`；页模式和层级面板关闭时，不应触发层级高亮 / 置灰逻辑。
- 页面自动关系归属由两个端点模型共同决定，不要在 UI 中维护另一套独立规则。
- `sys_data_asset_map`、`sys_model`、`sys_props`、`sys_relation` 保存必须是 upsert / update-first，禁止无修改也追加重复行。
- i18n 显示名为空时应保持为空；不要把唯一名自动写回显示名字段。

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
- `src/sync/designer-push-sync.ts`
- `src/sync/designer-row-hydrate.ts`
- `src/sync/library-registry.ts`

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

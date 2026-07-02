# Model Designer 开发手册

本文面向后续继续维护 `apps/model-designer` 的开发者，重点说明目录结构、核心数据流、关键 Manager、常见改动入口与约束。

## 1. 目录结构

### 1.1 顶层

- `src/App.tsx`
  模块根入口，负责连接态、静默重连、进入编辑器
- `src/context/`
  管理器上下文与 Provider
- `src/components/`
  React 组件层
- `src/managers/`
  编辑器状态、数据与同步中心
- `src/sync/`
  与设计器专属库 / 业务库交互的同步逻辑
- `src/bootstrap/`
  初始化 `sys_*` catalog 与默认工作区记录
- `src/engine/`
  与 `@mode-db/sdk` 的连接入口与会话封装
- `src/canvas/`
  画布绘制、命中、布局与吸附算法
- `src/styles/`
  设计器主样式

## 2. 核心运行流

### 2.1 启动

入口在 [`../src/App.tsx`](../src/App.tsx)。

大致流程：

1. 判断是否可以静默重连
2. 若可重连则连接设计器专属库
3. 确保设计器 catalog 存在
4. 读取业务库 catalog
5. 导入 catalog 到设计器专属库
6. 加载画布数据
7. 进入 `EditorChrome + CanvasContainer`

### 2.2 连接阶段

连接页由 [`../src/components/ConnectionFlow.tsx`](../src/components/ConnectionFlow.tsx) 负责。

它承担：

- 连接参数收集
- 逻辑库枚举
- 业务库创建
- 库展示信息维护
- 调用 `ensureDesignerWorkspaceSession`
- 调用 `ensureDesignerCatalog`
- 调用 `seedDefaultWorkspaceRecords`

### 2.3 编辑阶段

编辑阶段主要由三层组成：

1. `EditorChrome`
   负责侧栏、通知、设置、层级面板和详情切换
2. `CanvasContainer`
   负责画布绘制与交互
3. `DataManager + 其他 Manager`
   负责数据持有、同步、状态流转

## 3. 关键 Manager

### 3.1 DataManager

文件：[`../src/managers/data-manager.ts`](../src/managers/data-manager.ts)

这是整个模块最核心的数据中心，持有：

- models
- relations
- layoutByModelId
- layers
- layer tree
- node to layer 映射

关键职责：

- 画布内存态维护
- 模型/关系增删改
- 字段列表更新
- 图层树管理
- `MldgDocument` 序列化与反序列化
- push / pull 快照
- 加载 hydration 结果

如果你要改模型结构、字段结构、图层结构、序列化格式，优先看这里。

### 3.2 GraphSyncManager

文件：[`../src/managers/graph-sync-manager.ts`](../src/managers/graph-sync-manager.ts)

职责：

- 记录脏模型/关系
- 将位置与 `canvas_meta` 批量写回设计器专属库
- 为后续更细粒度同步预留接口

当前它并不是完整的双向同步中心，更多是“位置/局部更新同步器”。

### 3.3 ConfigManager

职责：

- 当前远程客户端
- 当前业务库名
- 当前业务库展示信息
- viewport 与交互相关配置

### 3.4 StateManager / ModeManager / EventManager

这三者共同管理交互语义：

- `ModeManager`
  表示工具模式，如 select、add、link、delete
- `StateManager`
  表示具体交互状态
- `EventManager`
  协调长按、双击、键盘与手势判定

如果交互出错，不要只在组件里堆条件判断，先看这三者的边界。

## 4. 关键同步链路

### 4.1 设计器专属库会话

文件：[`../src/engine/workspace-session.ts`](../src/engine/workspace-session.ts)

关键点：

- 设计器始终优先连接固定设计器专属库
- 如果专属库不存在，会先 `createDatabase`
- 业务库不会直接作为画布元数据存储库使用

### 4.2 设计器 catalog 初始化

文件：[`../src/bootstrap/designer-storage-init.ts`](../src/bootstrap/designer-storage-init.ts)

这里定义了设计器元模型：

- `sys_model`
- `sys_relation`
- `sys_props`
- `sys_layers`
- `sys_layer_type`
- `sys_data_asset_map`
- `sys_designer_graph`

如果你要扩展设计器专属库 schema，这里是第一入口。

### 4.3 业务库 catalog 导入

文件：[`../src/sync/engine-catalog-import.ts`](../src/sync/engine-catalog-import.ts)

作用：

- 读取业务库 catalog
- 将业务库中的模型与关系注册信息“登记”到设计器专属库
- 使用 `(library_code, engine_name)` 作为关键定位方式

注意：

- 当前导入是幂等偏保守策略
- 默认跳过 `sys_*`
- 默认不做激进删除

### 4.4 快照 push / pull

主要逻辑在：

- [`../src/managers/data-manager.ts`](../src/managers/data-manager.ts)
- [`../src/sync/sdk-designer-sync.ts`](../src/sync/sdk-designer-sync.ts)
- [`../src/sync/mldg-wire-bytes.ts`](../src/sync/mldg-wire-bytes.ts)

设计器保存不是“直接写每个模型到业务库”，而是：

1. 生成 `MldgDocument`
2. 序列化为 `Uint8Array`
3. 写入 `sys_designer_graph`

## 5. 关键 UI 入口

### 5.1 EditorChrome

文件：[`../src/components/EditorChrome.tsx`](../src/components/EditorChrome.tsx)

职责：

- 左下角/顶部浮动结构
- 侧栏切换
- 模型详情、字段面板、关系详情
- 设置、通知、层级树入口

### 5.2 CanvasContainer

文件：[`../src/components/CanvasContainer.tsx`](../src/components/CanvasContainer.tsx)

职责：

- 实际的 Canvas 绘制
- 节点命中
- 关系命中
- 拖拽移动
- 连线
- 继承交互
- 缩放与 viewport

重要提醒：

- 这里坐标体系明确采用 CSS 像素
- 处理 DPR 时不能随意把 backing pixel 逻辑混进 world coordinate

### 5.3 PropsEditor

文件：[`../src/components/PropsEditor.tsx`](../src/components/PropsEditor.tsx)

职责：

- 字段列表展示
- 字段快速编辑
- 展开高级详情
- 新增字段
- 拖拽排序
- vault 字段状态控制

UI 改动通常集中在：

- `PropsEditor.tsx`
- `i18n-locale-rows.tsx`
- `styles/designer-shell.css`

## 6. 开发时的改动建议

### 6.1 优先在 Manager 层做逻辑

推荐：

- 数据形态变化放 `DataManager`
- 状态切换放 `StateManager / ModeManager`
- 同步逻辑放 `sync/` 或 `GraphSyncManager`

不推荐：

- 在组件内部散落业务规则
- 在多个组件中重复维护相同状态

### 6.2 样式改动入口

主要样式文件是：

- [`../src/styles/designer-shell.css`](../src/styles/designer-shell.css)

约束：

- 尽量延续现有变量体系
- 保持输入框、下拉、按钮、详情块的圆角/边框/间距统一
- 大改交互时同步检查移动端和窄侧栏表现

### 6.3 i18n 改动入口

多语言文件位于：

- `src/i18n/locales/en/`
- `src/i18n/locales/zh/`
- `src/i18n/locales/ja/`

新增文案时建议：

- 先查是否已有近义 key
- 三种语言一起补
- 不要在 JSX 中硬编码长期文案

## 7. 本地开发命令

```bash
pnpm --filter model-designer dev
pnpm --filter model-designer build
pnpm --filter model-designer typecheck
```

仓库根目录也可直接运行：

```bash
pnpm --filter model-designer typecheck
```

## 8. 常见改动场景与入口

### 8.1 改连接页

看：

- `components/ConnectionFlow.tsx`
- `sync/library-registry.ts`
- `engine/workspace-session.ts`

### 8.2 改画布交互

看：

- `components/CanvasContainer.tsx`
- `canvas/`
- `managers/state-manager.ts`
- `managers/event-manager.ts`

### 8.3 改字段编辑区

看：

- `components/PropsEditor.tsx`
- `components/i18n-locale-rows.tsx`
- `components/base/designer-select.tsx`
- `styles/designer-shell.css`

### 8.4 改保存/拉取

看：

- `components/DesignerToolbar.tsx`
- `managers/data-manager.ts`
- `sync/designer-push-sync.ts`
- `sync/engine-catalog-import.ts`

## 9. 开发注意事项

- 不要把业务库和设计器专属库混用
- 不要绕过 `ensureDesignerCatalog` 直接假设 `sys_*` 已完整存在
- 不要把 `sys_*` 业务误导入为普通用户模型
- 不要随意修改 `MldgDocument` 结构而不检查序列化与 hydration
- 任何涉及字段结构的变更，都要同时考虑 UI、序列化、导入、i18n 和样式

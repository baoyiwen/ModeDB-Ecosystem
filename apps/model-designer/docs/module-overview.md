# Model Designer 模块说明

## 1. 模块定位

`model-designer` 是一个运行在浏览器中的 Vite + React 应用，用于：

- 连接 ModeDB Server
- 选择业务逻辑库
- 在画布上创建、编辑、删除模型与关系
- 维护模型的字段、国际化名称、描述、颜色、图层归属
- 将设计器画布布局与结构快照保存回设计器专属库
- 从业务库反向导入 catalog，保持设计器侧目录与业务库注册信息一致

它不是直接的查询器，也不是普通后台表单。它的核心价值在于：

- 把业务库中的结构对象投影成设计器友好的画布对象
- 让“schema 结构”和“布局表现”分离存储
- 为后续 Query Designer、可视化建模、AI 辅助生成提供可读写的中间层

## 2. 运行边界

### 2.1 双库模型

`model-designer` 同时依赖两套逻辑库：

1. 设计器专属库
   固定库名由 `FIXED_MODEL_DESIGNER_DATABASE` 决定。
   存放 `sys_model`、`sys_relation`、`sys_props`、`sys_layers`、`sys_designer_graph` 等设计器元数据。
2. 业务逻辑库
   用户从连接页选择的真实业务库。
   业务库中的 catalog 会被读出并导入设计器专属库。

### 2.2 设计原则

- 设计器专属库只负责元数据与布局，不负责承载用户真实业务数据。
- 业务库依然是模型定义、关系定义与行数据的真实来源。
- UI 中保存/拉取时，需要明确区分“保存设计器快照”和“读取业务库 catalog”。

## 3. 用户能做什么

### 3.1 连接与打开

- 输入 `host / port / token`
- 列出逻辑库
- 创建新逻辑库或维护库的展示信息
- 打开目标业务库并进入画布

### 3.2 画布建模

- 新增模型
- 删除模型
- 拖拽模型位置
- 创建普通关系与继承关系
- 选择、悬停、拖动、框定交互
- 调整关系折点和布局

### 3.3 模型详情编辑

- 编辑模型唯一名
- 编辑显示名与描述的多语言内容
- 调整颜色
- 设置页面/图层归属
- 锁定位置
- 清空某模型对应的业务数据

### 3.4 字段编辑

- 编辑字段名、类型、是否必填
- 编辑字段展示名和字段描述
- 字段拖拽排序
- 新增字段
- 删除字段
- 处理 vault 字段的锁定/解锁显示

### 3.5 数据与同步

- 保存设计器快照到专属库
- 从业务库拉取最新 catalog 并刷新画布
- 清空业务库下某模型或整库的行数据

### 3.6 接口设计与结果查看

- Query Designer：在模型图上构建查询链，配置投影、条件、排序与分页，保存并发布 QueryInterface。继承子模型与父模型在查询链上视为同一节点。
- Operation Designer：设计并发布写入 / 关系操作接口。
- 数据透视（Pivot）：以层级或 JSON 视图查看模型数据或已发布查询接口的真实返回结果，契约见 [`pivot-tab-v1.md`](./pivot-tab-v1.md)。

## 4. 关键技术栈

- React 19
- TypeScript strict
- Vite 6
- `@mode-db/sdk`
- HTML5 Canvas

约束：

- 画布绘制不走 DOM 模拟
- 交互状态通过 Manager 与 StateManager 管理
- 组件以组合和绑定为主，复杂状态放在 managers 中

## 5. 关键入口

- 应用入口：[`../src/App.tsx`](../src/App.tsx)
- 全局上下文：[`../src/context/designer-context.tsx`](../src/context/designer-context.tsx)
- 数据中心：[`../src/managers/data-manager.ts`](../src/managers/data-manager.ts)
- 画布容器：[`../src/components/CanvasContainer.tsx`](../src/components/CanvasContainer.tsx)
- 编辑器外壳：[`../src/components/EditorChrome.tsx`](../src/components/EditorChrome.tsx)
- 字段编辑器：[`../src/components/PropsEditor.tsx`](../src/components/PropsEditor.tsx)
- 查询设计器面板：[`../src/components/QueryDesignerPanel.tsx`](../src/components/QueryDesignerPanel.tsx)
- 数据透视：[`../src/components/PivotTab.tsx`](../src/components/PivotTab.tsx)、[`../src/pivot/`](../src/pivot/)

## 6. 模块输出

该模块的主要输出不是“独立业务结果”，而是：

- 设计器专属库中的 `sys_*` 结构与快照
- 一个可持续编辑的图形化模型视图
- 面向后续 Query Designer、AI 生成器、自动化建模工具的稳定中间层

# Data Studio 模块说明

## 1. 模块定位

`data-studio` 是新版 engine 的浏览器侧数据工作台，核心用途是：

- 连接远程 ModeDB Server
- 选择逻辑库与模型
- 以表格或透视视图查看查询结果
- 通过 Data Binding 会话暂存修改并统一提交
- 使用导入面板把 CSV / 表格类输入转成批量操作

它更像是一个“数据页能力验证场”和“组件集成样板”，而不是复杂业务系统本身。

## 2. 运行边界

- 只通过 `@mode-db/sdk` 连接远程 engine
- 不直接嵌入 `@mode-db/core` 本地写盘能力
- UI 状态以 React + `DataPageProvider` 为中心
- 数据变更通过 `BindingSession` staging / commit 管理

## 3. 用户可见能力

### 3.1 连接与恢复

- 输入 `host / port / token`
- 列出逻辑库
- 打开目标逻辑库
- 自动恢复上一次会话

### 3.2 数据浏览

- 表格视图
- 透视视图
- 模型切换
- 语言切换

### 3.3 数据编辑

- 在编辑态暂存 update / delete
- 提交 staged operation 到 engine
- 在视图切换时阻止脏数据丢失

### 3.4 导入

- 选择目标模型
- 自动识别字段
- 生成 insert / bind 类操作
- 统一 commit 并弹出结果提示

## 4. 关键依赖

- `@mode-db/sdk`
- `@mode-db/data-kit`
- `@mode-db/data-ui`
- React 19
- Vite 6

## 5. 关键入口

- 应用入口：[`../src/App.tsx`](../src/App.tsx)
- 连接面板：[`../src/components/ConnectionPanel.tsx`](../src/components/ConnectionPanel.tsx)
- 工作区主体：[`../src/components/DataWorkspace.tsx`](../src/components/DataWorkspace.tsx)
- 上下文：[`../src/context/studio-context.tsx`](../src/context/studio-context.tsx)
- 远程开库：[`../src/config/open-library-session.ts`](../src/config/open-library-session.ts)

## 6. 模块价值

该模块最大的价值不是业务规则，而是把新版 engine 的远程查询、批量暂存、导入、透视与 UI 组件装配成一条可以直接演示和验证的前端链路。

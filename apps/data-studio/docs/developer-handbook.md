# Data Studio 开发手册

## 1. 模块结构

- `src/App.tsx`
  应用根流程，负责会话恢复、连接态与工作区切换
- `src/components/ConnectionPanel.tsx`
  连接页与逻辑库选择
- `src/components/DataWorkspace.tsx`
  主工作区，装配 DataPageProvider、视图切换与导入
- `src/components/StudioToolbar.tsx`
  提交、刷新等操作入口
- `src/context/studio-context.tsx`
  i18n 与通知中心上下文
- `src/config/`
  会话恢复、开库与标签配置

## 2. 核心数据流

### 2.1 连接阶段

`ConnectionPanel` 先收集连接参数，再通过 `ModelDB.listDatabases()` 列出逻辑库；选中库后通过 `openLibrarySession()` 打开远程会话并读取 catalog。

### 2.2 工作区阶段

`DataWorkspace` 会：

- 根据 catalog 推导模型、字段、字段标签、字段类型
- 创建 `createSdkBindingExecutor(client)`
- 创建 query snapshot 或 pivot config
- 把这些数据注入 `DataPageProvider`

显示名与字段标签链路：

- `catalog.displayName` 用于数据库名称。
- `catalog.models[].displayName` 用于模型名称。
- `catalog.models[].fieldLabels` 用于字段、表格列、Pivot 列和导入字段。
- 继承模型需要通过 `parentId` 递归合并字段、字段类型和字段标签。
- 显示名模式统一使用 `@mode-db/data-kit` 的 `formatDisplayWithUnique` / `formatFieldDisplayLabel`，展示为 `显示名[唯一名]`。
- 唯一名模式必须绕过显示名，只展示稳定 name。

### 2.3 提交阶段

真正的批量提交由 `@mode-db/data-kit` 的 `BindingSession` 管理；`data-studio` 主要负责：

- 提供 executor
- 提供目标模型与字段配置
- 将提交结果转换成 toast

## 3. 关键文件

- 应用入口：[`../src/App.tsx`](../src/App.tsx)
- 连接页：[`../src/components/ConnectionPanel.tsx`](../src/components/ConnectionPanel.tsx)
- 工作区：[`../src/components/DataWorkspace.tsx`](../src/components/DataWorkspace.tsx)
- 打开逻辑库：[`../src/config/open-library-session.ts`](../src/config/open-library-session.ts)
- 导入结果提示：[`../src/utils/import-commit-notify.ts`](../src/utils/import-commit-notify.ts)
- 样式：[`../src/styles/studio-shell.css`](../src/styles/studio-shell.css)

## 4. 改动建议

### 4.1 逻辑边界

- 连接、恢复、catalog 获取放在 `config/` 或连接层
- 数据绑定与提交语义尽量留给 `@mode-db/data-kit`
- UI 渲染与局部交互放在组件层

### 4.2 组件改动

如果你在改：

- 表格/透视/导入展示
  先看 `DataWorkspace.tsx` 与 `@mode-db/data-ui`
- 连接流程
  先看 `ConnectionPanel.tsx` 与 `open-library-session.ts`
- 文案与语言切换
  先看 `i18n/locales/*/ui.json`

### 4.3 重要约束

- 不要在 `data-studio` 中直接引入本地 `AuthoringEngine`
- 不要复制 `data-kit` 中已有的 binding / import 规则
- 新增长期文案要同步 `zh/en/ja`
- 不要在 `DataWorkspace`、Pivot 和 ImportPanel 各写一套字段显示名逻辑；应复用 `data-kit` 格式器，避免显示名不稳定。
- 导入关系绑定不要只用 `forward` 名称定位关系；关系名是端点局部唯一，必须同时考虑导入模型和对端模型。
- 恢复、清除、强制重置后必须重新打开当前逻辑库并刷新 catalog。

## 5. 验证命令

```bash
pnpm --filter data-studio typecheck
pnpm --filter data-studio build
```

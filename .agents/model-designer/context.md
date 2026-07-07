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
6. 关系是 first-class entity；名称可变，但 `relation.id`、端点和层级归属不能因为重命名而丢失。
7. 库、模型、字段、关系的显示名是可选 i18n 元数据；为空时不能自动写成唯一名。
8. `sys_*` 保存必须 update-first / upsert，不能每次保存新增重复行。
9. 层级页高亮和显隐权重只在页模式或层级面板打开时生效。

## AI 改动首选入口

- 连接与工作区：`src/components/ConnectionFlow.tsx`
- 应用根流程：`src/App.tsx`
- 数据中心：`src/managers/data-manager.ts`
- 画布交互：`src/components/CanvasContainer.tsx`
- 字段编辑：`src/components/PropsEditor.tsx`
- 样式系统：`src/styles/designer-shell.css`
- 关系身份与基数：`src/utils/relation-identity.ts`
- 保存 / hydrate：`src/sync/designer-push-sync.ts`、`src/sync/designer-row-hydrate.ts`
- 逻辑库登记：`src/sync/library-registry.ts`

## AI 介入时必须检查

- 是否破坏双库模型
- 是否破坏 `sys_*` 结构假设
- 是否把 update/upsert 改成了 append-only 新增
- 是否把空显示名兜底写回唯一名
- 是否用关系名称替代 `relation.id` 做长期身份
- 是否需要同步更新 i18n
- 是否需要同步更新样式与响应式布局
- 是否需要同步更新文档或 `AGENTS.md`

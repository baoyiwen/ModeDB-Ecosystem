# Model Designer

`apps/model-designer` 是 ModeDB-Ecosystem 中面向建模人员与前端/平台开发人员的图形化模型设计器。

它的核心目标不是直接编辑用户业务库，而是通过一个固定的设计器专属逻辑库，维护：

- 模型与关系的可视化布局
- 图层、页面、分组等编辑器表现层信息
- 从业务库反向导入的模型/关系目录
- 设计器快照与后续 push / pull 所需的中间数据

与普通业务应用不同，`model-designer` 同时连接两类库：

1. 设计器专属库
   默认库名由 [`src/config/fixed-database.ts`](./src/config/fixed-database.ts) 中的 `FIXED_MODEL_DESIGNER_DATABASE` 决定，默认值为 `model_designer_workspace`。
   所有 `sys_*` 元模型、画布快照、图层与设计器侧元数据都只写入这个库。
2. 用户业务库
   用户在连接页选择的真实业务库，仅作为“业务 schema 与数据操作目标”存在。
   业务库中的模型、关系目录会被导入到设计器专属库中，用于画布编辑与可视化。

## 文档导航

- 模块说明文档：[`docs/module-overview.md`](./docs/module-overview.md)
- 操作手册：[`docs/operation-manual.md`](./docs/operation-manual.md)
- 开发手册：[`docs/developer-handbook.md`](./docs/developer-handbook.md)
- 模块级 AI 协作约束：[`AGENTS.md`](./AGENTS.md)
- 面向后续 AI 的上下文资料：[`../../.agents/model-designer/`](../../.agents/model-designer/)

## 本地运行

```bash
pnpm --filter model-designer dev
```

## 构建

```bash
pnpm --filter model-designer build
```

## 类型检查

```bash
pnpm --filter model-designer typecheck
```

如果工作区启用了 `pnpm approve-builds` 限制，构建可能先被依赖脚本审批拦住；这不是 `model-designer` 代码本身的错误。

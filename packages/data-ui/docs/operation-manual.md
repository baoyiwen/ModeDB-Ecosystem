# `@mode-db/data-ui` Operation Manual

## Typical usage

```tsx
<DataPageProvider executor={executor} querySnapshot={snapshot}>
  <DataPageToolbar />
  <DataViewPanel />
</DataPageProvider>
```

导入场景可额外使用 `ImportPanel`。

## Binding Surface usage

```tsx
<BindingSurfaceProvider contract={release.contract} session={surfaceSession}>
  <BindingSurfaceStatus />
  <BindingSurfaceTable />
</BindingSurfaceProvider>
```

- 宿主应用负责创建并稳定持有 `BindingSurfaceSession`。
- `BindingSurfaceTable` 根据发布契约生成字段保存和删除操作。
- `BindingSurfaceForm` 针对指定 `rowIndex` 展示逐字段显式写回。
- `BindingSurfaceRelationEditor` 根据契约展示 bind / unbind / rebind；只有参数来源包含 `editedValue` 时才要求输入关联目标。
- `BindingSurfaceStatus` 出现“变更已提交但刷新失败”时，可以执行读取刷新，不要再次提交原 mutation。

## ImportPanel inputs

`ImportPanel` 需要由宿主应用传入：

- `targetModel`
- `propFields`
- `catalogRelations`
- `catalogModels`
- `fieldLabels`
- `fieldTypes`
- `nameDisplayMode`

显示名规则：

- `nameDisplayMode="display"` 时显示 `显示名[唯一名]`。
- `nameDisplayMode="name"` 时只显示唯一名。
- 字段标签缺失时不要在组件内写入假标签，应检查 catalog 来源。

导入操作区建议保持在可视区域内，避免用户选择文件、暂存导入、提交时必须反复滚动。

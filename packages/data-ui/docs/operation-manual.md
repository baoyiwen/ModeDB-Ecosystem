# `@mode-db/data-ui` Operation Manual

## Typical usage

```tsx
<DataPageProvider executor={executor} querySnapshot={snapshot}>
  <DataPageToolbar />
  <DataViewPanel />
</DataPageProvider>
```

导入场景可额外使用 `ImportPanel`。

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

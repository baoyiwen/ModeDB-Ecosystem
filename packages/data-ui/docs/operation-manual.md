# `@mode-db/data-ui` Operation Manual

## Typical usage

```tsx
<DataPageProvider executor={executor} querySnapshot={snapshot}>
  <DataPageToolbar />
  <DataViewPanel />
</DataPageProvider>
```

导入场景可额外使用 `ImportPanel`。

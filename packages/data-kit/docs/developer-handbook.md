# `@mode-db/data-kit` Developer Handbook

## Key files

- `src/binding/binding-session.ts`
- `src/binding/sdk-binding-executor.ts`
- `src/view-data/query-result-adapter.ts`
- `src/pivot/pivot-snapshot.ts`
- `src/import/build-import-ops.ts`
- `src/import/relation-bind.ts`

## Key principles

- 业务提交语义优先通过 `BindingSession` 统一管理
- 查询结果适配与 UI 渲染分离
- import / bind 规则尽量可复用、无 UI 耦合

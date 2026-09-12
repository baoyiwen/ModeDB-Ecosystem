# @mode-db/data-ui

React components and **DataPageProvider** for ModelDB data pages. Built on
[`@mode-db/data-kit`](../data-kit).

## Documentation

- Module overview: [`docs/module-overview.md`](./docs/module-overview.md)
- Operation manual: [`docs/operation-manual.md`](./docs/operation-manual.md)
- Developer handbook: [`docs/developer-handbook.md`](./docs/developer-handbook.md)
- AI collaboration rules: [`AGENTS.md`](./AGENTS.md)
- AI context pack: [`../../.agents/data-ui/`](../../.agents/data-ui/)

## Usage

```tsx
import { DataPageProvider, DataPageToolbar } from '@mode-db/data-ui';

<DataPageProvider executor={executor} querySnapshot={snapshot}>
  <DataPageToolbar />
  {/* DataTable, PivotTable, … */}
</DataPageProvider>;
```

## Binding Surface

```tsx
const surfaceSession = createBindingSurfaceSession({
  surfaceId: release.contract.surfaceId,
  version: release.version,
  executor: client,
});

<BindingSurfaceProvider contract={release.contract} session={surfaceSession}>
  <BindingSurfaceStatus />
  <BindingSurfaceTable />
  <BindingSurfaceForm rowIndex={0} />
  <BindingSurfaceRelationEditor rowIndex={0} />
</BindingSurfaceProvider>;
```

The host owns the `BindingSurfaceSession` and must keep it stable while the provider is mounted.
Table and form edits invoke one published mutation at a time. A form with several editable fields is
therefore not an implicit transaction. `BindingSurfaceStatus` keeps committed mutations with failed
refreshes distinct from failed mutations.

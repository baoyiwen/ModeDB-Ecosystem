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

Table / Pivot components will be added incrementally.

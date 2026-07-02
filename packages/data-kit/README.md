# @mode-db/data-kit

Headless **data page kit** for ModeDB: global `view` / `edit` / `delete` modes, batch
**DataBinding** over `EngineOperation`, normalized **ViewDataShape** for UI components, and
**ingest / import** protocol types.

## Documentation

- Module overview: [`docs/module-overview.md`](./docs/module-overview.md)
- Operation manual: [`docs/operation-manual.md`](./docs/operation-manual.md)
- Developer handbook: [`docs/developer-handbook.md`](./docs/developer-handbook.md)
- AI collaboration rules: [`AGENTS.md`](./AGENTS.md)
- AI context pack: [`../../.agents/data-kit/`](../../.agents/data-kit/)

React components (`DataTable`, `PivotTable`, …) will live in `@mode-db/data-ui`. Model Designer
composes those components into pages via {@link ViewSpec}.

## Dependencies

- `@mode-db/shared` — `EngineOperation`, `RemoteExecuteSnapshot`, wire query results

## Quick start

```typescript
import {
  createBindingSession,
  adaptQueryResult,
  type BindingExecutor,
  type DataPageMode,
} from '@mode-db/data-kit';

const executor: BindingExecutor = {
  executeQuery: (snapshot) => client.apply({ op: 'executeQuery', snapshot }),
  applyAll: (ops, opts) => client.applyAll(ops, opts),
};

const binding = createBindingSession({
  querySnapshot,
  executor,
});

await binding.refresh();

// edit mode — staged until commit
binding.stage({ op: 'update', model: 'Country', id: 'jp', data: { name: 'Japan' } }, 'edit');
await binding.commit();
```

## Package layout

| Path           | Role                                    |
| -------------- | --------------------------------------- |
| `page-mode.ts` | Global `view` / `edit` / `delete`       |
| `view-spec.ts` | Designer page / view JSON               |
| `view-data/`   | `ViewDataShape` + query result adapter  |
| `binding/`     | Batch `BindingSession` + mode guards    |
| `ingest/`      | Streaming adapter types (CSV, Excel, …) |
| `import/`      | `ImportProfile`, cleaning rules         |

## Pivot editing

Pivot views expose `isLeafGrain` on {@link ViewDataShape}. Only leaf grain allows edit staging;
aggregated metric cells stay read-only.

# Pivot Tab v1 contract

Pivot Tab is the Model Designer result inspection surface. It has two data
sources, model browsing and Query Interface invocation, but both sources are
normalized into the same result document before rendering.

## v1 scope

- Model records and published Query Interface results can be inspected.
- A result can be rendered as a tree table, a flat table, or raw JSON.
- `current` language, `raw` value, and `all` language display modes are
  supported by the presentation layer.
- Pagination metadata is preserved. Loading another page is explicit.
- "Full dataset" means every row and field returned by the selected model
  query or interface. It does not bypass a Query Interface projection to read
  hidden database fields.
- Query Interface access keys, release selection, rate limits, and server
  error contracts remain in force.

## Data source boundary

The source layer owns connection, query execution, parameters, release
selection, and pagination. The Pivot result model owns only normalized rows,
paths, values, and page metadata. React components must not open database
sessions or call the wire protocol directly.

## Result model

Each row keeps its original record and has a tree of `PivotNode` values. A node
path is made from field segments and array index segments. Node IDs are stable
within a result document and are derived from the row index and path. The raw
record is never replaced by a localized display value.

## Deferred extensions

Conditional colors, icons, badges, formatting, and tooltips will be declarative
presentation rules bound to a node, field, or output path. They will not mutate
the query result or execute arbitrary JavaScript. A true drag-and-drop
two-dimensional pivot table is outside v1.

## P4/P6 implementation status

The first usable Pivot viewer is opened contextually from a selected model or
from the published Query Interface editor. It opens as a full-screen result
viewer instead of a persistent top-level menu. A contextual model view is
bound to the selected model's declared properties; `_id`, tombstone metadata,
and undeclared storage fields are removed before normalization. An interface
view is bound to the published result contract and therefore only shows its
projected output. It accepts interface parameters as JSON and renders loading,
errors, empty results, a tabular hierarchy with expandable rows, a flattened
scan table, and raw JSON.
Session creation remains in `src/pivot/execute.ts`; the React surface only
coordinates selection and presentation.

When the viewer is opened with a model or interface context, it automatically
executes that source once and renders the result without requiring an extra
click. Editing interface parameters does not trigger a request on every
keystroke; the user can run the edited parameters explicitly.

Known gaps in the current UI:

- Only the first page is executed; there is no page navigation control yet.
- There is no access key input, so interfaces that require an
  interface-specific access key cannot be invoked from Pivot.

Unit tests: `test/unit/pivot-result-model.test.ts` and
`test/unit/pivot-sources.test.ts` (run with `npx tsx --test`; not yet part of
`pnpm test:unit`).

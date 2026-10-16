# Pivot Tab v1 contract

Pivot Tab is the Model Designer result inspection surface. It has two data
sources, model browsing and Query Interface invocation, but both sources are
normalized into the same result document before rendering.

## v1 scope

- Model records and published Query Interface results can be inspected.
- The default view is a composite tree table. A field/value hierarchy and raw
  JSON remain available for inspection.
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
errors, empty results, composite tables with expandable relation rows,
a field/value hierarchy, and raw JSON.
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

Unit tests: `test/unit/pivot-result-model.test.ts`,
`test/unit/pivot-sources.test.ts`, and `test/unit/pivot-presentation.test.ts`
(run with `npx tsx --test`; not yet part of
`pnpm test:unit`).

## Composite table and localization

Each model/query node has a model caption and its own property columns.
Relation results are nested tables immediately below their parent record,
collapsed by default for a scan-friendly primary table. Each record can be
expanded independently; expand-all/collapse-all controls apply to every level.
Empty relations remain visible when their parent is expanded. A terminal node
with no selected fields is a compact relation summary, not a repeated empty table.
A node with no selected projection fields shows a no-fields state;
the viewer never fetches extra properties to fill that node.

For published interfaces, `executionTemplate.resultAdapter` is the authority
for output keys and relation nesting. The published query graph and projection
map those keys to query node IDs, model IDs, property IDs, and relation IDs.
Self-relations and repeated instances of a model keep independent projections;
they are not merged by model ID. Relation captions use the graph edge's
forward/reverse direction. Model browsing uses directional policies at each
relation level so deeper joins do not reuse the root model's field allowlist.

Model, relationship, and column captions resolve their configured i18n display
names in the current UI language, with the existing canonical-name fallback.
Column captions do not display flattened `model.field` or array-index paths.
I18N properties are a single cell: current-language mode resolves their value,
while raw/all-language modes keep the entire map. Ordinary JSON properties
remain intact. Locale switching changes presentation without executing a new
query or replacing any raw values. Raw JSON retains the exact returned payload.

Missing/null cells use a quiet dash with a tooltip distinguishing the two;
current-language boolean values use localized yes/no labels. Numeric cells
align right together with their column headings and empty cells; text columns
align left. Alignment is determined per column, not separately per value.
The source header is compact, parameters are collapsible (initially
open when required inputs are missing), and the result scrolls inside its own
container with sticky root column headings.

## Reopening and editor context

The interface list always exposes `Edit query` and, for active releases,
`View data`, without expanding documentation. `Edit query` restores the saved
query chain to the Query Designer canvas; `Interface settings` retains the
full-width configuration surface. The result viewer also has an edit entry.
Explicitly reopening a saved interface reloads its complete saved form, even
if that interface is already active. Merely opening and closing temporary
panels does not reload the form.
Restoring an interface clears pending model/relation pick dialogs but does not
republish it or change business rows.

Management, settings, notifications, and Pivot are temporary panels, not editor
mode switches. Opening/closing them preserves the selected editor and tool.
The Query Designer form stays mounted behind temporary panels to retain unsaved
fields, filters, pagination, and name changes. Closing its drawer hides the
panel without leaving query mode; selecting Query Designer reopens the panel.

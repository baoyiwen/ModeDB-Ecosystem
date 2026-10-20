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
projected output. It generates typed parameter fields from the published contract and renders loading,
errors, empty results, a tabular hierarchy with expandable rows, a flattened
scan table, and raw JSON.
Session creation remains in `src/pivot/execute.ts`; the React surface only
coordinates selection and presentation.

When the viewer is opened with a model or interface context, it automatically
executes that source once when its required inputs are available and renders the result without requiring an extra
click. An interface with missing required parameters or an access key waits for input instead of sending a failing request. A newly opened viewer or a changed data source defaults to the table
view; the hierarchy is an explicit alternate view. The action is labeled
Refresh and reloads the current source, rather than presenting an execution
editor. Editing interface parameters does not trigger a request on every
keystroke; Refresh applies the edited parameters explicitly.

Model browsing exposes an inline AND/OR filter form based on the live business
catalog and designer-associated fields. Preview and model export use the same
typed conditions in the database query. An edited form marks the preview as
pending until Refresh succeeds. Model export refreshes that preview first and
stops if it fails. Export, blank templates, and expandable read-only import
validation stay inside the Pivot viewer without opening a second dialog.
ExcelJS loads only when a workbook is requested. Model conditions and import
reports are scoped to the selected source; late responses cannot replace a
different source's preview. Export reads all matching records within its limit,
while the preview remains a sample. The two reads are not a transaction snapshot.
Interface projection/access restrictions remain unchanged.

Typed filters cover equality, inequality, text containment, numeric/date ranges,
and null checks. Inputs use numeric, boolean, datetime, color and locale controls
as appropriate. Adjacent AND conditions form groups joined with OR. Local datetime
input is converted to an absolute ISO instant before transport. Date comparison
and explicit I18N locale paths require the updated engine in a restarted server.

Tables resolve projected headers from model metadata for every query occurrence,
including aliases, self joins and nested relationships. Relations expand into
nested tables rather than columns for every array index. I18N stays a single
field in the current language; raw values remain intact. Dates display as
`yyyy-mm-dd hh:mm:ss` with the source timezone, and cells have visible borders.

Model pagination is off by default and can be enabled with a switch. Published
interfaces follow their release's none/offset/cursor setting. The viewer offers
page size, previous/next, current page, and totals when returned. Cursor history
supports returning to a previously visited page. Changed conditions or page size
restart at the first page. Model export still reads all matching records;
interface export refreshes and exports only the current page.

## Published interface inputs

The inline parameter form uses `publishedRelease.queryInterface.contract`, never
an unpublished draft. It shows the published version, parameter labels/names,
types, required status, defaults, descriptions and associated model fields.
Number, boolean, date, datetime and JSON inputs are validated before a request;
reference inputs accept an ID or JSON. Enum parameters currently use a text
field because the contract does not carry a list of enum choices.

Blank fields are omitted from the request so the runtime applies published
defaults. Explicit `0` and `false` remain typed values. An optional blank input
does not promise that its filter is skipped: the published runtime defines that
behavior. The viewer displays active fixed/parameter conditions, nested AND/OR
groups, relation quantifiers and HAVING conditions. Model/field labels follow
the current language; node aliases distinguish repeated models and self joins.
These conditions are read-only; changing them requires editing and republishing
the interface in Query Designer.

Key-protected interfaces expose a password input and pass it through the same
SDK invocation. Parameters, validation state and the key are reset when the
source/release changes; the key is not persisted. Editing inputs marks the
result as pending until Refresh succeeds. Input does not trigger per-keystroke
requests. The form and conditions stay inside the existing Pivot window.

Interface results now use the inline data-transfer toolbar too. Export refreshes
the published invocation once, then exports exactly that returned result (the
current page for paginated interfaces). It never runs a separate model query to
fill in missing fields or IDs. Projected entity fields are mapped back to model
sheets; repeated identities are deduplicated, while `_relations` and `_paths`
retain relationship directions and every query occurrence. Full language values
are preserved. Missing identities or aggregate results produce a report that
the importer rejects. Non-aggregate interfaces can generate blank templates.
Field types come from the live business catalog, without widening the published
field projection when canvas metadata is stale.
Read-only import preflight checks the current release identity, allowed models,
fields, relationships, paths and live catalog/ID constraints. It does not submit
records or relationships.

Closing Pivot or choosing Back returns to its originating interface manager or
editor. The viewed interface card reopens and the selected canvas editor remains
unchanged. Source information, conditions, actions and view/language controls
stay in a fixed toolbar above the result pane. Pagination and task feedback stay
in a fixed footer below it. Both footer rows are present from first mount, with
bounded heights and horizontal overflow for narrow pagination controls. Loading,
errors, pending conditions and export progress update the status row without
inserting toolbar content. Data-transfer controls mount synchronously; Excel
encoding remains dynamically loaded. The Refresh label and button width stay
constant while a busy icon indicates activity.
Request locks retain the toolbar controls' normal opacity; permanent restrictions
such as unavailable templates keep their disabled styling. The refresh icon alone
rotates, for at least 600 ms on quick queries, without delaying query completion.
Only the result pane
scrolls horizontally and vertically when browsing data; expanded tables never
create nested scroll containers. Oversized expanded configuration panels are
bounded within the toolbar so the result pane remains accessible. Table headers
and data cells are vertically centered. The first column combines
the row number and expand/collapse control, without a separate relationship
column. Expanded records are rendered as consecutive table blocks in document
flow, so each sticky header is replaced by the next table's header, including
when returning to later parent records. Localized branch captions identify child
tables. The source name/version stays on one compact line; parameter/condition
details and export help expand on demand. Missing required parameters or an
access key initially open the input section.

The toolbar and result area share one white workspace surface. Child tables keep
their indentation and localized captions without extra cards or colored depth
borders. Headers, values and row controls use a consistent line height and
vertically centered content, including rows containing wrapped JSON values.
The result scroll pane reserves scrollbar space and disables browser scroll
anchoring. Refreshing the same source, conditions and page preserves table
expansion; changing those inputs resets it. A failed refresh retains the last
successful result with an explicit status message instead of clearing the table.

Known gaps in the current UI:

- Import submission and full-dataset interface pagination are later stages.

Tests: `test/unit/pivot-result-model.test.ts`, `test/unit/pivot-sources.test.ts`,
`test/unit/pivot-interface-input.test.ts` and `test/unit/pivot-interface-http.test.ts`
(run with `npx tsx --test`; not yet part of `pnpm test:unit`). The isolated HTTP/SDK
test checks typed zero/false values, runtime defaults, required access keys,
explicit release selection, projection and an unchanged business vault hash.
`test/unit/interface-transfer.test.ts` covers model sheets, original IDs,
self/reverse relationships, repeated paths, Excel round trips and report-only
restrictions, as part of `pnpm run test:data-transfer`.

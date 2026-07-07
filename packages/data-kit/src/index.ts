/**
 * @mode-db/data-kit — headless data page kit for ModelDB data UI.
 *
 * Modes, batch binding, view data shapes, ingest/import protocols.
 * React components live in `@mode-db/data-ui` (future).
 */

export type { DataPageMode, DataPageMutationMode } from './page-mode.js';
export { DEFAULT_ALLOWED_MODES, canEnterMode, isMutationMode } from './page-mode.js';

export type { ViewSpec, DataPageSpec } from './view-spec.js';

export type {
  ColumnDef,
  MetricDef,
  ViewPagination,
  EntityRowRef,
  ViewDataShape,
  ViewTreeNode,
  ViewGroupBucket,
} from './view-data/view-data-shape.js';
export { isPivotLeafEditable, isViewEditable } from './view-data/view-data-shape.js';

export {
  wireEntitiesToTreeNodes,
  analysisTreeToViewNodes,
  hasNestedRelates,
  flattenVisibleTreeNodes,
  inferTreeColumns,
} from './view-data/tree-builders.js';

export type { AdaptQueryResultOptions } from './view-data/query-result-adapter.js';
export {
  adaptQueryResult,
  adaptUnknownQueryResult,
  startModelFromSnapshot,
} from './view-data/query-result-adapter.js';

export type {
  BindingExecutor,
  ApplyBatchResult,
  BindingListener,
} from './binding/binding-executor.js';
export type { BindingSession, BindingSessionOptions } from './binding/binding-session.js';
export { createBindingSession } from './binding/binding-session.js';
export { assertOpAllowedForMode, BindingModeError } from './binding/mode-guards.js';
export {
  WIRE_EMPTY_TRAILING,
  wireTrailingFromDrill,
  type TrailingDrillStep,
} from './binding/wire-trailing.js';
export { withQueryPage, createTabularSnapshot } from './binding/query-snapshot.js';
export {
  overlayPendingEdits,
  pendingDeleteRowIndices,
  isUpdateForCell,
  isDeleteForRow,
} from './binding/pending-overlay.js';
export { createSdkBindingExecutor, type SdkBindingClient } from './binding/sdk-binding-executor.js';

export type {
  IngestFormat,
  IngestSource,
  IngestColumnSchema,
  IngestSchema,
  IngestRow,
  IngestHandle,
  IngestAdapter,
  IngestAmbiguity,
  IngestAutoMapResult,
} from './ingest/types.js';

export type {
  CleaningRule,
  ImportStrictness,
  RelationBindingRule,
  ImportProfile,
  ImportCheckpoint,
} from './import/import-profile.js';

export {
  propFieldsFromCatalogFields,
  isSystemRowField,
  applyPropFieldColumns,
  SYSTEM_ROW_FIELD_KEYS,
} from './view-data/prop-fields.js';
export type { FieldLabelMap } from './view-data/field-display-label.js';
export {
  buildFieldColumnLabels,
  fieldDisplayNameForLocale,
  formatDisplayWithUnique,
  formatFieldDisplayLabel,
  formatFieldOptionLabel,
} from './view-data/field-display-label.js';

export type {
  PivotDrillStep,
  PivotViewConfig,
  BuildPivotSnapshotResult,
} from './pivot/pivot-snapshot.js';
export { buildPivotSnapshot, appendPivotDrill, popPivotDrill } from './pivot/pivot-snapshot.js';

export { CsvIngestAdapter, csvIngestAdapter } from './ingest/csv-adapter.js';
export { parseCsvLine, coerceCsvCell, rowFromCsvLine } from './ingest/csv-parse.js';

export {
  normalizeColumnKey,
  autoMapIngestColumns,
  mergeColumnMapping,
  type AutoMapIngestOptions,
} from './import/auto-map.js';
export { applyCleaningRules, mapIngestRow } from './import/apply-cleaning.js';
export {
  buildImportInsertOps,
  collectImportOpsFromHandle,
  createImportProfile,
  MAX_INSERT_MANY_BATCH,
  DEFAULT_IMPORT_CHUNK_SIZE,
  type BuildImportOpsResult,
  type BuildImportOpsOptions,
} from './import/build-import-ops.js';

export {
  coerceImportValue,
  coerceImportRow,
  coerceInsertManyOps,
  importFieldTypesForProps,
  type ImportFieldTypeMap,
} from './import/coerce-import-row.js';

export {
  buildRelationBindOps,
  resolveProtocolBindMatch,
  relationsForImportModel,
  relatedModelForImport,
  suggestRelationBindings,
  mergeRelationBindings,
  isBindOnlyRelationRule,
  type CatalogRelationRef,
  type CatalogModelRef,
  type ProtocolBindMatch,
} from './import/relation-bind.js';

export {
  normalizeImportLookupKey,
  coerceImportLookupKey,
  peerMatchFieldTypeForRule,
  coerceBindOnlyJoinValue,
  readJoinValueFromIngestRow,
  buildBindImportLookupOps,
  type ImportBindOnlyStaging,
  type BindOnlyJoinChunk,
} from './import/import-lookup-bind.js';

export { commitImportBatch } from './binding/import-commit.js';

export {
  pickPropFields,
  mutationOutcomeError,
  firstApplyOutcomeError,
  summarizeInsertManyOutcomes,
} from './binding/apply-outcome.js';
export type { ImportRowFailure } from './binding/insert-many-failures.js';
export {
  extractInsertManyFailures,
  rebuildPendingAfterInsertManyFailures,
  stripRelationBindOps,
  countInsertManySuccesses,
} from './binding/insert-many-failures.js';

export type { RemoteExecuteSnapshot, AggregateInputEntry } from '@mode-db/shared';

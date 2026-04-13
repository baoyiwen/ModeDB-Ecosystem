// ---------------------------------------------------------------------------
// Authoring (write-side)
// ---------------------------------------------------------------------------
export {
  AuthoringEngine,
  Engine,
  ModelDBAdmin,
  AtlasRegistry,
  type AuthoringEngineOptions,
} from './authoring/index.js';
export { ModelEntity, AuthoringModel } from './authoring/entity.js';
export type { AvailableRelation, UpdateOptions, DeleteOptions } from './authoring/entity.js';
export { RelationEntity, AuthoringRelation } from './authoring/relation-entity.js';
export { ModelStorage } from './authoring/storage.js';
export { RelationIndexer } from './authoring/indexer.js';

// ---------------------------------------------------------------------------
// Runtime (read-side)
// ---------------------------------------------------------------------------
export {
  Runtime,
  ModelDBClient,
  RuntimeModel,
  RuntimeRelation,
  HydratedEntity,
  ReadonlyModelEntity,
  type RuntimeContext,
  type ReadonlyAvailableRelation,
  configureModelDBRuntime,
  resolveModelDBStorageRoot,
  type ModelDBRuntimeConfig,
  type QueryExecuteOptions,
  type RelationEmptyReason,
  type RelateDiagnostic,
  type HydrationContext,
  resolveRelationOnRegistry,
  targetModelName,
  type ResolvedRelation,
  type ResolvedDirection,
  QueryChain,
  type Paginated,
  isPaginatedExecuteResult,
  ComputeBuilder,
  mergeComputeTokens,
  isComputeMetricToken,
  GroupInstance,
  isGroupInstance,
  collectRecursiveRelationIdsBFS,
  collectDescendantIdsFromSeed,
  RelateFilterBuilder,
  FilterBuilder,
  PredicateComposer,
  QueryEngine,
  mergeMatchAnyIntoSegment,
  compileSegments,
  isAnalysisReport,
  isAnalysisResult,
  DataPivot,
  PivotTable,
  PivotHydratedRecursiveBuilder,
  PIVOT_UNLINKED_KEY,
  PIVOT_LEAF_SYMBOL,
  isPivotLeafNode,
  resolveHydratedPivotSegment,
  parseGroupDimension,
  readFieldPathSync,
  pivotSegmentKey,
  Aggregator,
  AggregatorEngine,
  AggregationProtocol,
  BucketAggregator,
  AnalysisResult,
  buildAnalysisRunMetadata,
  buildAnalysisTraceability,
  expandBuiltinAggregateSpec,
  isMetricsLeafShape,
  StatAccumulator,
  traceableNull,
  isTraceableNull,
  isStatMissing,
  coerceFiniteNumber,
  TRACEABLE_REASON_ALL_MISSING,
  normalizeOperator,
  type LocalFilterState,
  type QueryStartSpec,
  type QueryPlanASTv2,
  type PredicateNode,
  type EvaluateResult,
  type PredicateStandardOperator,
  type PredicateAtomOperator,
  type PredicateEvaluateContext,
  type PredicateFailureKind,
  type ScalarOperator,
  type AtomicPredicate,
  type RelationTraceStatus,
  type HydratedEntitySnapshot,
  type AggregateOp,
  type AggregateInputEntry,
  type AggregationProtocolOp,
  type AnalysisReport,
  type AnalysisFlatRow,
  type AnalysisRunMetadata,
  type AnalysisMetricMetadata,
  type AnalysisBucketMetadataRow,
  type AnalysisTraceability,
  type AnalysisTraceabilityBucket,
  type AnalysisTraceabilityMetric,
  type CustomReducerSpec,
  type PivotLeafNode,
  type ParsedGroupDimension,
  type ComputeMetricToken,
} from './runtime/index.js';
export type { TraceableNull } from './runtime/index.js';
export type { RuntimeAvailableRelation } from './runtime/model-runtime.js';
export type { DataReader, IndexReader } from './common/provider.js';

// ---------------------------------------------------------------------------
// Common (shared types, errors, registry)
// ---------------------------------------------------------------------------
export { ModelRegistry } from './common/registry.js';
export {
  PathResolver,
  AtlasPathResolver,
  DEFAULT_STORAGE_ROOT,
  STORAGE_ROOT,
  assertFlatGraphSegment,
} from './common/atlas-paths.js';
export {
  configureModelDBStorageRoot,
  type ModelDBStorageRootConfig,
} from './common/storage-root-config.js';
export {
  ATLAS_MANIFEST_FILENAME,
  ATLAS_MANIFEST_FORMAT_VERSION,
  parseAtlasManifestJson,
  serializeAtlasManifestFile,
} from './common/atlas-manifest.js';
export {
  EngineError,
  AtlasIsolationError,
  AtlasManifestError,
  StorageError,
  ModelNotRegisteredError,
  FileIOError,
  ValidationError,
  RegistryError,
  DuplicateModelError,
  ParentNotFoundError,
  DuplicateRelationError,
  RelationModelNotFoundError,
  IndexerError,
  QueryError,
  RelationNotFoundError,
} from './common/errors.js';
export { DELETED_SENTINEL, isDeletedRecord } from './common/types.js';
export {
  DataType,
  validateFieldValue,
  normalizeFieldDefs,
  normalizeFieldDef,
  coerceI18NValue,
} from './common/data-types.js';
export type {
  FieldTypeDef,
  FieldTypeMap,
  FieldDefInput,
  FieldDefsRecord,
} from './common/data-types.js';
export {
  ValueObject,
  I18NValue,
  ColorValue,
  UnitValue,
  StringValue,
  NumberValue,
  IntValue,
  BooleanValue,
  DateTimeValue,
  JsonValue,
  createValueObject,
  unwrapValue,
} from './common/value-objects.js';
export type { ValueSyncFn, I18NDict, RGBA, UnitData } from './common/value-objects.js';
export type {
  ModelSchema,
  ModelDefinition,
  RelationDefinition,
  RelationLogic,
  MatchPredicate,
  RelationIndexData,
  RelationStats,
  RelationBindOptions,
  ModelRecord,
  RecordMeta,
  BindStrategy,
  BindOptions,
  ConditionFn,
} from './common/types.js';

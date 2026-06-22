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
export {
  AtlasSingleVault,
  fileLooksLikeAtlasSingleVault,
  ATLAS_SINGLE_VAULT_MAGIC,
} from './authoring/atlas-single-vault.js';

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
  type MemoryShadowOptions,
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
  queryPlanHasSerializedCallback,
  deserializePredicate,
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
} from './facade/index.js';
export type { TraceableNull, RemoteExecuteSnapshot } from './facade/index.js';
export type { RuntimeAvailableRelation } from './facade/model-runtime.js';
export type { DataReader, IndexReader } from '@mode-db/common';

// ---------------------------------------------------------------------------
// Common (shared types, errors, registry)
// ---------------------------------------------------------------------------
export { ModelRegistry } from '@mode-db/common';
export {
  PathResolver,
  AtlasPathResolver,
  DEFAULT_STORAGE_ROOT,
  STORAGE_ROOT,
  assertFlatGraphSegment,
} from '@mode-db/common';
export {
  configureModelDBStorageRoot,
  deriveAtlasVaultSecretFromConnectToken,
  type ModelDBStorageRootConfig,
} from '@mode-db/common';
export {
  ATLAS_MANIFEST_FILENAME,
  ATLAS_MANIFEST_FORMAT_VERSION,
  parseAtlasManifestJson,
  serializeAtlasManifestFile,
} from '@mode-db/common';
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
} from '@mode-db/common';
export { DELETED_SENTINEL, isDeletedRecord } from '@mode-db/common';
export {
  DataType,
  validateFieldValue,
  isFieldValueEmpty,
  normalizeFieldDefs,
  normalizeFieldDef,
  coerceI18NValue,
} from '@mode-db/common';
export type { FieldTypeDef, FieldTypeMap, FieldDefInput, FieldDefsRecord } from '@mode-db/common';
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
} from '@mode-db/common';
export type { ValueSyncFn, I18NDict, RGBA, UnitData } from '@mode-db/common';
export type { ValidateFieldOptions } from '@mode-db/common';
export { DiagnosticCenter, ValidationReport, ErrorCodes } from '@mode-db/common';
export type {
  Severity,
  DiagnosticCode,
  DiagnosticContext,
  Diagnostic,
  DiagnosticLocale,
  RowResult,
  CodeEntry,
  ValidationReportSummary,
  ValidationReportJSON,
} from '@mode-db/common';
export { EngineLogger, type EngineLoggerConfigureOptions } from '@mode-db/common';
export { DiskAdapter } from '@mode-db/common';
export type { EngineLogLevel } from '@mode-db/common';
export { InternalVault } from '@mode-db/common';
export { SmartCache } from '@mode-db/common';
export { encodeMldLine, parseMldLine, SHADOW_LINE_PREFIX } from '@mode-db/common';
export type { ParsedMldLine } from '@mode-db/common';
export { deriveWireSessionKey, encodeWirePayload, decodeWirePayload } from '@mode-db/common';
export type {
  WireClientMessage,
  WireHandshakeRequest,
  WireRpcEnvelope,
  WireExecuteBody,
  WireServerMessage,
  WireRelationLogic,
  WireMatchPredicate,
  WireRowRef,
  WireBindStrategy,
  WireRelationStats,
} from './src/network/wire-protocol.js';
export type { WireExecuteResultJson } from './src/network/execute-result-wire.js';
export { serializeExecuteResultForWire } from './src/network/execute-result-wire.js';
export {
  executeDatabaseOperation,
  type DatabaseOperationContext,
} from './src/network/operation-executor.js';
export {
  registerPipeGalleryModels,
  type PipeGalleryModelNames,
} from './templates/pipe-gallery/register.js';
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
} from '@mode-db/common';

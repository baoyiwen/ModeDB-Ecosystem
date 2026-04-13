/**
 * Standalone Runtime SDK (read-only client). No dependency on authoring write paths.
 */
import { ModelDBClient } from './ModelDBClient.js';

export { ModelDBClient };
export type { RuntimeContext } from './context.js';
export { ModelEntity } from './ModelEntity.js';
export { RuntimeModel } from './RuntimeModel.js';
export type { RuntimeAvailableRelation } from './RuntimeModel.js';
export { RuntimeRelation } from './RuntimeRelation.js';
export {
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
  mergeDiskRowsWithAuthoringBuffer,
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
  type LocalFilterState,
  type QueryStartSpec,
  type QueryPlanASTv2,
  type PredicateNode,
  type EvaluateResult,
  type PredicateStandardOperator,
  type PredicateAtomOperator,
  type PredicateEvaluateContext,
  type PredicateFailureKind,
  type AggregateOp,
  type AggregateInputEntry,
  type AggregationProtocolOp,
  type AnalysisRunMetadata,
  type AnalysisMetricMetadata,
  type AnalysisBucketMetadataRow,
  type AnalysisTraceability,
  type AnalysisTraceabilityBucket,
  type AnalysisTraceabilityMetric,
  type AnalysisReport,
  type AnalysisFlatRow,
  type CustomReducerSpec,
  type PivotLeafNode,
  type ParsedGroupDimension,
  type ComputeMetricToken,
  queryPlanHasSerializedCallback,
} from './query.js';
export type { TraceableNull, RemoteExecuteSnapshot } from './query.js';
export { normalizeOperator, type ScalarOperator, type AtomicPredicate } from './query-filter.js';
export { deserializePredicate, serializePredicate } from './predicate-tree.js';
export type { QueryExecuteOptions } from './HydratedEntity.js';
export {
  HydratedEntity,
  type RelationEmptyReason,
  type RelateDiagnostic,
  type HydrationContext,
  type MemoryShadowOptions,
  type RelationTraceStatus,
  type HydratedEntitySnapshot,
} from './HydratedEntity.js';
export {
  resolveRelationOnRegistry,
  targetModelName,
  type ResolvedRelation,
  type ResolvedDirection,
} from './relation-resolve.js';
export { ModelFileReader } from './ModelFileReader.js';
export { RelationIndexFileReader } from './RelationIndexFileReader.js';
export type { DataReader, IndexReader } from '../../common/provider.js';
export {
  configureModelDBRuntime,
  resolveModelDBStorageRoot,
  type ModelDBRuntimeConfig,
} from '../../runtime/config.js';

/** @deprecated Use {@link RuntimeModel}. */
export { RuntimeModel as ReadonlyModelEntity } from './RuntimeModel.js';

/** @deprecated Use {@link RuntimeAvailableRelation}. */
export type { RuntimeAvailableRelation as ReadonlyAvailableRelation } from './RuntimeModel.js';

/** @deprecated Prefer {@link ModelDBClient}. */
export class Runtime extends ModelDBClient {}

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
  RelateFilterBuilder,
  type LocalFilterState,
  type QueryStartSpec,
} from './query.js';
export { normalizeOperator, type ScalarOperator, type AtomicPredicate } from './query-filter.js';
export type { QueryExecuteOptions } from './HydratedEntity.js';
export {
  HydratedEntity,
  type RelationEmptyReason,
  type RelateDiagnostic,
  type HydrationContext,
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

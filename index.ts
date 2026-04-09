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
export type { AvailableRelation } from './authoring/entity.js';
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
  ReadonlyModelEntity,
  type RuntimeContext,
  type ReadonlyAvailableRelation,
  configureModelDBRuntime,
  resolveModelDBStorageRoot,
  type ModelDBRuntimeConfig,
} from './runtime/index.js';
export { QueryChain } from './runtime/query.js';
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
  RegistryError,
  DuplicateModelError,
  ParentNotFoundError,
  DuplicateRelationError,
  RelationModelNotFoundError,
  IndexerError,
  QueryError,
  RelationNotFoundError,
} from './common/errors.js';
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

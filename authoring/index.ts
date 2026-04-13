// Authoring-side public API (entry re-export lives under `src/authoring/AuthoringEngine.ts`)
export {
  AuthoringEngine,
  Engine,
  type AuthoringEngineOptions,
} from '../src/authoring/AuthoringEngine.js';
export { ModelDBAdmin } from './admin.js';
export { AtlasRegistry } from './atlas-registry.js';
export { ModelEntity, AuthoringModel, type InsertOptions } from './entity.js';
export type { AvailableRelation } from './entity.js';
export { RelationEntity, AuthoringRelation } from './relation-entity.js';
export { ModelStorage } from './storage.js';
export { RelationIndexer } from './indexer.js';
export { PersistenceManager, registerAuthoringShutdownTask } from './persistence-manager.js';
export { MergedDataReader } from './merged-data-reader.js';
export type { BufferedModelSource } from './merged-data-reader.js';

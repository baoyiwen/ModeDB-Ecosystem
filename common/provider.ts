import type { ModelRecord, RelationDefinition } from './types.js';

/**
 * Read-only contract for model data access.
 *
 * Implemented by {@link ModelStorage} in the authoring layer.
 * Consumed by {@link QueryChain} and {@link ReadonlyModelEntity} in the
 * runtime layer — these never see write methods like `insert`.
 */
export interface DataReader {
  getByIds(modelName: string, ids: string[]): Promise<ModelRecord[]>;
  getAll(modelName: string): Promise<ModelRecord[]>;
  /**
   * Optional: stream `.mld` until `record[field] === value` (strict `===`), then stop.
   * Used by {@link QueryChain} for `where(field, 'eq', value)` without loading the full file.
   */
  findFirstByFieldEq?(
    modelName: string,
    field: string,
    value: unknown,
  ): Promise<ModelRecord | undefined>;
}

/**
 * Read-only contract for relation index access.
 *
 * Implemented by {@link RelationIndexer} in the authoring layer.
 * Consumed by {@link QueryChain} in the runtime layer — it never sees
 * `bind`, `unlink`, `flush`, or any other write method.
 */
export interface IndexReader {
  getForward(rel: RelationDefinition, sourceId: string): Promise<string[]>;
  getReverse(rel: RelationDefinition, targetId: string): Promise<string[]>;
}

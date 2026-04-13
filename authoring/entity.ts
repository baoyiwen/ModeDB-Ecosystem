import type {
  RelationDefinition,
  ModelRecord,
  BindStrategy,
  BindOptions,
} from '../common/types.js';
import type { ModelRegistry } from '../common/registry.js';
import type { PathResolver } from '../src/common/PathResolver.js';
import type { ModelStorage } from './storage.js';
import type { RelationIndexer } from './indexer.js';
import type { PersistenceManager } from './persistence-manager.js';
import { RuntimeModel, type RuntimeAvailableRelation } from '../src/runtime/RuntimeModel.js';
import type { QueryChain } from '../src/runtime/query.js';

/** Options for {@link ModelEntity.insert}. */
export interface InsertOptions {
  /**
   * When true, append buffered rows for this model to `.mld` before resolving (crash safety).
   * Default false: rows stay in the write-behind map until the scheduler or `flushAll`.
   */
  sync?: boolean;
}

/**
 * Active Record for a registered model: schema updates, inserts (with storage schema check),
 * and chain queries scoped to the current atlas.
 */
export class ModelEntity extends RuntimeModel {
  /** Write-behind map: `_id` → staged row (shared with {@link PersistenceManager}). */
  private readonly _buffer: Map<string, ModelRecord>;

  constructor(
    name: string,
    registry: ModelRegistry,
    private readonly storage: ModelStorage,
    private readonly indexer: RelationIndexer,
    private readonly paths: PathResolver,
    private readonly persistence: PersistenceManager,
  ) {
    super(name, registry, persistence.getMergedReader(), indexer);
    this._buffer = this.persistence.getOrCreateModelBuffer(name);
  }

  /**
   * Replace persisted field set for this model (Registry + storage schema stay in sync).
   * Accepts `string[]`; duplicates are removed while preserving first-seen order (`Set` iteration).
   */
  updateFields(fields: readonly string[]): this {
    const set = new Set(fields);
    this.registry.updateModelFields(this.name, set);
    this.storage.updateSchema(this.name, set);
    return this;
  }

  /** True while this model has staged rows not yet appended to `.mld`. */
  get isDirty(): boolean {
    return this._buffer.size > 0;
  }

  /**
   * Append staged rows for this model to `.mld` (does not run full {@link AuthoringEngine.flushAll}).
   */
  private async _internalFlush(): Promise<void> {
    await this.persistence.flushModelToDisk(this.name);
  }

  /**
   * Insert one record: only schema-defined fields are kept; staged in the write-behind buffer.
   * Use `{ sync: true }` to append to `.mld` before the promise resolves (reduces loss on crash).
   */
  async insert(data: Record<string, unknown>, options?: InsertOptions): Promise<ModelRecord> {
    const record = await this.persistence.insert(this.name, data);
    if (options?.sync) {
      await this._internalFlush();
    }
    return record;
  }

  /**
   * Start a lazy query chain from this model. Omit `ids` to scan all rows of this model (then narrow with `.where()`).
   */
  override query<M extends Record<string, unknown> = Record<string, unknown>>(
    ids?: readonly string[],
  ): QueryChain<M> {
    return super.query(ids);
  }

  async bind(
    relationForward: string,
    strategy: BindStrategy,
    options: BindOptions = {},
  ): Promise<this> {
    await this.persistence.flushPendingToDisk();
    const rel = this.resolveRelationByForward(relationForward);

    const sourceModels = this.registry.getDescendantsInclusive(rel.source);
    const targetModels = this.registry.getDescendantsInclusive(rel.target);
    const sourceFiles = sourceModels.map((m) => this.paths.modelDataPath(m));
    const targetFiles = targetModels.map((m) => this.paths.modelDataPath(m));

    await this.indexer.bind(rel, strategy, sourceFiles, targetFiles, options);
    return this;
  }

  async unlink(
    relationForward: string,
    pairs: ReadonlyArray<readonly [srcId: string, targetId: string]>,
  ): Promise<this> {
    await this.persistence.flushPendingToDisk();
    const rel = this.resolveRelationByForward(relationForward);
    await this.indexer.unlink(rel, pairs);
    return this;
  }

  private resolveRelationByForward(forwardName: string): RelationDefinition {
    const chain = this.registry.getInheritanceChain(this.name);
    for (const ancestor of chain) {
      const rels = this.registry.getRelationsOf(ancestor);
      for (const rel of rels) {
        if (rel.forward === forwardName) {
          return rel;
        }
      }
    }
    const allRels = this.registry.getRelations();
    const rel = allRels.find((r) => r.forward === forwardName);
    if (!rel) {
      throw new Error(`Relation with forward label "${forwardName}" not found.`);
    }
    return rel;
  }
}

export type AvailableRelation = RuntimeAvailableRelation;

/** @deprecated Use {@link ModelEntity}. */
export const AuthoringModel = ModelEntity;

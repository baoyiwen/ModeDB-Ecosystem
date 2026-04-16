import type {
  RelationDefinition,
  ModelRecord,
  BindStrategy,
  BindOptions,
  ModelRegistry,
  PathResolver,
  ValidationReport,
} from '@mode-db/common';
import type { ModelStorage } from './storage.js';
import type { RelationIndexer } from './indexer.js';
import type { PersistenceManager } from './persistence-manager.js';
import { RuntimeModel, type RuntimeAvailableRelation } from '../src/runtime/RuntimeModel.js';
import type { QueryChain } from '../src/runtime/query.js';
import type { PredicateNode } from '../src/runtime/predicate-tree.js';
import { QueryEngine } from '../src/runtime/query-engine.js';
import { normalizeFieldDefs, type FieldDefsRecord } from '@mode-db/common';
import type { AtlasAuthoringFacilities } from './authoring-facilities.js';

/** Options for {@link ModelEntity.insert}. */
export interface InsertOptions {
  /**
   * When true, append buffered rows for this model to `.mld` before resolving (crash safety).
   * Default false: rows stay in the write-behind map until the scheduler or `flushAll`.
   */
  sync?: boolean;
}

/** Options for {@link ModelEntity.update}. */
export interface UpdateOptions {
  /** When true, flush this model to `.mld` before resolving. */
  sync?: boolean;
}

/** Options for {@link ModelEntity.delete}. */
export interface DeleteOptions {
  /** When true, flush (compact) this model to `.mld` before resolving. */
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
    facilities?: AtlasAuthoringFacilities,
  ) {
    super(
      name,
      registry,
      persistence.getMergedReader(),
      indexer,
      storage.fieldContext,
      facilities?.memoryShadowHydration && facilities.internalVault
        ? { vault: facilities.internalVault }
        : undefined,
      facilities?.smartCache,
    );
    this._buffer = this.persistence.getOrCreateModelBuffer(name);
  }

  /**
   * Replace persisted field set for this model (Registry + storage schema stay in sync).
   *
   * Accepts either:
   * - `string[]`: field names only, no type metadata; duplicates removed.
   * - `Record<string, DataType | FieldTypeDef>`: typed fields, e.g. `{ age: 'Int', name: 'I18N' }`.
   */
  updateFields(fields: readonly string[] | FieldDefsRecord): this {
    if (Array.isArray(fields)) {
      const set = new Set(fields as readonly string[]);
      this.registry.updateModelFields(this.name, set);
      this.storage.updateSchema(this.name, set);
    } else {
      const { fields: set, fieldTypes } = normalizeFieldDefs(fields as FieldDefsRecord);
      this.registry.updateModelFields(this.name, set, fieldTypes);
      this.storage.updateSchema(this.name, set, fieldTypes);
    }
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
   * Batch insert: validates each row independently. Returns a {@link ValidationReport}
   * describing which rows succeeded and which failed (with diagnostic details).
   * Failed rows do not block successful ones.
   */
  async insertMany(
    rows: ReadonlyArray<Record<string, unknown>>,
    options?: InsertOptions,
  ): Promise<ValidationReport<ModelRecord>> {
    const report = await this.persistence.insertMany(this.name, rows);
    if (report.totalSucceeded > 0 && options?.sync) {
      await this._internalFlush();
    }
    return report;
  }

  /**
   * Partial update: merge `partialData` into the existing row identified by `id`.
   * Checks buffer first, falls back to disk. Returns the merged row or `undefined` if not found.
   */
  async update(
    id: string,
    partialData: Record<string, unknown>,
    options?: UpdateOptions,
  ): Promise<ModelRecord | undefined> {
    const merged = await this.persistence.update(this.name, id, partialData);
    if (merged && options?.sync) {
      await this._internalFlush();
    }
    return merged;
  }

  /**
   * Soft-delete: tombstone the row in the buffer (`__deleted: true`), then purge all
   * relation edges originating from this entity (model-independent: target rows are untouched).
   * Queries immediately stop returning it; the physical `.mld` line is removed on the next flush.
   */
  async delete(id: string, options?: DeleteOptions): Promise<boolean> {
    const ok = await this.persistence.delete(this.name, id);
    if (ok) {
      await this.indexer.purgeEntityFromAllRelations(this.name, id, this.registry);
      if (options?.sync) {
        await this._internalFlush();
      }
    }
    return ok;
  }

  /**
   * Batch update: find all rows matching `predicate`, merge `partialData` into each.
   * Returns the array of merged rows.
   */
  async updateWhere(
    predicate: PredicateNode,
    partialData: Record<string, unknown>,
    options?: UpdateOptions,
  ): Promise<ModelRecord[]> {
    const allRows = await this.persistence.getMergedReader().getAll(this.name);
    const hits = allRows.filter((r) => QueryEngine.matches(r, predicate));
    const results: ModelRecord[] = [];
    for (const row of hits) {
      const merged = await this.persistence.update(this.name, row._id, partialData);
      if (merged) {
        results.push(merged);
      }
    }
    if (results.length > 0 && options?.sync) {
      await this._internalFlush();
    }
    return results;
  }

  /**
   * Batch delete: find all rows matching `predicate`, tombstone each and purge their
   * relation edges (model-independent). Returns the number of rows deleted.
   */
  async deleteWhere(predicate: PredicateNode, options?: DeleteOptions): Promise<number> {
    const allRows = await this.persistence.getMergedReader().getAll(this.name);
    const hits = allRows.filter((r) => QueryEngine.matches(r, predicate));
    let count = 0;
    for (const row of hits) {
      const ok = await this.persistence.delete(this.name, row._id);
      if (ok) {
        await this.indexer.purgeEntityFromAllRelations(this.name, row._id, this.registry);
        count++;
      }
    }
    if (count > 0 && options?.sync) {
      await this._internalFlush();
    }
    return count;
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

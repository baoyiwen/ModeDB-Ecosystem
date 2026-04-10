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

/**
 * Active Record for a registered model: schema updates, inserts (with storage schema check),
 * and chain queries scoped to the current atlas.
 */
export class ModelEntity extends RuntimeModel {
  constructor(
    name: string,
    registry: ModelRegistry,
    private readonly storage: ModelStorage,
    private readonly indexer: RelationIndexer,
    private readonly paths: PathResolver,
    private readonly persistence: PersistenceManager,
  ) {
    super(name, registry, persistence.getMergedReader(), indexer);
  }

  /**
   * Replace persisted field set for this model (Registry + storage schema stay in sync).
   */
  updateFields(fields: readonly string[]): this {
    const set = new Set(fields);
    this.registry.updateModelFields(this.name, set);
    this.storage.updateSchema(this.name, set);
    return this;
  }

  /**
   * Insert one record: only schema-defined fields are kept; staged in the persistence buffer
   * and flushed to `.mld` shortly (or on {@link AuthoringEngine.flushAll} / process exit).
   */
  async insert(data: Record<string, unknown>): Promise<ModelRecord> {
    return this.persistence.insert(this.name, data);
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

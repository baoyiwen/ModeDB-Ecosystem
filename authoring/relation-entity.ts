import type {
  RelationDefinition,
  RelationLogic,
  MatchPredicate,
  RelationStats,
  RelationBindOptions,
} from '../common/types.js';
import type { ModelRegistry } from '../common/registry.js';
import type { PathResolver } from '../src/common/PathResolver.js';
import type { RelationIndexer } from './indexer.js';
import { RuntimeRelation } from '../src/runtime/RuntimeRelation.js';

/**
 * Active Record for a relation protocol: logic updates and explicit binding strategies.
 *
 * Index edges are always applied through {@link RelationIndexer.writePairIndex} (atomic fwd+rev).
 */
export class RelationEntity extends RuntimeRelation {
  constructor(
    def: RelationDefinition,
    private readonly registry: ModelRegistry,
    private readonly indexer: RelationIndexer,
    private readonly paths: PathResolver,
  ) {
    super(def);
  }

  updateLogic(logic: RelationLogic, matchOn?: MatchPredicate): this {
    this.registry.updateRelationLogic(this.getDefinition().forward, logic, matchOn);
    return this;
  }

  /**
   * Build index edges using `GLOBAL`, `PROTOCOL`, `CONDITIONAL`, or `MANUAL`.
   * Each link is written via {@link RelationIndexer.writePairIndex}.
   */
  async bind(options: RelationBindOptions = {}): Promise<this> {
    const strategy = options.strategy ?? 'PROTOCOL';
    const def = this.getDefinition();

    const sourceModels = this.registry.getDescendantsInclusive(def.source);
    const targetModels = this.registry.getDescendantsInclusive(def.target);
    const sourceFiles = sourceModels.map((m) => this.paths.modelDataPath(m));
    const targetFiles = targetModels.map((m) => this.paths.modelDataPath(m));

    await this.indexer.bind(def, strategy, sourceFiles, targetFiles, {
      pairs: options.pairs,
      condition: options.condition,
    });
    return this;
  }

  async unlink(pairs: ReadonlyArray<readonly [srcId: string, targetId: string]>): Promise<this> {
    await this.indexer.unlink(this.getDefinition(), pairs);
    return this;
  }

  async getStats(): Promise<RelationStats> {
    return this.indexer.getStats(this.getDefinition());
  }

  async clear(): Promise<this> {
    await this.indexer.clearIndex(this.getDefinition());
    return this;
  }
}

/** @deprecated Use {@link RelationEntity}. */
export const AuthoringRelation = RelationEntity;

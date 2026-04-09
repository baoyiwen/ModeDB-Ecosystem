import type {
  ModelDefinition,
  RelationDefinition,
  RelationLogic,
  MatchPredicate,
  ModelRecord,
  BindStrategy,
  BindOptions,
} from '../common/types.js';
import { writeFile } from 'node:fs/promises';
import type { ModelRegistry } from '../common/registry.js';
import { PathResolver } from '../src/common/PathResolver.js';
import { resolveModelDBStorageRoot } from '../common/storage-root-config.js';
import { serializeAtlasManifestFile } from '../common/atlas-manifest.js';
import { ModelStorage } from './storage.js';
import { RelationIndexer } from './indexer.js';
import { AtlasRegistry } from './atlas-registry.js';
import { ModelEntity } from './entity.js';
import { RelationEntity } from './relation-entity.js';
import { QueryChain } from '../src/runtime/query.js';
import type { RuntimeContext } from '../src/runtime/context.js';

export interface AuthoringEngineOptions {
  /** Atlas name; data lives under `<storageRoot>/<atlas>/`. */
  atlas: string;
  /** Storage root directory. Defaults to shared `resolveModelDBStorageRoot()` (see `storage-root-config.ts`). */
  storageRoot?: string;
  /** Advanced: inject a pre-built resolver (must match `atlas`). */
  paths?: PathResolver;
  registry?: ModelRegistry;
  storage?: ModelStorage;
  indexer?: RelationIndexer;
}

/**
 * Authoring-side engine: all model/relation I/O is scoped to one atlas directory tree.
 *
 * On construction, `PathResolver.ensureAtlasLayoutSync()` creates `models/` and `relations/`
 * and writes an initial `atlas-manifest.json` when missing.
 */
export class AuthoringEngine {
  readonly registry: ModelRegistry;
  readonly storage: ModelStorage;
  readonly indexer: RelationIndexer;
  readonly paths: PathResolver;

  constructor(options: AuthoringEngineOptions) {
    const paths =
      options.paths ??
      new PathResolver(options.storageRoot ?? resolveModelDBStorageRoot(), options.atlas);

    if (options.paths && options.paths.atlasName !== options.atlas) {
      throw new Error(
        `Atlas mismatch: paths.atlasName "${options.paths.atlasName}" !== options.atlas "${options.atlas}".`,
      );
    }

    if (
      (options.storage !== undefined || options.indexer !== undefined) &&
      options.paths === undefined
    ) {
      throw new Error('Custom storage or indexer requires options.paths (PathResolver).');
    }

    paths.ensureAtlasLayoutSync();

    this.paths = paths;
    this.storage = options.storage ?? new ModelStorage(paths);
    this.indexer = options.indexer ?? new RelationIndexer(paths);
    this.registry =
      options.registry !== undefined
        ? options.registry
        : new AtlasRegistry(this.storage, this.indexer, this.paths);
  }

  model(name: string): ModelEntity {
    const def = this.registry.getModel(name);
    if (!def) {
      throw new Error(`Model "${name}" is not registered.`);
    }
    return new ModelEntity(name, this.registry, this.storage, this.indexer, this.paths);
  }

  relation(label: string): RelationEntity {
    const def = this.registry.findRelationByLabel(label);
    if (!def) {
      throw new Error(`Relation "${label}" is not registered (checked both forward and reverse).`);
    }
    return new RelationEntity(def, this.registry, this.indexer, this.paths);
  }

  /**
   * Read-only runtime view of this atlas (registry + readers + atlas id).
   */
  createRuntime(): RuntimeContext {
    return {
      registry: this.registry,
      dataReader: this.storage,
      indexReader: this.indexer,
      atlas: this.paths.atlasName,
    };
  }

  registerModel(
    name: string,
    fields?: ReadonlySet<string>,
    parentId?: string | null,
  ): ModelDefinition {
    const resolvedFields = fields ?? new Set<string>();
    const definition = this.registry.registerModel(name, resolvedFields, parentId ?? null);
    this.storage.registerSchema({ name, fields: resolvedFields });
    return definition;
  }

  registerRelation(
    source: string,
    target: string,
    forward: string,
    reverse: string,
    logic?: RelationLogic | null,
    matchOn?: MatchPredicate | null,
  ): RelationDefinition {
    return this.registry.registerRelation(
      source,
      target,
      forward,
      reverse,
      logic ?? null,
      matchOn ?? null,
    );
  }

  updateModelFields(name: string, fields: ReadonlySet<string>): void {
    this.registry.updateModelFields(name, fields);
    this.storage.updateSchema(name, fields);
  }

  updateRelationLogic(forwardName: string, logic: RelationLogic, matchOn?: MatchPredicate): void {
    this.registry.updateRelationLogic(forwardName, logic, matchOn);
  }

  quickLink(source: string, target: string, forward: string, reverse: string): RelationDefinition {
    if (!this.registry.getModel(source)) {
      this.registerModel(source);
    }
    if (!this.registry.getModel(target)) {
      this.registerModel(target);
    }
    return this.registerRelation(source, target, forward, reverse);
  }

  async insert(modelName: string, data: Record<string, unknown>): Promise<ModelRecord> {
    return this.storage.insert(modelName, data);
  }

  async bind(
    forwardName: string,
    strategy: BindStrategy,
    options: BindOptions = {},
  ): Promise<void> {
    const rel = this.registry.getRelations().find((r) => r.forward === forwardName);
    if (!rel) {
      throw new Error(`Relation with forward label "${forwardName}" not found.`);
    }

    const sourceModels = this.registry.getDescendantsInclusive(rel.source);
    const targetModels = this.registry.getDescendantsInclusive(rel.target);
    const sourceFiles = sourceModels.map((m) => this.paths.modelDataPath(m));
    const targetFiles = targetModels.map((m) => this.paths.modelDataPath(m));

    await this.indexer.bind(rel, strategy, sourceFiles, targetFiles, options);
  }

  async unlink(
    forwardName: string,
    pairs: ReadonlyArray<readonly [srcId: string, targetId: string]>,
  ): Promise<void> {
    const rel = this.registry.getRelations().find((r) => r.forward === forwardName);
    if (!rel) {
      throw new Error(`Relation with forward label "${forwardName}" not found.`);
    }
    await this.indexer.unlink(rel, pairs);
  }

  query(modelName: string, ids: string[]): QueryChain {
    return new QueryChain(this.registry, this.indexer, this.storage, modelName, {
      kind: 'ids',
      ids,
    });
  }

  /**
   * Write `atlas-manifest.json` (version, models, relations, checksum) for runtime `connect()`.
   */
  async writeAtlasManifest(): Promise<void> {
    const body = serializeAtlasManifestFile(this.registry, this.paths.atlasName);
    await writeFile(this.paths.manifestFilePath(), body, 'utf-8');
  }

  async flushAll(): Promise<void> {
    await this.indexer.flushAll();
    await this.writeAtlasManifest();
  }
}

/** @deprecated Use the name {@link AuthoringEngine}. */
export const Engine = AuthoringEngine;

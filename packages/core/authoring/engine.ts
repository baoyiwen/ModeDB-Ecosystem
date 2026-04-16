import { existsSync } from 'node:fs';
import {
  AtlasManifestError,
  DiagnosticCenter,
  EngineLogger,
  InternalVault,
  ModelRegistry,
  PathResolver,
  SmartCache,
  deriveAtlasVaultSecretFromConnectToken,
  normalizeFieldDefs,
  parseAtlasManifestJson,
  resolveModelDBStorageRoot,
  serializeAtlasManifestFile,
  type BindOptions,
  type BindStrategy,
  type Diagnostic,
  RegistryError,
  type FieldDefsRecord,
  type FieldTypeDef,
  type MatchPredicate,
  type ModelDefinition,
  type ModelRecord,
  type RelationDefinition,
  type RelationLogic,
} from '@mode-db/common';
import { ModelStorage } from './storage.js';
import { RelationIndexer } from './indexer.js';
import { AtlasRegistry } from './atlas-registry.js';
import { PersistenceManager, registerAuthoringShutdownTask } from './persistence-manager.js';
import type { InsertOptions, UpdateOptions, DeleteOptions, ModelEntity } from './entity.js';
import type { RelationEntity } from './relation-entity.js';
import { QueryChain } from '../src/runtime/query.js';
import { QueryEngine } from '../src/runtime/query-engine.js';
import type { PredicateNode } from '../src/runtime/predicate-tree.js';
import type { RuntimeContext } from '../src/runtime/context.js';
import { AtlasSingleVault } from './atlas-single-vault.js';

function modelDefinitionToFieldDefsRecord(m: ModelDefinition): FieldDefsRecord {
  const out: FieldDefsRecord = {};
  for (const f of m.fields) {
    const ft = m.fieldTypes.get(f);
    if (!ft) {
      out[f] = 'String';
      continue;
    }
    out[f] = {
      type: ft.type,
      ...(ft.required !== undefined ? { required: ft.required } : {}),
      ...(ft.unit !== undefined ? { unit: ft.unit } : {}),
      ...(ft.default !== undefined ? { default: ft.default } : {}),
    };
  }
  return out;
}

function hydrateAuthoringFromManifest(
  registry: ModelRegistry,
  storage: ModelStorage,
  raw: string,
  atlas: string,
): void {
  const loaded = parseAtlasManifestJson(raw, atlas);
  for (const def of loaded.getModelDefinitions()) {
    const fields = new Set(def.fields);
    const ft = new Map(def.fieldTypes);
    registry.registerModel(def.name, fields, def.parentId, ft);
    storage.registerSchema({ name: def.name, fields, fieldTypes: ft });
  }
  for (const rel of loaded.getRelations()) {
    registry.registerRelation(
      rel.source,
      rel.target,
      rel.forward,
      rel.reverse,
      rel.logic,
      rel.matchOn,
    );
  }
}

export interface AuthoringEngineOptions {
  /** Atlas name; data lives under `<storageRoot>/<atlas>/`. */
  atlas: string;
  /** Storage root directory. Defaults to shared `resolveModelDBStorageRoot()` (see `storage-root-config.ts`). */
  storageRoot?: string;
  /** Default locale for I18N field auto-wrap and query resolution. */
  currentLocale?: string;
  /** Advanced: inject a pre-built resolver (must match `atlas`). */
  paths?: PathResolver;
  registry?: ModelRegistry;
  /**
   * When true, `.mld` body lines are obfuscated (see **`@mode-db/common`** shadow codec); reads auto-detect.
   */
  shadowDiskEncoding?: boolean;
  /**
   * When true, {@link HydratedEntity.getData} exposes `m_addr_*` vault pointers for user fields;
   * {@link HydratedEntity.getValue} resolves real payloads. Requires default {@link AtlasRegistry}.
   */
  memoryShadowHydration?: boolean;
  /** Enable query fingerprint cache; entries invalidate when any dependent model is written. */
  enableSmartCache?: boolean;
  /**
   * When set, staging **≥ N** rows for a model triggers **`flushModelToDisk`** for that model
   * (reduces peak memory before the 200ms scheduler runs).
   */
  bufferFlushRowThreshold?: number;
  /** Rolling file log under `<atlas>/logs/system.log` and mirror {@link DiagnosticCenter} output. */
  engineLogger?:
    | boolean
    | {
        maxFileBytes?: number;
        maxRotatedFiles?: number;
        logEachDiskOp?: boolean;
        logEachBinaryUnwrap?: boolean;
      };
  /**
   * Same value as the wire **`connectToken`**; used with {@link deriveAtlasVaultSecretFromConnectToken}
   * to open **`${storageRoot}/${atlas}/atlas.mld`**. Omit to use **`process.env.MODEL_DB_CONNECT_TOKEN`**.
   */
  connectToken?: string;
}

/**
 * Authoring-side engine: all model/relation I/O is scoped to one atlas directory tree.
 *
 * On construction, only the single-file vault **`${storageRoot}/${atlas}/atlas.mld`** is used
 * (encrypted catalog; no `models/`, `relations/`, or standalone `atlas-manifest.json`).
 *
 * **Persistence:** `insert` stages rows in a per-model write-behind `Map<_id, row>`; a **200ms** scheduler
 * appends to `.mld` when buffers are non-empty; `beforeExit` and `SIGINT`/`SIGTERM` best-effort run
 * {@link AuthoringEngine.flushAll}. Same-process `createRuntime()` uses the merged disk+buffer reader.
 * Use `{ sync: true }` on {@link ModelEntity.insert} when a row must hit `.mld` before the promise resolves.
 */
export class AuthoringEngine {
  readonly registry: ModelRegistry;
  readonly storage: ModelStorage;
  readonly indexer: RelationIndexer;
  readonly paths: PathResolver;
  readonly persistence: PersistenceManager;
  currentLocale: string | undefined;
  /** Present when {@link AuthoringEngineOptions.memoryShadowHydration} is enabled. */
  readonly internalVault: InternalVault | undefined;
  /** In-memory vault for the single-file atlas layout. */
  readonly atlasVault: AtlasSingleVault | undefined;
  private readonly vaultSecret: string | undefined;
  private readonly smartCacheRef: SmartCache | undefined;
  private readonly memoryShadowHydration: boolean;
  private readonly _autoFlushHandle: ReturnType<typeof setInterval>;

  constructor(options: AuthoringEngineOptions) {
    const paths =
      options.paths ??
      new PathResolver(options.storageRoot ?? resolveModelDBStorageRoot(), options.atlas);

    if (options.paths && options.paths.atlasName !== options.atlas) {
      throw new Error(
        `Atlas mismatch: paths.atlasName "${options.paths.atlasName}" !== options.atlas "${options.atlas}".`,
      );
    }

    const connectTok = (
      options.connectToken ??
      (typeof process !== 'undefined' && process.env.MODEL_DB_CONNECT_TOKEN
        ? process.env.MODEL_DB_CONNECT_TOKEN
        : '')
    ).trim();
    if (!connectTok) {
      throw new Error(
        'AuthoringEngine requires connectToken or process.env.MODEL_DB_CONNECT_TOKEN (derives the atlas vault key).',
      );
    }
    const resolvedVaultSecret = deriveAtlasVaultSecretFromConnectToken(connectTok);

    paths.ensureAtlasVaultLayoutSync();
    const vaultPath = paths.atlasSingleVaultPath();
    const atlasVault = new AtlasSingleVault();
    const fileExisted = existsSync(vaultPath);
    const loaded = atlasVault.loadSync(vaultPath, resolvedVaultSecret);
    if (fileExisted && !loaded) {
      throw new AtlasManifestError(
        `Cannot open single-file vault at "${vaultPath}": decrypt failed, file truncated, or wrong connectToken (see diagnostics E3002).`,
      );
    }
    if (!fileExisted) {
      atlasVault.set(
        AtlasSingleVault.manifestKey,
        serializeAtlasManifestFile(new ModelRegistry(), paths.atlasName),
      );
      atlasVault.saveSync(vaultPath, resolvedVaultSecret);
    }

    this.paths = paths;
    this.atlasVault = atlasVault;
    this.vaultSecret = resolvedVaultSecret;
    this.currentLocale = options.currentLocale;
    this.memoryShadowHydration = options.memoryShadowHydration ?? false;
    this.internalVault = this.memoryShadowHydration ? new InternalVault() : undefined;
    this.smartCacheRef = options.enableSmartCache ? new SmartCache() : undefined;

    const vaultOpts = { vault: atlasVault, vaultSecret: resolvedVaultSecret };

    this.storage = new ModelStorage(paths, vaultOpts);
    this.storage.locale = this.currentLocale;
    this.storage.shadowDiskEncoding = false;
    this.persistence = new PersistenceManager(
      this.storage,
      this.smartCacheRef,
      options.bufferFlushRowThreshold,
    );
    this.indexer = new RelationIndexer(paths, {
      vault: atlasVault,
      vaultSecret: vaultOpts.vaultSecret,
      loadModelRecords: (m) => this.persistence.getMergedReader().getAll(m),
    });
    this.registry =
      options.registry !== undefined
        ? options.registry
        : new AtlasRegistry(this.storage, this.indexer, this.paths, this.persistence, {
            internalVault: this.internalVault,
            memoryShadowHydration: this.memoryShadowHydration,
            smartCache: this.smartCacheRef,
          });

    if (options.registry === undefined) {
      const raw = atlasVault.get(AtlasSingleVault.manifestKey);
      if (raw) {
        hydrateAuthoringFromManifest(this.registry, this.storage, raw, paths.atlasName);
      }
    }

    if (options.engineLogger) {
      const eo = typeof options.engineLogger === 'object' ? options.engineLogger : {};
      EngineLogger.instance.configure({
        atlasRoot: paths.atlasRoot(),
        maxFileBytes: eo.maxFileBytes,
        maxRotatedFiles: eo.maxRotatedFiles,
        logEachDiskOp: eo.logEachDiskOp,
        logEachBinaryUnwrap: eo.logEachBinaryUnwrap,
      });
      EngineLogger.instance.attachDiagnosticBridge((fn: (d: Diagnostic) => void) =>
        DiagnosticCenter.onDiagnostic(fn),
      );
    }

    registerAuthoringShutdownTask(() => this.flushAll());

    this._autoFlushHandle = setInterval(() => {
      if (this.persistence.hasBufferedRows()) {
        void this.persistence.flushPendingToDisk();
      }
    }, 200);
    if (typeof this._autoFlushHandle.unref === 'function') {
      this._autoFlushHandle.unref();
    }

    process.once('beforeExit', () => {
      void this.flushAll();
    });
  }

  model(name: string): ModelEntity {
    if (!(this.registry instanceof AtlasRegistry)) {
      throw new Error(
        'AuthoringEngine.model() requires the default AtlasRegistry (omit options.registry).',
      );
    }
    return this.registry.model(name);
  }

  relation(label: string): RelationEntity {
    if (!(this.registry instanceof AtlasRegistry)) {
      throw new Error(
        'AuthoringEngine.relation() requires the default AtlasRegistry (omit options.registry).',
      );
    }
    return this.registry.relation(label);
  }

  /**
   * Read-only runtime view of this atlas (registry + readers + atlas id).
   */
  createRuntime(): RuntimeContext {
    return {
      registry: this.registry,
      dataReader: this.persistence.getMergedReader(),
      indexReader: this.indexer,
      atlas: this.paths.atlasName,
      fieldContext: this._buildFieldContext(),
    };
  }

  /** Build a FieldMatchContext from the current registry for I18N-aware queries. */
  private _buildFieldContext():
    | { locale?: string; fieldTypes?: ReadonlyMap<string, FieldTypeDef> }
    | undefined {
    if (!this.currentLocale) {
      return undefined;
    }
    return { locale: this.currentLocale };
  }

  registerModel(
    name: string,
    fields?: ReadonlySet<string> | FieldDefsRecord,
    parentId?: string | null,
  ): ModelDefinition {
    if (fields && !(fields instanceof Set) && typeof fields === 'object') {
      const { fields: set, fieldTypes } = normalizeFieldDefs(fields as FieldDefsRecord);
      const definition = this.registry.registerModel(name, set, parentId ?? null, fieldTypes);
      this.storage.registerSchema({ name, fields: set, fieldTypes });
      return definition;
    }
    const resolvedFields = (fields as ReadonlySet<string> | undefined) ?? new Set<string>();
    const definition = this.registry.registerModel(name, resolvedFields, parentId ?? null);
    this.storage.registerSchema({ name, fields: resolvedFields, fieldTypes: new Map() });
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

  /** Replace model fields; accepts `string[]` (names only) or typed `Record<string, DataType | FieldTypeDef>`. */
  updateModelFields(name: string, fields: readonly string[] | FieldDefsRecord): void {
    if (Array.isArray(fields)) {
      const set = new Set(fields as readonly string[]);
      this.registry.updateModelFields(name, set);
      this.storage.updateSchema(name, set);
    } else {
      const { fields: set, fieldTypes } = normalizeFieldDefs(fields as FieldDefsRecord);
      this.registry.updateModelFields(name, set, fieldTypes);
      this.storage.updateSchema(name, set, fieldTypes);
    }
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

  async insert(
    modelName: string,
    data: Record<string, unknown>,
    options?: InsertOptions,
  ): Promise<ModelRecord> {
    const record = await this.persistence.insert(modelName, data);
    if (options?.sync) {
      await this.persistence.flushModelToDisk(modelName);
    }
    return record;
  }

  /**
   * Partial update by `_id`. Merges `partialData` into the existing row (buffer → disk fallback).
   * Returns the merged row, or `undefined` when the id does not exist.
   */
  async update(
    modelName: string,
    id: string,
    partialData: Record<string, unknown>,
    options?: UpdateOptions,
  ): Promise<ModelRecord | undefined> {
    const merged = await this.persistence.update(modelName, id, partialData);
    if (merged && options?.sync) {
      await this.persistence.flushModelToDisk(modelName);
    }
    return merged;
  }

  /**
   * Soft-delete by `_id`. Tombstones the row and purges all relation edges originating
   * from this entity (model-independent: related model rows are untouched).
   * Physical removal from `.mld` happens on the next flush cycle.
   */
  async delete(modelName: string, id: string, options?: DeleteOptions): Promise<boolean> {
    const ok = await this.persistence.delete(modelName, id);
    if (ok) {
      await this.indexer.purgeEntityFromAllRelations(modelName, id, this.registry);
      if (options?.sync) {
        await this.persistence.flushModelToDisk(modelName);
      }
    }
    return ok;
  }

  /**
   * Batch update: find all rows of `modelName` matching `predicate`, merge `partialData` into each.
   */
  async updateWhere(
    modelName: string,
    predicate: PredicateNode,
    partialData: Record<string, unknown>,
    options?: UpdateOptions,
  ): Promise<ModelRecord[]> {
    const allRows = await this.persistence.getMergedReader().getAll(modelName);
    const hits = allRows.filter((r) => QueryEngine.matches(r, predicate));
    const results: ModelRecord[] = [];
    for (const row of hits) {
      const merged = await this.persistence.update(modelName, row._id, partialData);
      if (merged) {
        results.push(merged);
      }
    }
    if (results.length > 0 && options?.sync) {
      await this.persistence.flushModelToDisk(modelName);
    }
    return results;
  }

  /**
   * Batch delete: find all rows of `modelName` matching `predicate`, tombstone each
   * and purge their relation edges (model-independent). Returns the count of deleted rows.
   */
  async deleteWhere(
    modelName: string,
    predicate: PredicateNode,
    options?: DeleteOptions,
  ): Promise<number> {
    const allRows = await this.persistence.getMergedReader().getAll(modelName);
    const hits = allRows.filter((r) => QueryEngine.matches(r, predicate));
    let count = 0;
    for (const row of hits) {
      const ok = await this.persistence.delete(modelName, row._id);
      if (ok) {
        await this.indexer.purgeEntityFromAllRelations(modelName, row._id, this.registry);
        count++;
      }
    }
    if (count > 0 && options?.sync) {
      await this.persistence.flushModelToDisk(modelName);
    }
    return count;
  }

  async bind(
    forwardName: string,
    strategy: BindStrategy,
    options: BindOptions = {},
  ): Promise<void> {
    await this.persistence.flushPendingToDisk();
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

  /**
   * Non-destructive schema merge: new fields may be added; existing fields cannot be removed.
   * Changing **`required`** from true→false on an existing field is rejected; type changes are rejected.
   */
  alterModel(name: string, newSchema: FieldDefsRecord): void {
    const existing = this.registry.getModel(name);
    if (!existing) {
      throw new RegistryError(`alterModel: model "${name}" is not registered.`);
    }
    const { fields: newFields, fieldTypes: newFt } = normalizeFieldDefs(newSchema);
    for (const f of existing.fields) {
      if (!newFields.has(f)) {
        throw new RegistryError(`alterModel: cannot remove field "${f}" from model "${name}".`);
      }
    }
    const mergedTypes = new Map(existing.fieldTypes);
    for (const [k, neu] of newFt) {
      const old = mergedTypes.get(k);
      if (old === undefined) {
        mergedTypes.set(k, neu);
        continue;
      }
      if (old.type !== neu.type) {
        throw new RegistryError(
          `alterModel: cannot change type of field "${k}" on model "${name}".`,
        );
      }
      if (old.required && !neu.required) {
        throw new RegistryError(
          `alterModel: cannot relax required on field "${k}" on model "${name}" (non-destructive policy).`,
        );
      }
      mergedTypes.set(k, neu);
    }
    this.registry.updateModelFields(name, newFields, mergedTypes);
    this.storage.updateSchema(name, newFields, mergedTypes);
    EngineLogger.instance.info(
      `[META] Model '${name}' schema altered (non-destructive field merge).`,
      undefined,
      'Authoring',
    );
  }

  /**
   * Incremental schema update for Model Designer: merges **`patch`** onto the live definition,
   * then applies the same non-destructive rules as {@link alterModel} (no field removal / type change).
   */
  alterModelPatch(name: string, patch: FieldDefsRecord): void {
    const existing = this.registry.getModel(name);
    if (!existing) {
      throw new RegistryError(`alterModelPatch: model "${name}" is not registered.`);
    }
    const merged: FieldDefsRecord = { ...modelDefinitionToFieldDefsRecord(existing), ...patch };
    this.alterModel(name, merged);
  }

  /**
   * Remove a relation: clears vault **`r:*`** / disk index and unregisters topology.
   */
  async dropRelation(relationName: string): Promise<void> {
    await this.persistence.flushPendingToDisk();
    const rel = this.registry.findRelationByLabel(relationName);
    if (!rel) {
      throw new RegistryError(`dropRelation: relation "${relationName}" not found.`);
    }
    await this.indexer.dropRelationIndex(rel);
    this.registry.unregisterRelation(rel);
    this.smartCacheRef?.invalidateModel(rel.source);
    this.smartCacheRef?.invalidateModel(rel.target);
    await this.flushAll();
    EngineLogger.instance.info(
      `[META] Relation '${rel.forward}' (${rel.source}→${rel.target}) dropped. Index removed.`,
      undefined,
      'Authoring',
    );
  }

  /**
   * **Meta-CRUD (logical drop)**: removes relations touching the model, then unregisters it from
   * **`ModelRegistry` / `AtlasRegistry`** and in-memory handles (**`evictModelHandle`**), clears buffers
   * and schema registration, and rewrites the manifest so **cold readers no longer see the model**.
   *
   * **Physical payloads are intentionally left in place**: Vault **`m:<name>`** JSONL and split-file
   * **`models/<name>.mld`** are **not** renamed or relocated, deferring
   * compaction / freelist work to a later storage release. Re-using the same model name before a
   * dedicated compact tool runs can merge with stale on-disk rows — avoid in production.
   */
  async dropModel(modelName: string): Promise<void> {
    if (!this.registry.getModel(modelName)) {
      throw new RegistryError(`dropModel: model "${modelName}" is not registered.`);
    }
    await this.persistence.flushPendingToDisk();
    const touching = this.registry.getRelationsOf(modelName);
    for (const rel of [...touching]) {
      await this.indexer.dropRelationIndex(rel);
      this.registry.unregisterRelation(rel);
    }
    this.persistence.clearModelBuffer(modelName);
    this.storage.unregisterSchema(modelName);
    this.registry.unregisterModel(modelName);
    if (this.registry instanceof AtlasRegistry) {
      this.registry.evictModelHandle(modelName);
    }
    this.smartCacheRef?.invalidateModel(modelName);
    await this.flushAll();
    EngineLogger.instance.info(
      `[META] Model '${modelName}' dropped (logical): relations cleared; registry + mapping retired; physical model payload retained on disk.`,
      undefined,
      'Authoring',
    );
  }

  async unlink(
    forwardName: string,
    pairs: ReadonlyArray<readonly [srcId: string, targetId: string]>,
  ): Promise<void> {
    await this.persistence.flushPendingToDisk();
    const rel = this.registry.getRelations().find((r) => r.forward === forwardName);
    if (!rel) {
      throw new Error(`Relation with forward label "${forwardName}" not found.`);
    }
    await this.indexer.unlink(rel, pairs);
  }

  query(modelName: string, ids: string[]): QueryChain {
    return new QueryChain(
      this.registry,
      this.indexer,
      this.persistence.getMergedReader(),
      modelName,
      {
        kind: 'ids',
        ids,
      },
      this._buildFieldContext(),
      this.memoryShadowHydration && this.internalVault ? { vault: this.internalVault } : undefined,
      this.smartCacheRef,
    );
  }

  /**
   * Write `atlas-manifest.json` (version, models, relations, checksum) for runtime `connect()`.
   */
  async writeAtlasManifest(): Promise<void> {
    const body = serializeAtlasManifestFile(this.registry, this.paths.atlasName);
    if (!this.atlasVault || !this.vaultSecret) {
      throw new Error('writeAtlasManifest: internal vault is missing.');
    }
    this.atlasVault.set(AtlasSingleVault.manifestKey, body);
    this.atlasVault.saveSync(this.paths.atlasSingleVaultPath(), this.vaultSecret);
  }

  /**
   * Optional **forced** persistence: flushes buffered model rows, relation indices, and manifest.
   * Normal authoring flows auto-flush on an idle timer and on process shutdown; call this only when
   * you need the lowest latency guarantee that data is on disk before another process reads files
   * (e.g. cold `ModelDBClient.connect` to the same atlas).
   */
  async flushAll(): Promise<void> {
    await this.persistence.flushPendingToDisk();
    await this.indexer.flushAll();
    await this.writeAtlasManifest();
  }
}

/** @deprecated Use the name {@link AuthoringEngine}. */
export const Engine = AuthoringEngine;

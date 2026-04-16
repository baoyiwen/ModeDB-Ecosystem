import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { AtlasIsolationError } from './errors.js';
import { assertFlatGraphSegment, assertRelationIndexKey } from './atlas-segments.js';

/** Optional layout: workspace-level single vault file `${storageRoot}/${atlasName}.mld`. */
export interface PathResolverOptions {
  readonly workspaceFlatVault?: boolean;
}
import { resolveModelDBStorageRoot } from './storage-root-config.js';
import { ModelRegistry } from './registry.js';
import { serializeAtlasManifestFile } from './atlas-manifest.js';

/**
 * Resolves all filesystem paths for one atlas under STORAGE_ROOT.
 *
 * Layout (relative to storage root):
 * - `/${atlasName}/models/${modelName}.mld`
 * - `/${atlasName}/relations/${relationName}.rid`
 * - `/${atlasName}/atlas-manifest.json`
 *
 * STORAGE_ROOT defaults from {@link resolveModelDBStorageRoot} (programmatic config,
 * then `STORAGE_ROOT` / `MODEL_DB_STORAGE_ROOT` env, then `<cwd>/data`).
 */
export class PathResolver {
  readonly storageRoot: string;
  readonly atlasName: string;
  private readonly atlasRootResolved: string;
  private readonly modelsRootResolved: string;
  private readonly relationsRootResolved: string;
  private readonly workspaceFlatVault: boolean;

  /**
   * Absolute path to **`${workspace}/${logicalDb}.mld`** (single-file vault at workspace root).
   */
  static workspaceFlatVaultPath(storageRoot: string, logicalDbName: string): string {
    assertFlatGraphSegment(logicalDbName, 'logical db name');
    const root = resolve(storageRoot);
    return resolve(join(root, `${logicalDbName}.mld`));
  }

  /**
   * @param storageRoot - Absolute or resolvable root; pass {@link PathResolver.resolveDefaultStorageRoot} result or a concrete path.
   * @param atlasName - Atlas directory name under the storage root.
   */
  constructor(storageRoot: string, atlasName: string, options?: PathResolverOptions) {
    assertFlatGraphSegment(atlasName, 'atlas name');
    this.storageRoot = resolve(storageRoot);
    this.atlasName = atlasName;
    this.workspaceFlatVault = options?.workspaceFlatVault === true;
    if (this.workspaceFlatVault) {
      this.atlasRootResolved = this.storageRoot;
      this.modelsRootResolved = resolve(
        join(this.storageRoot, '.modeldb-scratch', atlasName, 'models'),
      );
      this.relationsRootResolved = resolve(
        join(this.storageRoot, '.modeldb-scratch', atlasName, 'relations'),
      );
    } else {
      this.atlasRootResolved = resolve(this.storageRoot, atlasName);
      this.modelsRootResolved = resolve(join(this.atlasRootResolved, 'models'));
      this.relationsRootResolved = resolve(join(this.atlasRootResolved, 'relations'));
    }
  }

  /** Default storage root for new resolvers (env + config aware). */
  static resolveDefaultStorageRoot(): string {
    return resolveModelDBStorageRoot();
  }

  /** Absolute `${STORAGE_ROOT}/${atlasName}`. */
  atlasRoot(): string {
    return this.atlasRootResolved;
  }

  /** Absolute `${STORAGE_ROOT}/${atlasName}/models`. */
  modelsDir(): string {
    return this.modelsRootResolved;
  }

  /** Absolute `${STORAGE_ROOT}/${atlasName}/relations`. */
  relationsDir(): string {
    return this.relationsRootResolved;
  }

  /** `<atlas>/atlas-manifest.json` (split-file layout; vault mode stores manifest inside {@link atlasSingleVaultPath}). */
  manifestFilePath(): string {
    const filePath = resolve(join(this.atlasRootResolved, 'atlas-manifest.json'));
    this.assertResolvedUnderAtlasRoot(filePath);
    return filePath;
  }

  /**
   * Single-file atlas vault: encrypted catalog of models, relations, and manifest.
   * When used, do not create `models/`, `relations/`, or `atlas-manifest.json` on disk.
   */
  atlasSingleVaultPath(): string {
    const filePath = this.workspaceFlatVault
      ? PathResolver.workspaceFlatVaultPath(this.storageRoot, this.atlasName)
      : resolve(join(this.atlasRootResolved, 'atlas.mld'));
    this.assertResolvedUnderAtlasRoot(filePath);
    return filePath;
  }

  /**
   * Model JSONL: `${atlas}/models/${modelName}.mld`
   */
  modelFilePath(modelName: string): string {
    assertFlatGraphSegment(modelName, 'model name');
    const filePath = resolve(join(this.modelsRootResolved, `${modelName}.mld`));
    this.assertResolvedUnder(this.modelsRootResolved, filePath, 'model data file');
    return filePath;
  }

  /** @inheritdoc modelFilePath — alternate name */
  modelDataPath(modelName: string): string {
    return this.modelFilePath(modelName);
  }

  /**
   * Relation index: `${atlas}/relations/${relationName}.rid`
   * @param relationName - Safe base name (e.g. `Source-Target-forward`).
   */
  relationFilePath(relationName: string): string {
    assertRelationIndexKey(relationName);
    const filePath = resolve(join(this.relationsRootResolved, `${relationName}.rid`));
    this.assertResolvedUnder(this.relationsRootResolved, filePath, 'relation index file');
    return filePath;
  }

  /** @inheritdoc relationFilePath — alternate name */
  relationIndexFilePath(indexBaseName: string): string {
    return this.relationFilePath(indexBaseName);
  }

  /**
   * Create `models/` and `relations/` if missing; write an initial `atlas-manifest.json`
   * when none exists (empty registry snapshot).
   */
  ensureAtlasLayoutSync(): void {
    mkdirSync(this.modelsRootResolved, { recursive: true });
    mkdirSync(this.relationsRootResolved, { recursive: true });

    const manifestPath = this.manifestFilePath();
    if (!existsSync(manifestPath)) {
      const empty = new ModelRegistry();
      const body = serializeAtlasManifestFile(empty, this.atlasName);
      writeFileSync(manifestPath, body, 'utf-8');
    }
  }

  /**
   * Vault layout: only the atlas directory exists (no `models/`, `relations/`, no manifest JSON).
   * Callers must persist registry + payloads through {@link AtlasSingleVault}.
   */
  ensureAtlasVaultLayoutSync(): void {
    mkdirSync(this.atlasRootResolved, { recursive: true });
  }

  /** @deprecated Use {@link PathResolver.ensureAtlasLayoutSync}. */
  ensureDirectoriesSync(): void {
    this.ensureAtlasLayoutSync();
  }

  assertResolvedUnderModelsDir(candidatePath: string): void {
    const resolved = resolve(candidatePath);
    this.assertResolvedUnder(this.modelsRootResolved, resolved, 'model scan path');
  }

  private assertResolvedUnderAtlasRoot(resolvedPath: string): void {
    this.assertResolvedUnder(this.atlasRootResolved, resolvedPath, 'atlas file path');
  }

  private assertResolvedUnder(expectedRoot: string, resolvedPath: string, label: string): void {
    const root = resolve(expectedRoot);
    const target = resolve(resolvedPath);
    const rel = relative(root, target);
    if (rel === '') {
      return;
    }
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new AtlasIsolationError(
        `${label} escapes atlas sandbox: "${target}" is not under "${root}".`,
      );
    }
  }
}

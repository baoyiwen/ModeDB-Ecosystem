import { createReadStream } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { basename } from 'node:path';
import { createInterface } from 'node:readline';
import type {
  RelationDefinition,
  RelationIndexData,
  RelationStats,
  ModelRecord,
  BindStrategy,
  BindOptions,
  IndexReader,
  PathResolver,
} from '@mode-db/common';
import { IndexerError, DiskAdapter } from '@mode-db/common';
import { AtlasSingleVault } from './atlas-single-vault.js';

export interface RelationIndexerVaultOptions {
  readonly vault: AtlasSingleVault;
  readonly vaultSecret: string;
  readonly loadModelRecords: (modelName: string) => Promise<ModelRecord[]>;
}

function relationFileKey(rel: RelationDefinition): string {
  return `${rel.source}-${rel.target}-${rel.forward}`;
}

interface LiveIndex {
  fwd: Map<string, Set<string>>;
  rev: Map<string, Set<string>>;
  dirty: boolean;
}

/**
 * Manages bidirectional relation indices between models.
 *
 * Implements {@link IndexReader} so the runtime layer can consume read
 * operations without access to bind/unlink/flush.
 */
export class RelationIndexer implements IndexReader {
  private readonly indices = new Map<string, LiveIndex>();
  private dirReady = false;
  private readonly vaultOptions?: RelationIndexerVaultOptions;

  constructor(
    private readonly paths: PathResolver,
    vaultOptions?: RelationIndexerVaultOptions,
  ) {
    this.vaultOptions = vaultOptions;
  }

  private persistVaultSync(): void {
    if (this.vaultOptions) {
      this.vaultOptions.vault.saveSync(
        this.paths.atlasSingleVaultPath(),
        this.vaultOptions.vaultSecret,
      );
    }
  }

  async bind(
    rel: RelationDefinition,
    strategy: BindStrategy,
    sourceFiles: readonly string[],
    targetFiles: readonly string[],
    options: BindOptions = {},
  ): Promise<void> {
    for (const f of sourceFiles) {
      this.paths.assertResolvedUnderModelsDir(f);
    }
    for (const f of targetFiles) {
      this.paths.assertResolvedUnderModelsDir(f);
    }

    switch (strategy) {
      case 'GLOBAL':
        await this.bindGlobal(rel, sourceFiles, targetFiles);
        break;
      case 'PROTOCOL':
        await this.bindProtocol(rel, sourceFiles, targetFiles);
        break;
      case 'CONDITIONAL':
        await this.bindConditional(rel, sourceFiles, targetFiles, options);
        break;
      case 'MANUAL':
        await this.bindManual(rel, options);
        break;
      default: {
        const _exhaustive: never = strategy;
        throw new IndexerError(`Unknown bind strategy: ${_exhaustive as string}`);
      }
    }
  }

  async getForward(rel: RelationDefinition, sourceId: string): Promise<string[]> {
    const index = await this.loadIndex(rel);
    const set = index.fwd.get(sourceId);
    return set ? [...set] : [];
  }

  async getReverse(rel: RelationDefinition, targetId: string): Promise<string[]> {
    const index = await this.loadIndex(rel);
    const set = index.rev.get(targetId);
    return set ? [...set] : [];
  }

  async flush(rel: RelationDefinition): Promise<void> {
    const key = relationFileKey(rel);
    const index = this.indices.get(key);
    if (!index || !index.dirty) {
      return;
    }
    await this.ensureDir();
    await this.writeToDisk(key, index);
    index.dirty = false;
  }

  async flushAll(): Promise<void> {
    await this.ensureDir();
    for (const [key, index] of this.indices) {
      if (!index.dirty) {
        continue;
      }
      // A single-file vault serializes every relation index into the same
      // atlas.mld. Parallel saves can race and make one write replace another
      // (and on Windows can make a reader observe a transient open failure).
      await this.writeToDisk(key, index);
      index.dirty = false;
    }
  }

  /**
   * Remove a relation index from memory and storage (vault **`r:*`** key or split-file **`.rid`**).
   */
  async dropRelationIndex(rel: RelationDefinition): Promise<void> {
    const key = relationFileKey(rel);
    this.indices.delete(key);
    if (this.vaultOptions) {
      this.vaultOptions.vault.delete(AtlasSingleVault.relationKey(key));
      this.persistVaultSync();
      return;
    }
    const filePath = this.paths.relationIndexFilePath(key);
    try {
      await unlink(filePath);
    } catch (err) {
      if (!isNodeError(err) || err.code !== 'ENOENT') {
        throw new IndexerError(`Failed to delete relation index "${key}"`, { cause: err });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Strategy implementations
  // ---------------------------------------------------------------------------

  private async bindGlobal(
    rel: RelationDefinition,
    sourceFiles: readonly string[],
    targetFiles: readonly string[],
  ): Promise<void> {
    const sourceRecords = await this.loadAllRecordsFromFiles(sourceFiles);
    const targetRecords = await this.loadAllRecordsFromFiles(targetFiles);
    const index = await this.loadIndex(rel);

    for (const src of sourceRecords) {
      for (const tgt of targetRecords) {
        if (!this.canWritePair(rel, src._id, tgt._id)) {
          continue;
        }
        this.applyBidirectionalPair(index, src._id, tgt._id);
      }
    }
  }

  private async bindProtocol(
    rel: RelationDefinition,
    sourceFiles: readonly string[],
    targetFiles: readonly string[],
  ): Promise<void> {
    if (!rel.matchOn) {
      throw new IndexerError(
        `PROTOCOL bind requires matchOn on relation "${rel.forward}", but it is null.`,
      );
    }

    const predicate = rel.matchOn;
    const sourceRecords = await this.loadAllRecordsFromFiles(sourceFiles);
    const targetRecords = await this.loadAllRecordsFromFiles(targetFiles);
    const index = await this.loadIndex(rel);

    for (const src of sourceRecords) {
      const srcVal = (src as Record<string, unknown>)[predicate.sourceField];
      if (srcVal === undefined || srcVal === null) {
        continue;
      }
      for (const tgt of targetRecords) {
        const tgtVal = (tgt as Record<string, unknown>)[predicate.targetField];
        if (srcVal === tgtVal) {
          if (!this.canWritePair(rel, src._id, tgt._id)) {
            continue;
          }
          this.applyBidirectionalPair(index, src._id, tgt._id);
        }
      }
    }
  }

  private async bindConditional(
    rel: RelationDefinition,
    sourceFiles: readonly string[],
    targetFiles: readonly string[],
    options: BindOptions,
  ): Promise<void> {
    if (!rel.matchOn) {
      throw new IndexerError(
        `CONDITIONAL bind requires matchOn on relation "${rel.forward}", but it is null.`,
      );
    }
    if (!options.condition) {
      throw new IndexerError(
        `CONDITIONAL bind requires options.condition for relation "${rel.forward}".`,
      );
    }

    const predicate = rel.matchOn;
    const conditionFn = options.condition;
    const sourceRecords = await this.loadAllRecordsFromFiles(sourceFiles);
    const targetRecords = await this.loadAllRecordsFromFiles(targetFiles);
    const index = await this.loadIndex(rel);

    for (const src of sourceRecords) {
      const srcVal = (src as Record<string, unknown>)[predicate.sourceField];
      if (srcVal === undefined || srcVal === null) {
        continue;
      }
      for (const tgt of targetRecords) {
        const tgtVal = (tgt as Record<string, unknown>)[predicate.targetField];
        if (srcVal === tgtVal && conditionFn(src, tgt)) {
          if (!this.canWritePair(rel, src._id, tgt._id)) {
            continue;
          }
          this.applyBidirectionalPair(index, src._id, tgt._id);
        }
      }
    }
  }

  private async bindManual(rel: RelationDefinition, options: BindOptions): Promise<void> {
    if (!options.pairs || options.pairs.length === 0) {
      throw new IndexerError(
        `MANUAL bind requires non-empty options.pairs for relation "${rel.forward}".`,
      );
    }

    const index = await this.loadIndex(rel);
    for (const [srcId, targetId] of options.pairs) {
      if (!this.canWritePair(rel, srcId, targetId)) {
        continue;
      }
      this.applyBidirectionalPair(index, srcId, targetId);
    }
  }

  async getStats(rel: RelationDefinition): Promise<RelationStats> {
    const index = await this.loadIndex(rel);
    let totalLinks = 0;
    for (const set of index.fwd.values()) {
      totalLinks += set.size;
    }
    return {
      forwardKeys: index.fwd.size,
      reverseKeys: index.rev.size,
      totalLinks,
    };
  }

  /**
   * Remove **all** edges involving `entityId` from the given relation index.
   *
   * - Forward edges keyed by `entityId` are deleted; their reverse counterparts are cleaned.
   * - Reverse edges keyed by `entityId` are deleted; their forward counterparts are cleaned.
   *
   * This implements **model-independent** delete: only the deleted entity's own links are
   * purged; the related model's data rows are never touched.
   */
  async purgeEntity(rel: RelationDefinition, entityId: string): Promise<void> {
    const index = await this.loadIndex(rel);

    const fwdTargets = index.fwd.get(entityId);
    if (fwdTargets) {
      for (const targetId of fwdTargets) {
        const revSet = index.rev.get(targetId);
        if (revSet) {
          revSet.delete(entityId);
          if (revSet.size === 0) {
            index.rev.delete(targetId);
          }
        }
      }
      index.fwd.delete(entityId);
      index.dirty = true;
    }

    const revSources = index.rev.get(entityId);
    if (revSources) {
      for (const sourceId of revSources) {
        const fwdSet = index.fwd.get(sourceId);
        if (fwdSet) {
          fwdSet.delete(entityId);
          if (fwdSet.size === 0) {
            index.fwd.delete(sourceId);
          }
        }
      }
      index.rev.delete(entityId);
      index.dirty = true;
    }
  }

  /**
   * Purge all edges for `entityId` across **every** relation that involves `modelName`
   * (as source or target, including inherited relations).
   */
  async purgeEntityFromAllRelations(
    modelName: string,
    entityId: string,
    registry: { getRelationsOf(name: string): RelationDefinition[] },
  ): Promise<void> {
    const rels = registry.getRelationsOf(modelName);
    for (const rel of rels) {
      await this.purgeEntity(rel, entityId);
    }
  }

  async clearIndex(rel: RelationDefinition): Promise<void> {
    const index = await this.loadIndex(rel);
    index.fwd.clear();
    index.rev.clear();
    index.dirty = true;
  }

  async unlink(
    rel: RelationDefinition,
    pairs: ReadonlyArray<readonly [srcId: string, targetId: string]>,
  ): Promise<void> {
    const index = await this.loadIndex(rel);
    for (const [srcId, targetId] of pairs) {
      this.applyBidirectionalUnpair(index, srcId, targetId);
    }
  }

  // ---------------------------------------------------------------------------
  // Atomic pair write / remove
  // ---------------------------------------------------------------------------

  /**
   * Atomically add one forward + reverse entry for this relation (in-memory; flush to `.rid` separately).
   * All index construction must go through this or {@link RelationIndexer.writePairIndex}.
   */
  async writePairIndex(rel: RelationDefinition, sourceId: string, targetId: string): Promise<void> {
    if (!this.canWritePair(rel, sourceId, targetId)) {
      return;
    }
    const index = await this.loadIndex(rel);
    this.applyBidirectionalPair(index, sourceId, targetId);
  }

  /**
   * Atomically remove one forward + reverse entry.
   */
  async removePairIndex(
    rel: RelationDefinition,
    sourceId: string,
    targetId: string,
  ): Promise<void> {
    const index = await this.loadIndex(rel);
    this.applyBidirectionalUnpair(index, sourceId, targetId);
  }

  /**
   * Same as {@link writePairIndex} but reuses an already-loaded in-memory index (batch strategies).
   */
  private canWritePair(rel: RelationDefinition, sourceId: string, targetId: string): boolean {
    return sourceId !== targetId || rel.selfLoopPolicy === 'allow';
  }

  private applyBidirectionalPair(index: LiveIndex, sourceId: string, targetId: string): void {
    let fwdSet = index.fwd.get(sourceId);
    if (!fwdSet) {
      fwdSet = new Set();
      index.fwd.set(sourceId, fwdSet);
    }
    fwdSet.add(targetId);

    let revSet = index.rev.get(targetId);
    if (!revSet) {
      revSet = new Set();
      index.rev.set(targetId, revSet);
    }
    revSet.add(sourceId);

    index.dirty = true;
  }

  private applyBidirectionalUnpair(index: LiveIndex, sourceId: string, targetId: string): void {
    const fwdSet = index.fwd.get(sourceId);
    if (fwdSet) {
      fwdSet.delete(targetId);
      if (fwdSet.size === 0) {
        index.fwd.delete(sourceId);
      }
    }

    const revSet = index.rev.get(targetId);
    if (revSet) {
      revSet.delete(sourceId);
      if (revSet.size === 0) {
        index.rev.delete(targetId);
      }
    }

    index.dirty = true;
  }

  // ---------------------------------------------------------------------------
  // File scanning
  // ---------------------------------------------------------------------------

  private async loadAllRecordsFromFiles(files: readonly string[]): Promise<ModelRecord[]> {
    if (this.vaultOptions) {
      const results: ModelRecord[] = [];
      for (const file of files) {
        const modelName = basename(file, '.mld');
        results.push(...(await this.vaultOptions.loadModelRecords(modelName)));
      }
      return results;
    }
    const results: ModelRecord[] = [];
    for (const file of files) {
      await this.scanFile(file, (r) => results.push(r));
    }
    return results;
  }

  private async scanFile(filePath: string, onRecord: (record: ModelRecord) => void): Promise<void> {
    this.paths.assertResolvedUnderModelsDir(filePath);
    await DiskAdapter.timedStreamRead(`RelationIndexer.scan:${basename(filePath)}`, async () => {
      let stream;
      try {
        stream = createReadStream(filePath, 'utf-8');
      } catch {
        return;
      }

      const rl = createInterface({ input: stream, crlfDelay: Infinity });

      try {
        for await (const line of rl) {
          const trimmed = line.trim();
          if (trimmed.length === 0) {
            continue;
          }
          onRecord(JSON.parse(trimmed) as ModelRecord);
        }
      } catch (err) {
        if (isNodeError(err) && err.code === 'ENOENT') {
          return;
        }
        throw new IndexerError(`Failed to scan file "${filePath}"`, { cause: err });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  private async loadIndex(rel: RelationDefinition): Promise<LiveIndex> {
    const key = relationFileKey(rel);
    const cached = this.indices.get(key);
    if (cached) {
      return cached;
    }

    let data: RelationIndexData = { fwd: {}, rev: {} };

    if (this.vaultOptions) {
      const raw = this.vaultOptions.vault.get(AtlasSingleVault.relationKey(key));
      if (raw) {
        try {
          data = JSON.parse(raw) as RelationIndexData;
        } catch (err) {
          throw new IndexerError(`Failed to parse relation vault entry "${key}"`, { cause: err });
        }
      }
    } else {
      const filePath = this.paths.relationIndexFilePath(key);
      try {
        const raw = await DiskAdapter.read(filePath, 'utf-8');
        data = JSON.parse(raw) as RelationIndexData;
      } catch (err) {
        if (!isNodeError(err) || err.code !== 'ENOENT') {
          throw new IndexerError(`Failed to load relation index "${key}"`, { cause: err });
        }
      }
    }

    const live: LiveIndex = {
      fwd: deserializeMap(data.fwd),
      rev: deserializeMap(data.rev),
      dirty: false,
    };
    this.indices.set(key, live);
    return live;
  }

  private async writeToDisk(key: string, index: LiveIndex): Promise<void> {
    const data: RelationIndexData = {
      fwd: serializeMap(index.fwd),
      rev: serializeMap(index.rev),
    };

    if (this.vaultOptions) {
      this.vaultOptions.vault.set(AtlasSingleVault.relationKey(key), JSON.stringify(data));
      this.persistVaultSync();
      return;
    }

    const filePath = this.paths.relationIndexFilePath(key);
    try {
      await DiskAdapter.writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    } catch (err) {
      throw new IndexerError(`Failed to write relation index "${key}"`, { cause: err });
    }
  }

  private async ensureDir(): Promise<void> {
    if (this.vaultOptions) {
      return;
    }
    if (this.dirReady) {
      return;
    }
    await mkdir(this.paths.relationsDir(), { recursive: true });
    this.dirReady = true;
  }
}

function serializeMap(map: Map<string, Set<string>>): Record<string, string[]> {
  const obj: Record<string, string[]> = {};
  for (const [k, v] of map) {
    obj[k] = [...v];
  }
  return obj;
}

function deserializeMap(obj: Record<string, string[]>): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const [k, v] of Object.entries(obj)) {
    map.set(k, new Set(v));
  }
  return map;
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

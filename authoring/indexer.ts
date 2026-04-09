import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import type {
  RelationDefinition,
  RelationIndexData,
  RelationStats,
  ModelRecord,
  BindStrategy,
  BindOptions,
} from '../common/types.js';
import type { IndexReader } from '../common/provider.js';
import type { PathResolver } from '../src/common/PathResolver.js';
import { IndexerError } from '../common/errors.js';

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

  constructor(private readonly paths: PathResolver) {}

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
    const tasks: Promise<void>[] = [];
    for (const [key, index] of this.indices) {
      if (index.dirty) {
        tasks.push(
          this.writeToDisk(key, index).then(() => {
            index.dirty = false;
          }),
        );
      }
    }
    await Promise.all(tasks);
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
    const results: ModelRecord[] = [];
    for (const file of files) {
      await this.scanFile(file, (r) => results.push(r));
    }
    return results;
  }

  private async scanFile(filePath: string, onRecord: (record: ModelRecord) => void): Promise<void> {
    this.paths.assertResolvedUnderModelsDir(filePath);

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

    const filePath = this.paths.relationIndexFilePath(key);
    let data: RelationIndexData = { fwd: {}, rev: {} };

    try {
      const raw = await readFile(filePath, 'utf-8');
      data = JSON.parse(raw) as RelationIndexData;
    } catch (err) {
      if (!isNodeError(err) || err.code !== 'ENOENT') {
        throw new IndexerError(`Failed to load relation index "${key}"`, { cause: err });
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
    const filePath = this.paths.relationIndexFilePath(key);
    const data: RelationIndexData = {
      fwd: serializeMap(index.fwd),
      rev: serializeMap(index.rev),
    };

    try {
      await writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    } catch (err) {
      throw new IndexerError(`Failed to write relation index "${key}"`, { cause: err });
    }
  }

  private async ensureDir(): Promise<void> {
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

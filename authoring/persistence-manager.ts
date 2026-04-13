import type { ModelRecord } from '../common/types.js';
import type { ModelStorage } from './storage.js';
import { MergedDataReader, type BufferedModelSource } from './merged-data-reader.js';

const shutdownTasks: Array<() => Promise<void>> = [];
let lifecycleHooksInstalled = false;
let shutdownRan = false;

/**
 * Registers a best-effort flush callback (typically {@link AuthoringEngine.flushAll}) for SIGINT and
 * SIGTERM. Safe to call multiple times (one hook set per process). Normal process exit relies on
 * {@link AuthoringEngine}'s scheduler / `beforeExit` or an explicit {@link AuthoringEngine.flushAll}.
 */
export function registerAuthoringShutdownTask(task: () => Promise<void>): void {
  shutdownTasks.push(task);
  if (lifecycleHooksInstalled) {
    return;
  }
  lifecycleHooksInstalled = true;

  const runAll = async (): Promise<void> => {
    if (shutdownRan) {
      return;
    }
    shutdownRan = true;
    for (const t of shutdownTasks) {
      try {
        await t();
      } catch {
        /* ignore */
      }
    }
  };

  process.once('SIGINT', () => {
    void runAll().finally(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    void runAll().finally(() => process.exit(0));
  });
}

/**
 * Write-behind buffer: per-model `Map<_id, ModelRecord>`, merged into reads via {@link MergedDataReader}.
 */
export class PersistenceManager implements BufferedModelSource {
  /** modelName → row _id → staged record */
  private readonly recordBuffers = new Map<string, Map<string, ModelRecord>>();
  private readonly dirtyModels = new Set<string>();
  private readonly merged: MergedDataReader;
  private pendingFlushPromise: Promise<void> | null = null;

  constructor(private readonly storage: ModelStorage) {
    this.merged = new MergedDataReader(storage, this);
  }

  getMergedReader(): MergedDataReader {
    return this.merged;
  }

  /**
   * Shared write-behind map for {@link ModelEntity} (same reference as `private _buffer` on the handle).
   */
  getOrCreateModelBuffer(modelName: string): Map<string, ModelRecord> {
    let m = this.recordBuffers.get(modelName);
    if (!m) {
      m = new Map();
      this.recordBuffers.set(modelName, m);
    }
    return m;
  }

  /** True if the model has unflushed inserts (or was touched since last flush). */
  isModelDirty(modelName: string): boolean {
    return this.dirtyModels.has(modelName) || (this.recordBuffers.get(modelName)?.size ?? 0) > 0;
  }

  getPendingSnapshot(modelName: string): readonly ModelRecord[] {
    const m = this.recordBuffers.get(modelName);
    return m ? [...m.values()] : [];
  }

  /** True if any model still has staged rows. */
  hasBufferedRows(): boolean {
    for (const m of this.recordBuffers.values()) {
      if (m.size > 0) {
        return true;
      }
    }
    return false;
  }

  /** Stage one row in the write-behind map (see {@link ModelEntity.insert} for `{ sync: true }`). */
  async insert(modelName: string, data: Record<string, unknown>): Promise<ModelRecord> {
    const record = this.storage.prepareInsert(modelName, data);
    const buf = this.getOrCreateModelBuffer(modelName);
    buf.set(record._id, record);
    this.dirtyModels.add(modelName);
    return record;
  }

  /**
   * Append staged rows for one model to `.mld` and clear that model's buffer map.
   */
  async flushModelToDisk(modelName: string): Promise<void> {
    for (;;) {
      if (this.pendingFlushPromise) {
        await this.pendingFlushPromise;
        continue;
      }
      const map = this.recordBuffers.get(modelName);
      if (!map || map.size === 0) {
        return;
      }
      this.pendingFlushPromise = (async () => {
        try {
          const batch = [...map.values()];
          map.clear();
          this.dirtyModels.delete(modelName);
          if (batch.length > 0) {
            await this.storage.appendRecordsToDisk(modelName, batch);
          }
        } finally {
          this.pendingFlushPromise = null;
        }
      })();
      await this.pendingFlushPromise;
    }
  }

  /**
   * Append all staged rows to `.mld` files and clear buffers for those models.
   * Idempotent when buffers are empty. Serialized so concurrent callers share one run.
   */
  async flushPendingToDisk(): Promise<void> {
    for (;;) {
      if (this.pendingFlushPromise) {
        await this.pendingFlushPromise;
        continue;
      }
      const hasWork = [...this.recordBuffers.values()].some((m) => m.size > 0);
      if (!hasWork) {
        return;
      }
      this.pendingFlushPromise = (async () => {
        try {
          for (const [model, map] of [...this.recordBuffers.entries()]) {
            if (map.size === 0) {
              continue;
            }
            const batch = [...map.values()];
            map.clear();
            this.dirtyModels.delete(model);
            await this.storage.appendRecordsToDisk(model, batch);
          }
        } finally {
          this.pendingFlushPromise = null;
        }
      })();
      await this.pendingFlushPromise;
    }
  }
}

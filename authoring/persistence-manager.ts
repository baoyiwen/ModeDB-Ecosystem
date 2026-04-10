import type { ModelRecord } from '../common/types.js';
import type { ModelStorage } from './storage.js';
import { MergedDataReader, type BufferedModelSource } from './merged-data-reader.js';

const shutdownTasks: Array<() => Promise<void>> = [];
let lifecycleHooksInstalled = false;
let shutdownRan = false;

/**
 * Registers a best-effort flush callback (typically {@link AuthoringEngine.flushAll}) for SIGINT and
 * SIGTERM. Safe to call multiple times (one hook set per process). Normal process exit relies on the
 * idle auto-flush timer or an explicit {@link AuthoringEngine.flushAll}.
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
 * Buffers authoring inserts, schedules idle flushes to disk, and supplies a {@link MergedDataReader}
 * for read-your-writes queries in the same process.
 */
export class PersistenceManager implements BufferedModelSource {
  private readonly buffer = new Map<string, ModelRecord[]>();
  private readonly dirtyModels = new Set<string>();
  private readonly merged: MergedDataReader;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingFlushPromise: Promise<void> | null = null;

  constructor(private readonly storage: ModelStorage) {
    this.merged = new MergedDataReader(storage, this);
  }

  getMergedReader(): MergedDataReader {
    return this.merged;
  }

  /** True if the model has unflushed inserts (or was touched since last flush). */
  isModelDirty(modelName: string): boolean {
    return this.dirtyModels.has(modelName) || (this.buffer.get(modelName)?.length ?? 0) > 0;
  }

  getPendingSnapshot(modelName: string): readonly ModelRecord[] {
    const arr = this.buffer.get(modelName);
    return arr ? [...arr] : [];
  }

  async insert(modelName: string, data: Record<string, unknown>): Promise<ModelRecord> {
    const record = this.storage.prepareInsert(modelName, data);
    const list = this.buffer.get(modelName) ?? [];
    list.push(record);
    this.buffer.set(modelName, list);
    this.dirtyModels.add(modelName);
    this.scheduleDebouncedFlush();
    return record;
  }

  private scheduleDebouncedFlush(): void {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flushPendingToDisk();
    }, 80);
  }

  /**
   * Append all buffered rows to `.mld` files and clear the buffer for those models.
   * Idempotent when the buffer is empty. Serialized so concurrent callers share one run.
   */
  async flushPendingToDisk(): Promise<void> {
    for (;;) {
      if (this.pendingFlushPromise) {
        await this.pendingFlushPromise;
        continue;
      }
      const hasWork = [...this.buffer.values()].some((a) => a.length > 0);
      if (!hasWork) {
        return;
      }
      this.pendingFlushPromise = (async () => {
        try {
          if (this.flushTimer !== undefined) {
            clearTimeout(this.flushTimer);
            this.flushTimer = undefined;
          }
          for (const [model, arr] of [...this.buffer.entries()]) {
            if (arr.length === 0) {
              continue;
            }
            const batch = arr.splice(0, arr.length);
            await this.storage.appendRecordsToDisk(model, batch);
            this.dirtyModels.delete(model);
          }
        } finally {
          this.pendingFlushPromise = null;
        }
      })();
      await this.pendingFlushPromise;
    }
  }
}

import { join, dirname } from 'node:path';
import {
  DiskAdapter,
  DELETED_SENTINEL,
  isDeletedRecord,
  type ModelRecord,
  ValidationReport,
  DiagnosticCenter,
  ErrorCodes,
  type Diagnostic,
  type SmartCache,
} from '@mode-db/common';
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

  constructor(
    private readonly storage: ModelStorage,
    private readonly smartCache?: SmartCache,
    private readonly bufferFlushRowThreshold?: number,
  ) {
    this.merged = new MergedDataReader(storage, this);
  }

  private async maybeFlushIfOverThreshold(modelName: string): Promise<void> {
    const t = this.bufferFlushRowThreshold;
    if (t === undefined || t <= 0) {
      return;
    }
    const buf = this.recordBuffers.get(modelName);
    if (buf && buf.size >= t) {
      await this.flushModelToDisk(modelName);
    }
  }

  private invalidateQueryCache(modelName: string): void {
    this.smartCache?.invalidateModel(modelName);
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

  /**
   * Stage one row in the write-behind map.
   *
   * Validation runs through DiagnosticCenter in **throw** mode — invalid data
   * never enters the buffer. For batch inserts with silent collection, use
   * {@link insertMany}.
   */
  async insert(modelName: string, data: Record<string, unknown>): Promise<ModelRecord> {
    const record = this.storage.prepareInsert(modelName, data);
    const buf = this.getOrCreateModelBuffer(modelName);
    buf.set(record._id, record);
    this.dirtyModels.add(modelName);
    this.invalidateQueryCache(modelName);
    await this.maybeFlushIfOverThreshold(modelName);
    return record;
  }

  /**
   * Batch insert: validates each row independently. Successful rows are staged;
   * failed rows are recorded in the returned {@link ValidationReport}.
   */
  async insertMany(
    modelName: string,
    rows: ReadonlyArray<Record<string, unknown>>,
  ): Promise<ValidationReport<ModelRecord>> {
    const report = new ValidationReport<ModelRecord>();
    for (let i = 0; i < rows.length; i++) {
      const diagnostics: Diagnostic[] = [];
      try {
        const record = this.storage.prepareInsert(modelName, rows[i], diagnostics);
        if (diagnostics.some((d) => d.severity === 'ERROR' || d.severity === 'FATAL')) {
          report.addRow({ index: i, success: false, diagnostics });
          continue;
        }
        const buf = this.getOrCreateModelBuffer(modelName);
        buf.set(record._id, record);
        this.dirtyModels.add(modelName);
        report.addRow({ index: i, success: true, data: record, diagnostics });
      } catch (err) {
        const d = DiagnosticCenter.create('E1010', {
          index: i,
          model: modelName,
          detail: err instanceof Error ? err.message : String(err),
        });
        diagnostics.push(d);
        report.addRow({ index: i, success: false, diagnostics });
      }
    }
    if (report.successCount > 0) {
      this.invalidateQueryCache(modelName);
      await this.maybeFlushIfOverThreshold(modelName);
    }
    return report;
  }

  /**
   * Merge `partialData` into an existing row. Checks buffer first; falls back to disk.
   * The merged row is staged in the buffer (last-write-wins on flush).
   * Returns the merged row, or `undefined` when `_id` does not exist anywhere.
   */
  async update(
    modelName: string,
    id: string,
    partialData: Record<string, unknown>,
  ): Promise<ModelRecord | undefined> {
    const buf = this.getOrCreateModelBuffer(modelName);
    let existing = buf.get(id);
    if (!existing) {
      const diskRows = await this.storage.getByIds(modelName, [id]);
      existing = diskRows[0];
    }
    if (!existing || isDeletedRecord(existing)) {
      return undefined;
    }
    const merged: ModelRecord = {
      ...existing,
      ...partialData,
      _id: id,
      _createdAt: existing._createdAt,
    };
    delete (merged as Record<string, unknown>)[DELETED_SENTINEL];
    buf.set(id, merged);
    this.dirtyModels.add(modelName);
    this.invalidateQueryCache(modelName);
    return merged;
  }

  /**
   * Soft-delete: place a tombstone (`__deleted: true`) in the buffer.
   * Queries immediately stop returning this row; the physical `.mld` line is removed on flush.
   * Returns `true` when the row existed (buffer or disk), `false` otherwise.
   */
  async delete(modelName: string, id: string): Promise<boolean> {
    const buf = this.getOrCreateModelBuffer(modelName);
    let existing = buf.get(id);
    if (!existing) {
      const diskRows = await this.storage.getByIds(modelName, [id]);
      existing = diskRows[0];
    }
    if (!existing || isDeletedRecord(existing)) {
      return false;
    }
    const tombstone: ModelRecord = {
      _id: id,
      _createdAt: existing._createdAt,
      [DELETED_SENTINEL]: true,
    } as ModelRecord;
    buf.set(id, tombstone);
    this.dirtyModels.add(modelName);
    this.invalidateQueryCache(modelName);
    return true;
  }

  /**
   * Flush one model: live rows are appended; tombstoned rows trigger a full rewrite
   * that compacts deleted lines out of the `.mld` file.
   *
   * On disk I/O failure, emits a FATAL diagnostic via {@link DiagnosticCenter} and
   * attempts an emergency `.dump` export to prevent data loss.
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
        const batch = [...map.values()];
        try {
          const hasTombstones = batch.some(isDeletedRecord);
          map.clear();
          this.dirtyModels.delete(modelName);

          if (hasTombstones) {
            await this._compactRewrite(modelName, batch);
          } else if (batch.length > 0) {
            await this.storage.appendRecordsToDisk(modelName, batch);
          }
        } catch (err) {
          await this._emergencyDump(modelName, batch, err);
          throw err;
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
   *
   * On disk I/O failure for any model, emits a FATAL diagnostic and writes an
   * emergency `.dump` file before re-throwing.
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
            const hasTombstones = batch.some(isDeletedRecord);
            map.clear();
            this.dirtyModels.delete(model);

            try {
              if (hasTombstones) {
                await this._compactRewrite(model, batch);
              } else if (batch.length > 0) {
                await this.storage.appendRecordsToDisk(model, batch);
              }
            } catch (err) {
              await this._emergencyDump(model, batch, err);
              throw err;
            }
          }
        } finally {
          this.pendingFlushPromise = null;
        }
      })();
      await this.pendingFlushPromise;
    }
  }

  /**
   * Read the full `.mld`, merge buffered rows (updates overwrite, deletes remove),
   * then atomically rewrite the file without any tombstoned lines.
   */
  private async _compactRewrite(
    modelName: string,
    buffered: readonly ModelRecord[],
  ): Promise<void> {
    const diskRows = await this.storage.getAll(modelName);
    const byId = new Map(diskRows.map((r) => [r._id, r] as const));
    for (const r of buffered) {
      byId.set(r._id, r);
    }
    const live: ModelRecord[] = [];
    for (const r of byId.values()) {
      if (!isDeletedRecord(r)) {
        live.push(r);
      }
    }
    await this.storage.rewriteRecordsToDisk(modelName, live);
  }

  /**
   * Emergency dump: when a flush fails, write the buffered rows to a `.dump`
   * file next to the `.mld` to prevent data loss, then emit a FATAL diagnostic.
   *
   * Tries the models directory first; if that also fails, falls back to the
   * atlas root directory.
   */
  private async _emergencyDump(
    modelName: string,
    batch: readonly ModelRecord[],
    cause: unknown,
  ): Promise<void> {
    const detail = cause instanceof Error ? cause.message : String(cause);
    DiagnosticCenter.report(
      ErrorCodes.IO_PERSISTENCE_FAIL,
      { model: modelName, detail },
      'collect',
    );

    const lines = batch.map((r) => JSON.stringify(r)).join('\n') + '\n';
    const mldPath = this.storage.filePath(modelName);
    const candidates = [
      join(dirname(mldPath), `${modelName}.dump`),
      join(dirname(dirname(mldPath)), `${modelName}.dump`),
    ];

    for (const dumpPath of candidates) {
      try {
        await DiskAdapter.writeFile(dumpPath, lines, 'utf-8');
        return;
      } catch {
        /* try next candidate */
      }
    }
  }
}

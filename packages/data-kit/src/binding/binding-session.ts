import type { EngineOperation, RemoteExecuteSnapshot } from '@mode-db/shared';

import type { DataPageMutationMode } from '../page-mode.js';
import type { EntityRowRef, ViewDataShape } from '../view-data/view-data-shape.js';
import {
  adaptUnknownQueryResult,
  startModelFromSnapshot,
} from '../view-data/query-result-adapter.js';
import { isDeleteForRow, isUpdateForCell } from './pending-overlay.js';
import type { ApplyBatchResult, BindingExecutor, BindingListener } from './binding-executor.js';
import { firstApplyOutcomeError } from './apply-outcome.js';
import {
  countInsertManySuccesses,
  extractInsertManyFailures,
  rebuildPendingAfterInsertManyFailures,
  stripRelationBindOps,
  type ImportRowFailure,
} from './insert-many-failures.js';
import type { ImportBindOnlyStaging } from '../import/import-lookup-bind.js';
import { commitImportBatch } from './import-commit.js';
import { assertOpAllowedForMode, BindingModeError } from './mode-guards.js';

export interface BindingSessionOptions {
  readonly querySnapshot: RemoteExecuteSnapshot;
  readonly executor: BindingExecutor;
  readonly pivotLeafGrain?: boolean;
  readonly initialViewData?: ViewDataShape;
  /** Schema prop columns to display (from catalog). */
  readonly propFields?: readonly string[];
  /** Optional display labels keyed by field/column name. */
  readonly columnLabels?: Readonly<Record<string, string>>;
}

/** Headless batch binding session — all writes staged until {@link BindingSession.commit}. */
export interface BindingSession {
  readonly querySnapshot: RemoteExecuteSnapshot;
  readonly pendingOps: readonly EngineOperation[];
  readonly pendingCount: number;
  readonly revision: number;
  readonly viewData: ViewDataShape | null;
  readonly isDirty: boolean;
  readonly isRefreshing: boolean;
  readonly lastError: string | null;
  readonly importFailures: readonly ImportRowFailure[] | null;

  subscribe(listener: BindingListener): () => void;
  setQuerySnapshot(snapshot: RemoteExecuteSnapshot): void;
  refresh(): Promise<ViewDataShape>;
  stage(op: EngineOperation, mode: DataPageMutationMode): void;
  stageMany(ops: readonly EngineOperation[], mode: DataPageMutationMode): void;
  /** Stage import ops; pass {@link ImportBindOnlyStaging} when bind-only relation columns are used. */
  stageImportBatch(
    ops: readonly EngineOperation[],
    bindOnlyStaging: ImportBindOnlyStaging | null | undefined,
    mode: DataPageMutationMode,
  ): void;
  stageCellUpdate(
    ref: EntityRowRef,
    column: string,
    value: unknown,
    mode: DataPageMutationMode,
  ): void;
  stageRowDelete(ref: EntityRowRef): void;
  unstageRowDelete(ref: EntityRowRef): void;
  updateImportRow(opIndex: number, rowIndex: number, field: string, value: unknown): void;
  discard(): void;
  replacePendingOps(ops: readonly EngineOperation[]): void;
  commit(options?: { failFast?: boolean }): Promise<ApplyBatchResult>;
}

/**
 * Creates a {@link BindingSession} with batch commit semantics.
 */
export function createBindingSession(options: BindingSessionOptions): BindingSession {
  let querySnapshot = options.querySnapshot;
  const propFields = options.propFields;
  const columnLabels = options.columnLabels;
  let pendingOps: EngineOperation[] = [];
  let revision = 0;
  let viewData: ViewDataShape | null = options.initialViewData ?? null;
  let isRefreshing = false;
  let lastError: string | null = null;
  let importFailures: ImportRowFailure[] | null = null;
  let importBindOnlyStaging: ImportBindOnlyStaging | null = null;
  let importPendingOps = new WeakSet<EngineOperation>();
  const listeners = new Set<BindingListener>();

  const notify = (): void => {
    revision += 1;
    for (const fn of listeners) {
      fn();
    }
  };

  const pivotLeafGrain = options.pivotLeafGrain ?? false;

  const refresh = async (): Promise<ViewDataShape> => {
    isRefreshing = true;
    lastError = null;
    notify();
    try {
      const raw = await options.executor.executeQuery(querySnapshot);
      const sourceModel = startModelFromSnapshot(querySnapshot.plan);
      viewData = adaptUnknownQueryResult(raw, {
        sourceModel,
        pivotLeafGrain,
        propFields,
        columnLabels,
      });
      return viewData;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      viewData = { kind: 'empty', reason: 'refresh_failed' };
      throw e;
    } finally {
      isRefreshing = false;
      notify();
    }
  };

  const stage = (op: EngineOperation, mode: DataPageMutationMode): void => {
    assertOpAllowedForMode(op, mode);
    pendingOps = [...pendingOps, op];
    notify();
  };

  const stageMany = (ops: readonly EngineOperation[], mode: DataPageMutationMode): void => {
    for (const op of ops) {
      assertOpAllowedForMode(op, mode);
    }
    pendingOps = [...pendingOps, ...ops];
    notify();
  };

  const stageImportBatch = (
    ops: readonly EngineOperation[],
    bindOnlyStaging: ImportBindOnlyStaging | null | undefined,
    mode: DataPageMutationMode,
  ): void => {
    for (const op of ops) {
      assertOpAllowedForMode(op, mode);
    }
    // Keep one active import batch so repeated staging cannot duplicate pending inserts.
    pendingOps = pendingOps.filter((op) => !importPendingOps.has(op));
    importPendingOps = new WeakSet<EngineOperation>();
    for (const op of ops) {
      importPendingOps.add(op);
    }
    pendingOps = [...pendingOps, ...ops];
    importBindOnlyStaging = bindOnlyStaging ?? null;
    importFailures = null;
    notify();
  };

  const stageCellUpdate = (
    ref: EntityRowRef,
    column: string,
    value: unknown,
    mode: DataPageMutationMode,
  ): void => {
    const op: EngineOperation = {
      op: 'update',
      model: ref.model,
      id: ref.id,
      partial: { [column]: value },
    };
    assertOpAllowedForMode(op, mode);
    pendingOps = [...pendingOps.filter((existing) => !isUpdateForCell(existing, ref, column)), op];
    notify();
  };

  const stageRowDelete = (ref: EntityRowRef): void => {
    const op: EngineOperation = { op: 'delete', model: ref.model, id: ref.id };
    assertOpAllowedForMode(op, 'delete');
    pendingOps = [...pendingOps.filter((existing) => !isDeleteForRow(existing, ref)), op];
    notify();
  };

  const unstageRowDelete = (ref: EntityRowRef): void => {
    pendingOps = pendingOps.filter((existing) => !isDeleteForRow(existing, ref));
    notify();
  };

  const discard = (): void => {
    pendingOps = [];
    lastError = null;
    importFailures = null;
    importBindOnlyStaging = null;
    importPendingOps = new WeakSet<EngineOperation>();
    notify();
  };

  const replacePendingOps = (ops: readonly EngineOperation[]): void => {
    const hadImportPending = pendingOps.some((op) => importPendingOps.has(op));
    pendingOps = [...ops];
    importPendingOps = new WeakSet<EngineOperation>();
    if (hadImportPending) {
      for (const op of pendingOps) {
        if (op.op === 'insertMany' || op.op === 'bind') {
          importPendingOps.add(op);
        }
      }
    }
    notify();
  };

  const updateImportRow = (
    opIndex: number,
    rowIndex: number,
    field: string,
    value: unknown,
  ): void => {
    pendingOps = pendingOps.map((op, i) => {
      if (i !== opIndex || op.op !== 'insertMany') {
        return op;
      }
      const rows = op.rows.map((row, ri) => (ri === rowIndex ? { ...row, [field]: value } : row));
      const next = { ...op, rows };
      if (importPendingOps.has(op)) {
        importPendingOps.add(next);
      }
      return next;
    });
    if (importFailures) {
      importFailures = importFailures.map((f) =>
        f.opIndex === opIndex && f.rowIndex === rowIndex
          ? { ...f, row: { ...f.row, [field]: value } }
          : f,
      );
    }
    notify();
  };

  const commit = async (commitOptions?: { failFast?: boolean }): Promise<ApplyBatchResult> => {
    if (pendingOps.length === 0) {
      return { ok: true, outcomes: [], committedCount: 0 };
    }
    const batch = pendingOps;
    const staging = importBindOnlyStaging;
    try {
      const outcomes = await commitImportBatch(options.executor, batch, staging, {
        failFast: commitOptions?.failFast ?? true,
      });
      const failed = outcomes.find((o) => !o.ok);
      if (failed) {
        lastError = failed.error ?? 'applyAll failed';
        notify();
        return {
          ok: false,
          outcomes,
          committedCount: 0,
          error: lastError,
        };
      }
      const mutationError = firstApplyOutcomeError(outcomes);
      if (mutationError) {
        const failures = extractInsertManyFailures(batch, outcomes);
        const inserted = countInsertManySuccesses(outcomes);
        importFailures = failures.length > 0 ? failures : null;
        const previousImportPendingOps = importPendingOps;
        pendingOps =
          failures.length > 0
            ? stripRelationBindOps(rebuildPendingAfterInsertManyFailures(batch, outcomes))
            : batch;
        importPendingOps = new WeakSet<EngineOperation>();
        if (failures.length > 0) {
          for (const op of pendingOps) {
            if (op.op === 'insertMany') {
              importPendingOps.add(op);
            }
          }
        } else {
          for (const op of pendingOps) {
            const wasImportOp = batch.some(
              (original) => original === op && previousImportPendingOps.has(original),
            );
            if (wasImportOp) {
              importPendingOps.add(op);
            }
          }
        }
        lastError = mutationError;
        if (inserted > 0) {
          await refresh();
        }
        notify();
        return {
          ok: false,
          outcomes,
          committedCount: inserted > 0 ? outcomes.filter((o) => o.ok).length : 0,
          error: lastError,
          partialSuccess: inserted > 0,
          importFailures: importFailures ?? undefined,
        };
      }
      pendingOps = [];
      lastError = null;
      importFailures = null;
      importBindOnlyStaging = null;
      importPendingOps = new WeakSet<EngineOperation>();
      await refresh();
      notify();
      return { ok: true, outcomes, committedCount: batch.length };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      notify();
      return {
        ok: false,
        outcomes: [],
        committedCount: 0,
        error: lastError,
      };
    }
  };

  return {
    get querySnapshot() {
      return querySnapshot;
    },
    get pendingOps() {
      return pendingOps;
    },
    get pendingCount() {
      return pendingOps.length;
    },
    get revision() {
      return revision;
    },
    get viewData() {
      return viewData;
    },
    get isDirty() {
      return pendingOps.length > 0;
    },
    get isRefreshing() {
      return isRefreshing;
    },
    get lastError() {
      return lastError;
    },
    get importFailures() {
      return importFailures;
    },
    subscribe(listener: BindingListener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setQuerySnapshot(snapshot: RemoteExecuteSnapshot) {
      if (pendingOps.length > 0) {
        throw new BindingModeError(
          'Cannot change query snapshot while pending operations exist; discard or commit first.',
        );
      }
      querySnapshot = snapshot;
      notify();
    },
    refresh,
    stage,
    stageMany,
    stageImportBatch,
    stageCellUpdate,
    stageRowDelete,
    unstageRowDelete,
    updateImportRow,
    replacePendingOps,
    discard,
    commit,
  };
}

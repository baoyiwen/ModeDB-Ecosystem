import type { EngineApplyOutcome, EngineOperation } from '@mode-db/shared';

/** One row that failed `insertMany` validation, with human-readable reasons. */
export interface ImportRowFailure {
  readonly opIndex: number;
  readonly rowIndex: number;
  readonly model: string;
  readonly row: Record<string, unknown>;
  readonly reasons: readonly string[];
}

interface InsertManyMutationResult {
  readonly kind: 'mutation';
  readonly op: 'insertMany';
  readonly model?: string;
  readonly successCount?: number;
  readonly failureCount?: number;
  readonly rowFailures?: readonly {
    readonly index: number;
    readonly diagnostics: readonly { readonly message: string }[];
  }[];
}

function asInsertManyMutation(result: unknown): InsertManyMutationResult | null {
  if (typeof result !== 'object' || result === null || !('kind' in result)) {
    return null;
  }
  const r = result as { kind: unknown; op?: unknown };
  if (r.kind !== 'mutation' || r.op !== 'insertMany') {
    return null;
  }
  return result as InsertManyMutationResult;
}

/** Extracts failed import rows from a commit batch aligned with apply outcomes. */
export function extractInsertManyFailures(
  batch: readonly EngineOperation[],
  outcomes: readonly EngineApplyOutcome[],
): ImportRowFailure[] {
  const failures: ImportRowFailure[] = [];
  for (let i = 0; i < outcomes.length; i++) {
    const outcome = outcomes[i];
    const op = batch[i];
    if (!outcome?.ok || !op || op.op !== 'insertMany') {
      continue;
    }
    const mutation = asInsertManyMutation(outcome.result);
    if (!mutation || (mutation.failureCount ?? 0) <= 0) {
      continue;
    }
    if (mutation.rowFailures && mutation.rowFailures.length > 0) {
      for (const rf of mutation.rowFailures) {
        const row = op.rows[rf.index];
        if (!row) {
          continue;
        }
        const reasons = rf.diagnostics.map((d) => d.message).filter((m) => m.length > 0);
        failures.push({
          opIndex: i,
          rowIndex: rf.index,
          model: op.model,
          row: { ...row },
          reasons: reasons.length > 0 ? reasons : ['Validation failed.'],
        });
      }
      continue;
    }
    for (let rowIndex = 0; rowIndex < op.rows.length; rowIndex++) {
      failures.push({
        opIndex: i,
        rowIndex,
        model: op.model,
        row: { ...op.rows[rowIndex]! },
        reasons: ['Validation failed.'],
      });
    }
  }
  return failures;
}

/** Removes relation bind ops until all inserts succeed. */
export function stripRelationBindOps(ops: readonly EngineOperation[]): EngineOperation[] {
  return ops.filter((o) => o.op !== 'bind' && o.op !== 'bindPair' && o.op !== 'bindImportLookup');
}

/**
 * Rebuilds pending ops keeping only rows that failed insertMany validation.
 * Non-insertMany ops are kept only when a preceding insertMany in the batch still has failures.
 */
export function rebuildPendingAfterInsertManyFailures(
  batch: readonly EngineOperation[],
  outcomes: readonly EngineApplyOutcome[],
): EngineOperation[] {
  const failedInsertOpIndices = new Set<number>();
  for (let i = 0; i < outcomes.length; i++) {
    const outcome = outcomes[i];
    const op = batch[i];
    if (!outcome?.ok || !op || op.op !== 'insertMany') {
      continue;
    }
    const mutation = asInsertManyMutation(outcome.result);
    if (mutation && (mutation.failureCount ?? 0) > 0) {
      failedInsertOpIndices.add(i);
    }
  }

  const next: EngineOperation[] = [];
  for (let i = 0; i < batch.length; i++) {
    const op = batch[i]!;
    if (op.op === 'insertMany') {
      if (!failedInsertOpIndices.has(i)) {
        continue;
      }
      const outcome = outcomes[i];
      const mutation = outcome?.ok ? asInsertManyMutation(outcome.result) : null;
      const failedIndices = new Set<number>();
      if (mutation?.rowFailures && mutation.rowFailures.length > 0) {
        for (const rf of mutation.rowFailures) {
          failedIndices.add(rf.index);
        }
      } else if (mutation && (mutation.failureCount ?? 0) > 0) {
        for (let idx = 0; idx < op.rows.length; idx++) {
          failedIndices.add(idx);
        }
      }
      const rows = op.rows.filter((_, idx) => failedIndices.has(idx));
      if (rows.length > 0) {
        next.push({ ...op, rows });
      }
      continue;
    }
    if (failedInsertOpIndices.size > 0) {
      continue;
    }
    next.push(op);
  }
  return next;
}

/** Counts rows successfully inserted across all insertMany outcomes. */
export function countInsertManySuccesses(outcomes: readonly EngineApplyOutcome[]): number {
  let total = 0;
  for (const outcome of outcomes) {
    if (!outcome.ok) {
      continue;
    }
    const mutation = asInsertManyMutation(outcome.result);
    if (mutation) {
      total += mutation.successCount ?? 0;
    }
  }
  return total;
}

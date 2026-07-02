import type { EngineApplyOutcome, EngineOperation } from '@mode-db/shared';

import type { BindingExecutor } from './binding-executor.js';
import {
  buildBindImportLookupOps,
  type ImportBindOnlyStaging,
} from '../import/import-lookup-bind.js';
import { firstApplyOutcomeError } from './apply-outcome.js';
import {
  countInsertManySuccesses,
  extractInsertManyFailures,
  rebuildPendingAfterInsertManyFailures,
  stripRelationBindOps,
} from './insert-many-failures.js';

function isInsertManyOutcome(result: unknown): result is {
  readonly op: 'insertMany';
  readonly model: string;
  readonly records?: readonly Record<string, unknown>[];
} {
  return (
    typeof result === 'object' &&
    result !== null &&
    'op' in result &&
    (result as { op: unknown }).op === 'insertMany'
  );
}

function partitionImportBatch(batch: readonly EngineOperation[]): {
  readonly inserts: readonly EngineOperation[];
  readonly tail: readonly EngineOperation[];
} {
  const inserts: EngineOperation[] = [];
  const tail: EngineOperation[] = [];
  for (const op of batch) {
    if (op.op === 'insertMany') {
      inserts.push(op);
    } else if (op.op !== 'bindImportLookup') {
      tail.push(op);
    }
  }
  return { inserts, tail };
}

/**
 * Commits an import batch: insertMany (with returning) first, then lookup binds, then PROTOCOL binds.
 */
export async function commitImportBatch(
  executor: BindingExecutor,
  batch: readonly EngineOperation[],
  staging: ImportBindOnlyStaging | null,
  options?: { failFast?: boolean },
): Promise<readonly EngineApplyOutcome[]> {
  if (!staging || staging.chunks.length === 0) {
    return executor.applyAll(batch, options);
  }

  const { inserts, tail } = partitionImportBatch(batch);
  const insertOutcomes = inserts.length > 0 ? await executor.applyAll(inserts, options) : [];

  const insertFailed = insertOutcomes.find((o) => !o.ok);
  if (insertFailed) {
    return insertOutcomes;
  }

  const mutationError = firstApplyOutcomeError(insertOutcomes);
  if (mutationError) {
    return insertOutcomes;
  }

  const insertResults = insertOutcomes.map((o) => o.result).filter(isInsertManyOutcome) as Array<{
    readonly op: 'insertMany';
    readonly model: string;
    readonly records?: readonly Record<string, unknown>[];
  }>;

  const lookupOps = buildBindImportLookupOps(staging, insertResults);
  const lookupOutcomes = lookupOps.length > 0 ? await executor.applyAll(lookupOps, options) : [];

  const lookupFailed = lookupOutcomes.find((o) => !o.ok);
  if (lookupFailed) {
    return [...insertOutcomes, ...lookupOutcomes];
  }

  const tailOutcomes = tail.length > 0 ? await executor.applyAll(tail, options) : [];
  return [...insertOutcomes, ...lookupOutcomes, ...tailOutcomes];
}

export function handleImportCommitFailure(
  batch: readonly EngineOperation[],
  outcomes: readonly EngineApplyOutcome[],
): {
  readonly pendingOps: readonly EngineOperation[];
  readonly importFailures: ReturnType<typeof extractInsertManyFailures>;
  readonly inserted: number;
  readonly error: string | null;
} {
  const mutationError = firstApplyOutcomeError(outcomes);
  if (!mutationError) {
    return { pendingOps: [], importFailures: [], inserted: 0, error: null };
  }
  const failures = extractInsertManyFailures(batch, outcomes);
  const inserted = countInsertManySuccesses(outcomes);
  const pendingOps =
    failures.length > 0
      ? stripRelationBindOps(rebuildPendingAfterInsertManyFailures(batch, outcomes))
      : batch;
  return { pendingOps, importFailures: failures, inserted, error: mutationError };
}

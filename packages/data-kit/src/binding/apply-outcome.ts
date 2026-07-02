import type { EngineApplyOutcome } from '@mode-db/shared';

/** Picks only schema prop keys for engine insert payloads. */
export function pickPropFields(
  row: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of fields) {
    if (Object.prototype.hasOwnProperty.call(row, key)) {
      out[key] = row[key];
    }
  }
  return out;
}

/** Returns an error message when a mutation result indicates failure despite wire ok. */
export function mutationOutcomeError(result: unknown): string | null {
  if (typeof result !== 'object' || result === null || !('op' in result)) {
    return null;
  }
  const op = (result as { op: unknown }).op;
  if (op === 'insertMany') {
    const r = result as { successCount?: number; failureCount?: number; model?: string };
    const success = r.successCount ?? 0;
    const failure = r.failureCount ?? 0;
    if (failure > 0 && success === 0) {
      return `insertMany(${r.model ?? '?'}): all ${failure} row(s) failed validation — check column mapping and field types.`;
    }
    if (failure > 0) {
      return `insertMany(${r.model ?? '?'}): ${failure} row(s) failed, ${success} succeeded.`;
    }
    if (success === 0) {
      return `insertMany(${r.model ?? '?'}): no rows were inserted.`;
    }
    return null;
  }
  if (op === 'bind' || op === 'bindPair') {
    const r = result as { ok?: boolean; relation?: string };
    if (r.ok === false) {
      return `Relation bind failed (${r.relation ?? 'unknown'}).`;
    }
    return null;
  }
  if (op === 'batchUpdate' || op === 'batchDelete') {
    const r = result as { successCount?: number; failureCount?: number; ok?: boolean };
    if (r.ok === false) {
      return `${String(op)} failed.`;
    }
    const failure = r.failureCount ?? 0;
    const success = r.successCount ?? 0;
    if (failure > 0 && success === 0) {
      return `${String(op)}: all operations failed.`;
    }
  }
  return null;
}

/** Validates applyAll outcomes; returns first error message or null when all mutations succeeded. */
export function firstApplyOutcomeError(outcomes: readonly EngineApplyOutcome[]): string | null {
  for (const outcome of outcomes) {
    if (!outcome.ok) {
      return outcome.error ?? 'applyAll failed';
    }
    const mutationErr = mutationOutcomeError(outcome.result);
    if (mutationErr) {
      return mutationErr;
    }
  }
  return null;
}

/** Summarizes insertMany success counts across a batch commit. */
export function summarizeInsertManyOutcomes(outcomes: readonly EngineApplyOutcome[]): {
  inserted: number;
  failed: number;
} {
  let inserted = 0;
  let failed = 0;
  for (const outcome of outcomes) {
    if (!outcome.ok) {
      continue;
    }
    const r = outcome.result;
    if (
      typeof r === 'object' &&
      r !== null &&
      'op' in r &&
      (r as { op: string }).op === 'insertMany'
    ) {
      inserted += (r as { successCount?: number }).successCount ?? 0;
      failed += (r as { failureCount?: number }).failureCount ?? 0;
    }
  }
  return { inserted, failed };
}

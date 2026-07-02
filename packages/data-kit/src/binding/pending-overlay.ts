import type { EngineDatabaseOperation, EngineOperation } from '@mode-db/shared';
import { isDatabaseOperation } from '@mode-db/shared';

import type { EntityRowRef } from '../view-data/view-data-shape.js';

function isUpdateOp(
  op: EngineDatabaseOperation,
): op is Extract<EngineDatabaseOperation, { op: 'update' }> {
  return op.op === 'update';
}

function isDeleteOp(
  op: EngineDatabaseOperation,
): op is Extract<EngineDatabaseOperation, { op: 'delete' }> {
  return op.op === 'delete';
}

function rowKey(ref: EntityRowRef): string {
  return `${ref.model}\0${ref.id}`;
}

/**
 * Applies staged update ops onto row copies for optimistic table display before commit.
 */
export function overlayPendingEdits(
  rows: readonly Record<string, unknown>[],
  rowRefs: readonly (EntityRowRef | null)[] | undefined,
  pendingOps: readonly EngineOperation[],
): Record<string, unknown>[] {
  if (!rowRefs || pendingOps.length === 0) {
    return rows.map((r) => ({ ...r }));
  }

  const patches = new Map<string, Record<string, unknown>>();
  for (const op of pendingOps) {
    if (!isDatabaseOperation(op) || !isUpdateOp(op)) {
      continue;
    }
    const key = rowKey({ model: op.model, id: op.id });
    const prev = patches.get(key) ?? {};
    patches.set(key, { ...prev, ...op.partial });
  }

  return rows.map((row, i) => {
    const ref = rowRefs[i];
    if (!ref) {
      return { ...row };
    }
    const patch = patches.get(rowKey(ref));
    return patch ? { ...row, ...patch } : { ...row };
  });
}

/** Row indices marked for deletion by pending delete ops. */
export function pendingDeleteRowIndices(
  rowRefs: readonly (EntityRowRef | null)[] | undefined,
  pendingOps: readonly EngineOperation[],
): Set<number> {
  const out = new Set<number>();
  if (!rowRefs) {
    return out;
  }

  const deleted = new Set<string>();
  for (const op of pendingOps) {
    if (!isDatabaseOperation(op) || !isDeleteOp(op)) {
      continue;
    }
    deleted.add(rowKey({ model: op.model, id: op.id }));
  }

  rowRefs.forEach((ref, index) => {
    if (ref && deleted.has(rowKey(ref))) {
      out.add(index);
    }
  });
  return out;
}

/** Whether a pending update op targets the same cell. */
export function isUpdateForCell(op: EngineOperation, ref: EntityRowRef, column: string): boolean {
  if (!isDatabaseOperation(op) || !isUpdateOp(op)) {
    return false;
  }
  return op.model === ref.model && op.id === ref.id && column in op.partial;
}

/** Whether a pending delete op targets the same row. */
export function isDeleteForRow(op: EngineOperation, ref: EntityRowRef): boolean {
  if (!isDatabaseOperation(op) || !isDeleteOp(op)) {
    return false;
  }
  return op.model === ref.model && op.id === ref.id;
}

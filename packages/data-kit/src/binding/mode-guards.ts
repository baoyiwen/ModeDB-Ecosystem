import type { EngineDatabaseOperation, EngineOperation } from '@mode-db/shared';
import { isDatabaseOperation } from '@mode-db/shared';

import type { DataPageMutationMode } from '../page-mode.js';

const DELETE_OPS = new Set<string>(['delete', 'batchDelete']);
const EDIT_OPS = new Set<string>([
  'insert',
  'update',
  'insertMany',
  'batchUpdate',
  'bindPair',
  'bindImportLookup',
  'unlinkPair',
  'bind',
]);

export class BindingModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BindingModeError';
  }
}

/** Validates that an operation is allowed in the current page mode. */
export function assertOpAllowedForMode(op: EngineOperation, mode: DataPageMutationMode): void {
  if (!isDatabaseOperation(op)) {
    throw new BindingModeError(
      `Workspace-scoped operation "${op.op}" cannot be staged in a data page binding session.`,
    );
  }
  assertDatabaseOpAllowedForMode(op, mode);
}

function assertDatabaseOpAllowedForMode(
  op: EngineDatabaseOperation,
  mode: DataPageMutationMode,
): void {
  if (mode === 'delete') {
    if (!DELETE_OPS.has(op.op)) {
      throw new BindingModeError(
        `Operation "${op.op}" is not allowed in delete mode (use delete / batchDelete).`,
      );
    }
    return;
  }
  if (DELETE_OPS.has(op.op)) {
    throw new BindingModeError(
      `Operation "${op.op}" is not allowed in edit mode (switch to delete mode).`,
    );
  }
  if (!EDIT_OPS.has(op.op)) {
    throw new BindingModeError(`Operation "${op.op}" is not allowed in edit mode.`);
  }
}

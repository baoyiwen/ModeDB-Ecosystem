/**
 * Unified, public **engine operation protocol** (JSON) — the Designer-facing contract.
 *
 * Every engine action (DB CRUD, model / relation CRUD, row CRUD, bind, query) has a JSON shape here,
 * so Model Designer / Query Designer can serialize a configuration and run it via `apply(op)` /
 * `applyAll(ops)` — in addition to the existing fluent/functional API ("dual support").
 *
 * Two scopes:
 * - **database** ({@link EngineDatabaseOperation}): runs against one logical library (engine). These are
 *   exactly the {@link WireExecuteBody} variants already understood by the WebSocket host.
 * - **workspace** ({@link EngineWorkspaceOperation}): runs against the workspace (create / drop / list a
 *   logical library, read its catalog). Routed through the management surface, not the per-atlas RPC.
 */

import type { ManagementCatalogResponse, ManagementDatabaseInfo } from './management-types.js';
import type { WireExecuteBody, WireExecuteResultJson } from './wire-protocol-exports.js';

/** Engine-scoped operation (insert / update / registerModel / bind / executeQuery / ...). */
export type EngineDatabaseOperation = WireExecuteBody;

/** Workspace-scoped operation (create / drop / list a logical library, read catalog). */
export type EngineWorkspaceOperation =
  | { readonly op: 'createDatabase'; readonly name: string }
  | { readonly op: 'dropDatabase'; readonly name: string }
  | { readonly op: 'listDatabases' }
  | { readonly op: 'catalog'; readonly database: string };

/** Any engine operation, discriminated by **`op`**. */
export type EngineOperation = EngineDatabaseOperation | EngineWorkspaceOperation;

/** Per-operation outcome for {@link EngineOperation} batches (`applyAll`). */
export interface EngineApplyOutcome {
  readonly ok: boolean;
  readonly result?: EngineOperationResult;
  readonly error?: string;
}

/** JSON-safe result of an {@link EngineOperation} (superset of {@link WireExecuteResultJson}). */
export type EngineOperationResult =
  | WireExecuteResultJson
  | { readonly kind: 'databases'; readonly databases: readonly ManagementDatabaseInfo[] }
  | {
      readonly kind: 'database';
      readonly op: 'createDatabase' | 'dropDatabase';
      readonly name: string;
      readonly ok: true;
    }
  | ({ readonly kind: 'catalog' } & ManagementCatalogResponse);

/** All recognized workspace-scope op names. */
export const WORKSPACE_OP_NAMES: ReadonlySet<string> = new Set([
  'createDatabase',
  'dropDatabase',
  'listDatabases',
  'catalog',
]);

/** All recognized database-scope op names. */
export const DATABASE_OP_NAMES: ReadonlySet<string> = new Set([
  'executeQuery',
  'insert',
  'update',
  'insertMany',
  'batchUpdate',
  'delete',
  'batchDelete',
  'dropModel',
  'dropRelation',
  'alterModel',
  'registerModel',
  'registerRelation',
  'batchRegister',
  'bindPair',
  'unlinkPair',
  'bind',
  'previewBind',
  'relationStats',
  'updateRelationLogic',
  'clearModelData',
  'clearAllData',
]);

/** Database-scope ops that mutate state (drive the server write-serialization gate). */
const MUTATING_DATABASE_OPS: ReadonlySet<string> = new Set([
  'insert',
  'update',
  'insertMany',
  'batchUpdate',
  'delete',
  'batchDelete',
  'dropModel',
  'dropRelation',
  'alterModel',
  'registerModel',
  'registerRelation',
  'batchRegister',
  'bindPair',
  'unlinkPair',
  'bind',
  'updateRelationLogic',
  'clearModelData',
  'clearAllData',
]);

/** Classify an operation's execution scope. */
export function operationScope(op: EngineOperation): 'workspace' | 'database' {
  return WORKSPACE_OP_NAMES.has(op.op) ? 'workspace' : 'database';
}

/** Narrow to a workspace-scope operation. */
export function isWorkspaceOperation(op: EngineOperation): op is EngineWorkspaceOperation {
  return WORKSPACE_OP_NAMES.has(op.op);
}

/** Narrow to a database-scope operation. */
export function isDatabaseOperation(op: EngineOperation): op is EngineDatabaseOperation {
  return DATABASE_OP_NAMES.has(op.op);
}

/** Whether a database-scope op mutates state (read ops: executeQuery / previewBind / relationStats). */
export function isMutatingDatabaseOperation(op: EngineDatabaseOperation): boolean {
  return MUTATING_DATABASE_OPS.has(op.op);
}

/** Structural guard for untrusted Designer JSON: shallow-validates the **`op`** discriminator + required keys. */
export function isEngineOperation(x: unknown): x is EngineOperation {
  if (typeof x !== 'object' || x === null) {
    return false;
  }
  const op = (x as { op?: unknown }).op;
  if (typeof op !== 'string') {
    return false;
  }
  if (!WORKSPACE_OP_NAMES.has(op) && !DATABASE_OP_NAMES.has(op)) {
    return false;
  }
  const rec = x as Record<string, unknown>;
  switch (op) {
    case 'createDatabase':
    case 'dropDatabase':
      return typeof rec.name === 'string' && rec.name.length > 0;
    case 'catalog':
      return typeof rec.database === 'string' && rec.database.length > 0;
    case 'listDatabases':
      return true;
    default:
      // Database-scope op names are validated structurally by the executor / server dispatch.
      return true;
  }
}

/** Throwing variant of {@link isEngineOperation}. */
export function assertEngineOperation(x: unknown): asserts x is EngineOperation {
  if (!isEngineOperation(x)) {
    const op = (x as { op?: unknown } | null)?.op;
    throw new Error(
      `Invalid EngineOperation: ${typeof op === 'string' ? `unknown or malformed op "${op}"` : 'missing "op" discriminator'}.`,
    );
  }
}

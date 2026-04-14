import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DiagnosticCenter, ErrorCodes } from '@mode-db/common';

/**
 * Require a logical database to exist on disk before accepting a session:
 * **`${workspace}/${dbName}/atlas.mld`** (single-file vault).
 */
export function assertLogicalDatabaseExists(workspaceRoot: string, logicalDb: string): void {
  const root = resolve(workspaceRoot);
  const vaultPath = join(root, logicalDb, 'atlas.mld');
  if (existsSync(vaultPath)) {
    return;
  }
  DiagnosticCenter.report(
    ErrorCodes.DATABASE_NOT_FOUND,
    { dbName: logicalDb, path: vaultPath },
    'throw',
  );
}

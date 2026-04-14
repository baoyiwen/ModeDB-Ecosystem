import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DiagnosticCenter, ErrorCodes, PathResolver } from '@mode-db/common';

/**
 * Require a logical database to exist on disk before accepting a session.
 * Accepts workspace-flat **`${workspace}/${dbName}.mld`** or legacy nested **`${workspace}/${dbName}/atlas.mld`**.
 */
export function assertLogicalDatabaseExists(workspaceRoot: string, logicalDb: string): void {
  const root = resolve(workspaceRoot);
  const flat = PathResolver.workspaceFlatVaultPath(root, logicalDb);
  const nested = join(root, logicalDb, 'atlas.mld');
  if (existsSync(flat) || existsSync(nested)) {
    return;
  }
  DiagnosticCenter.report(
    ErrorCodes.DATABASE_NOT_FOUND,
    { dbName: logicalDb, path: flat },
    'throw',
  );
}

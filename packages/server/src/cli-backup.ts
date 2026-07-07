import { AuthoringEngine } from '@mode-db/core';
import { assertFlatGraphSegment } from '@mode-db/common';
import {
  createDatabaseBackup,
  forceResetDatabase,
  listDatabaseBackups,
  restoreDatabaseBackup,
} from './backup-manager.js';
import { loadModelDBServerConfig } from './config-loader.js';
import { assertLogicalDatabaseExists } from './logical-database-guard.js';

export function parseBackupArgv(argv: string[]): {
  readonly config?: string;
  readonly token?: string;
  readonly reason?: string;
  readonly yes: boolean;
} {
  const out: { config?: string; token?: string; reason?: string; yes: boolean } = { yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-c' || a === '--config') {
      out.config = argv[++i];
    } else if (a.startsWith('--config=')) {
      out.config = a.slice('--config='.length);
    } else if (a === '-t' || a === '--token') {
      out.token = argv[++i];
    } else if (a.startsWith('--token=')) {
      out.token = a.slice('--token='.length);
    } else if (a === '--reason') {
      out.reason = argv[++i];
    } else if (a.startsWith('--reason=')) {
      out.reason = a.slice('--reason='.length);
    } else if (a === '-y' || a === '--yes') {
      out.yes = true;
    }
  }
  return out;
}

function formatBytes(n: number): string {
  if (n < 1024) {
    return `${n} B`;
  }
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(1)}KB`;
  }
  if (n < 1024 ** 3) {
    return `${(n / 1024 ** 2).toFixed(1)}MB`;
  }
  return `${(n / 1024 ** 3).toFixed(1)}GB`;
}

async function loadCliConfig(
  argv: string[],
): Promise<Awaited<ReturnType<typeof loadModelDBServerConfig>>> {
  const parsed = parseBackupArgv(argv);
  return loadModelDBServerConfig(parsed.config, {
    connectToken:
      parsed.token !== undefined && String(parsed.token).trim() !== ''
        ? String(parsed.token).trim()
        : undefined,
  });
}

function requireYes(yes: boolean, action: string): void {
  if (!yes) {
    throw new Error(`${action} is destructive. Re-run with --yes to confirm.`);
  }
}

export async function runBackup(dbName: string, argv: string[]): Promise<void> {
  assertFlatGraphSegment(dbName, 'database name');
  const opts = parseBackupArgv(argv);
  const cfg = await loadCliConfig(argv);
  assertLogicalDatabaseExists(cfg.storageRoot, dbName);
  const engine = new AuthoringEngine({
    atlas: dbName,
    storageRoot: cfg.storageRoot,
    connectToken: cfg.connectToken,
  });
  await engine.flushAll();
  const backup = createDatabaseBackup(cfg.storageRoot, dbName, opts.reason ?? 'manual');
  console.log(`Backup created: ${backup.fileName}`);
  console.log(`Database: ${backup.database}`);
  console.log(`Bytes: ${formatBytes(backup.bytes)}`);
  console.log(`Path: ${backup.path}`);
}

export async function runBackups(dbName: string | undefined, argv: string[]): Promise<void> {
  if (dbName) {
    assertFlatGraphSegment(dbName, 'database name');
  }
  const cfg = await loadCliConfig(argv);
  const backups = listDatabaseBackups(cfg.storageRoot, dbName);
  if (backups.length === 0) {
    console.log(dbName ? `No backups for ${dbName}.` : 'No backups.');
    return;
  }
  for (const backup of backups) {
    console.log(
      `${backup.fileName}\t${backup.database}\t${backup.createdAt}\t${formatBytes(backup.bytes)}`,
    );
  }
}

export async function runRestore(
  dbName: string,
  backupFile: string,
  argv: string[],
): Promise<void> {
  assertFlatGraphSegment(dbName, 'database name');
  const opts = parseBackupArgv(argv);
  requireYes(opts.yes, 'restore');
  const cfg = await loadCliConfig(argv);
  try {
    const safety = createDatabaseBackup(cfg.storageRoot, dbName, 'pre-restore');
    console.log(`Safety backup created: ${safety.fileName}`);
  } catch (e) {
    console.warn(`Safety backup skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
  const restored = restoreDatabaseBackup(cfg.storageRoot, dbName, backupFile);
  const engine = new AuthoringEngine({
    atlas: dbName,
    storageRoot: cfg.storageRoot,
    connectToken: cfg.connectToken,
  });
  await engine.flushAll();
  console.log(`Restored ${dbName} from ${restored.fileName}.`);
}

export async function runClearData(dbName: string, argv: string[]): Promise<void> {
  assertFlatGraphSegment(dbName, 'database name');
  const opts = parseBackupArgv(argv);
  requireYes(opts.yes, 'clear-data');
  const cfg = await loadCliConfig(argv);
  assertLogicalDatabaseExists(cfg.storageRoot, dbName);
  try {
    const safety = createDatabaseBackup(cfg.storageRoot, dbName, 'pre-clear');
    console.log(`Safety backup created: ${safety.fileName}`);
  } catch (e) {
    console.warn(`Safety backup skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
  const engine = new AuthoringEngine({
    atlas: dbName,
    storageRoot: cfg.storageRoot,
    connectToken: cfg.connectToken,
  });
  const result = await engine.clearAllData({ sync: true });
  console.log(`Cleared ${result.totalDeleted} row(s) from ${dbName}.`);
}

export async function runForceReset(dbName: string, argv: string[]): Promise<void> {
  assertFlatGraphSegment(dbName, 'database name');
  const opts = parseBackupArgv(argv);
  requireYes(opts.yes, 'force-reset');
  const cfg = await loadCliConfig(argv);
  try {
    const safety = createDatabaseBackup(cfg.storageRoot, dbName, 'pre-reset');
    console.log(`Safety backup created: ${safety.fileName}`);
  } catch (e) {
    console.warn(`Safety backup skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
  forceResetDatabase(cfg.storageRoot, dbName);
  const engine = new AuthoringEngine({
    atlas: dbName,
    storageRoot: cfg.storageRoot,
    connectToken: cfg.connectToken,
  });
  await engine.flushAll();
  console.log(`Force-reset database ${dbName}.`);
}

import { AuthoringEngine } from '@mode-db/core';
import { assertFlatGraphSegment, PathResolver } from '@mode-db/common';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  createDatabaseBackup,
  forceResetDatabase,
  listDatabaseBackups,
  restoreDatabaseBackup,
  verifyDatabaseBackup,
} from './backup-manager.js';
import { loadModelDBServerConfig, type ResolvedModelDBServerConfig } from './config-loader.js';
import { serverVaultKeys } from './security/server-vault-keys.js';
import { SecurityRegistry } from './security/security-registry.js';
import { SecurityError } from './security/security-errors.js';
import { assertLogicalDatabaseExists } from './logical-database-guard.js';

export function parseBackupArgv(argv: string[]): {
  config?: string;
  token?: string;
  reason?: string;
  yes: boolean;
} {
  const out: { config?: string; token?: string; reason?: string; yes: boolean } = { yes: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '-c' || arg === '--config') {
      out.config = argv[++i];
    } else if (arg.startsWith('--config=')) {
      out.config = arg.slice(9);
    } else if (arg === '-t' || arg === '--token') {
      out.token = argv[++i];
    } else if (arg.startsWith('--token=')) {
      out.token = arg.slice(8);
    } else if (arg === '--reason') {
      out.reason = argv[++i];
    } else if (arg.startsWith('--reason=')) {
      out.reason = arg.slice(9);
    } else if (arg === '-y' || arg === '--yes') {
      out.yes = true;
    } else {
      throw new SecurityError('SECURITY_INVALID_REQUEST');
    }
  }
  return out;
}
async function offline<T>(
  argv: string[],
  work: (cfg: ResolvedModelDBServerConfig) => Promise<T>,
): Promise<T> {
  const opts = parseBackupArgv(argv);
  if (!opts.config) {
    throw new SecurityError('SECURITY_INVALID_REQUEST');
  }
  const cfg = await loadModelDBServerConfig(opts.config, { connectToken: opts.token });
  let registry: SecurityRegistry | undefined;
  if (cfg.securityMode === 'registry') {
    const directory = join(dirname(cfg.configFilePath), 'security');
    if (!existsSync(join(directory, 'registry.mds'))) {
      throw new SecurityError('SECURITY_NOT_FOUND');
    }
    registry = SecurityRegistry.open(directory, {
      auditLimit: cfg.securityAudit.maxEvents,
      auditRetentionDays: cfg.securityAudit.retentionDays,
    });
  }
  try {
    registry?.recordMaintenance('backup.task.started');
    const result = await work(cfg);
    registry?.recordMaintenance('backup.task.completed');
    return result;
  } catch (error) {
    try {
      registry?.recordMaintenance('backup.task.failed');
    } catch {
      /* Preserve the original failure. */
    }
    throw error;
  } finally {
    registry?.close();
  }
}
function requireYes(argv: string[]): void {
  if (!parseBackupArgv(argv).yes) {
    throw new SecurityError('SECURITY_CONFIRMATION_REQUIRED');
  }
}
function engineFor(cfg: ResolvedModelDBServerConfig, database: string): AuthoringEngine {
  return new AuthoringEngine({
    atlas: database,
    storageRoot: cfg.storageRoot,
    paths: existsSync(PathResolver.workspaceFlatVaultPath(cfg.storageRoot, database))
      ? new PathResolver(cfg.storageRoot, database, { workspaceFlatVault: true })
      : undefined,
    keyProvider: serverVaultKeys(cfg),
    engineLogger: false,
  });
}
export async function runBackup(database: string, argv: string[]): Promise<void> {
  assertFlatGraphSegment(database, 'database');
  const result = await offline(argv, async (cfg) => {
    assertLogicalDatabaseExists(cfg.storageRoot, database);
    const engine = engineFor(cfg, database);
    try {
      await engine.flushAll();
      const backup = createDatabaseBackup(
        cfg.storageRoot,
        database,
        parseBackupArgv(argv).reason,
        undefined,
        serverVaultKeys(cfg),
      );
      return { ok: true, backup };
    } finally {
      await engine.dispose();
    }
  });
  process.stdout.write(JSON.stringify(result) + '\n');
}
export async function runBackups(database: string | undefined, argv: string[]): Promise<void> {
  const result = await offline(argv, async (cfg) => ({
    backups: listDatabaseBackups(cfg.storageRoot, database, serverVaultKeys(cfg)),
  }));
  process.stdout.write(JSON.stringify(result) + '\n');
}
export async function runRestore(database: string, file: string, argv: string[]): Promise<void> {
  assertFlatGraphSegment(database, 'database');
  requireYes(argv);
  const result = await offline(argv, async (cfg) => {
    const keys = serverVaultKeys(cfg);
    verifyDatabaseBackup(cfg.storageRoot, file, keys);
    let safetyBackup;
    if (
      existsSync(join(cfg.storageRoot, database, 'atlas.mld')) ||
      existsSync(join(cfg.storageRoot, database + '.mld'))
    ) {
      const engine = engineFor(cfg, database);
      try {
        await engine.flushAll();
        safetyBackup = createDatabaseBackup(
          cfg.storageRoot,
          database,
          'pre-restore',
          undefined,
          keys,
        );
      } finally {
        await engine.dispose();
      }
    }
    const restored = restoreDatabaseBackup(cfg.storageRoot, database, file, keys);
    const engine = engineFor(cfg, database);
    try {
      await engine.flushAll();
    } finally {
      await engine.dispose();
    }
    return { ok: true, restored, safetyBackup };
  });
  process.stdout.write(JSON.stringify(result) + '\n');
}
export async function runClearData(database: string, argv: string[]): Promise<void> {
  assertFlatGraphSegment(database, 'database');
  requireYes(argv);
  const output = await offline(argv, async (cfg) => {
    assertLogicalDatabaseExists(cfg.storageRoot, database);
    const engine = engineFor(cfg, database);
    try {
      await engine.flushAll();
      const safetyBackup = createDatabaseBackup(
        cfg.storageRoot,
        database,
        'pre-clear',
        undefined,
        serverVaultKeys(cfg),
      );
      const result = await engine.clearAllData({ sync: true });
      return { ok: true, deletedCount: result.totalDeleted, safetyBackup };
    } finally {
      await engine.dispose();
    }
  });
  process.stdout.write(JSON.stringify(output) + '\n');
}
export async function runForceReset(database: string, argv: string[]): Promise<void> {
  assertFlatGraphSegment(database, 'database');
  requireYes(argv);
  const result = await offline(argv, async (cfg) => {
    let safetyBackup;
    try {
      safetyBackup = createDatabaseBackup(
        cfg.storageRoot,
        database,
        'pre-reset',
        undefined,
        serverVaultKeys(cfg),
      );
    } catch {
      /* Explicit force reset remains available for corrupt or missing Vaults. */
    }
    forceResetDatabase(cfg.storageRoot, database);
    const engine = engineFor(cfg, database);
    try {
      await engine.flushAll();
    } finally {
      await engine.dispose();
    }
    return { ok: true, database, safetyBackup };
  });
  process.stdout.write(JSON.stringify(result) + '\n');
}

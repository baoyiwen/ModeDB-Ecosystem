import { EngineLogger, type VaultKeyProvider } from '@mode-db/common';
import type { WriteSerializationGate } from './write-serialization-gate.js';
import type { AuthoringBridge } from './authoring-bridge.js';
import { createDatabaseBackup } from './backup-manager.js';
import type { ResolvedModelDBServerAutoBackupConfig } from './config-loader.js';
import { scanWorkspaceDatabases } from './management-api.js';
import type { SecurityRegistry } from './security/security-registry.js';

export interface AutoBackupScheduler {
  readonly stop: () => void;
}

function selectedDatabases(
  dataRoot: string,
  cfg: ResolvedModelDBServerAutoBackupConfig,
): readonly string[] {
  if (cfg.databases && cfg.databases.length > 0) {
    return cfg.databases;
  }
  return scanWorkspaceDatabases(dataRoot).map((d) => d.name);
}

export function startAutoBackupScheduler(
  dataRoot: string,
  cfg: ResolvedModelDBServerAutoBackupConfig | undefined,
  authoring: AuthoringBridge,
  keys: VaultKeyProvider,
  gate: WriteSerializationGate,
  registry?: SecurityRegistry,
): AutoBackupScheduler | undefined {
  if (!cfg?.enabled) {
    return undefined;
  }

  let running = false;
  let stopped = false;

  const runOnce = async (): Promise<void> => {
    if (running || stopped) {
      return;
    }
    running = true;
    try {
      const databases = selectedDatabases(dataRoot, cfg);
      EngineLogger.instance.info(
        'Automatic backup pass started',
        { databases, reason: cfg.reason },
        'ModelDBAutoBackup',
      );
      for (const database of databases) {
        try {
          const backup = await gate.runExclusive(database, async () => {
            registry?.recordMaintenance('backup.task.started');
            const engine = await authoring.getEngine(database);
            await engine.flushAll();
            const created = createDatabaseBackup(dataRoot, database, cfg.reason, undefined, keys);
            registry?.recordMaintenance('backup.task.completed');
            return created;
          });
          EngineLogger.instance.info(
            'Automatic backup created',
            { database, fileName: backup.fileName, bytes: backup.bytes },
            'ModelDBAutoBackup',
          );
        } catch {
          try {
            registry?.recordMaintenance('backup.task.failed');
          } catch {
            /* Audit capacity remains fail-closed. */
          }
          EngineLogger.instance.warn(
            'Automatic backup failed for database',
            { database, code: 'SECURITY_MAINTENANCE_FAILED' },
            'ModelDBAutoBackup',
          );
        }
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void runOnce();
  }, cfg.intervalMs);
  timer.unref?.();

  EngineLogger.instance.info(
    'Automatic backup scheduler enabled',
    {
      intervalMs: cfg.intervalMs,
      databases: cfg.databases ?? 'all',
      runOnStart: cfg.runOnStart,
      reason: cfg.reason,
    },
    'ModelDBAutoBackup',
  );

  if (cfg.runOnStart) {
    void runOnce();
  }

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

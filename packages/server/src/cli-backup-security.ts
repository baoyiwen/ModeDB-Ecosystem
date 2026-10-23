import { createPublicKey } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { assertFlatGraphSegment } from '@mode-db/common';
import {
  createDatabaseBackup,
  importMigrationBackup,
  readBackupBytes,
  readDatabaseBackupFile,
} from './backup-manager.js';
import { loadModelDBServerConfig } from './config-loader.js';
import { backupRecipientId } from './security/backup-package.js';
import { createMigrationKey, openMigrationKey } from './security/migration-key.js';
import { assertRecoveryPath, readRecoveryPassphraseFile } from './security/recovery-material.js';
import { LocalVaultKeyProvider } from './security/local-vault-key-provider.js';
import { SecurityRegistry } from './security/security-registry.js';
import { SecurityError } from './security/security-errors.js';
import { WindowsSecretProtector } from './security/windows-secret-protector.js';
import { AuthoringBridge } from './authoring-bridge.js';

export async function runBackupSecurityCli(argv: string[]): Promise<void> {
  const action = argv[0],
    options = new Map<string, string>();
  let yes = false;
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === '--yes') {
      if (yes) {
        throw new SecurityError('SECURITY_INVALID_REQUEST');
      }
      yes = true;
      continue;
    }
    if (
      ![
        '-c',
        '--config',
        '--instance',
        '--database',
        '--output',
        '--public-key',
        '--private-key',
        '--package',
        '--passphrase-file',
      ].includes(arg) ||
      !argv[index + 1] ||
      options.has(arg)
    ) {
      throw new SecurityError('SECURITY_INVALID_REQUEST');
    }
    options.set(arg, argv[++index]!);
  }
  const required = (name: string): string => {
    const value = options.get(name);
    if (!value) {
      throw new SecurityError('SECURITY_INVALID_REQUEST');
    }
    return value;
  };
  const protector = new WindowsSecretProtector();
  const passphrase = () =>
    readRecoveryPassphraseFile(required('--passphrase-file'), (path) =>
      protector.ensureDirectory(path),
    );
  const writeNew = (path: string, bytes: string | Buffer): void => {
    assertRecoveryPath(path);
    protector.ensureDirectory(dirname(resolve(path)));
    const fd = openSync(path, 'wx', 0o600);
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
  if (action === 'backup-key-create') {
    const prefix = assertRecoveryPath(required('--output'));
    if (existsSync(prefix + '.public.pem') || existsSync(prefix + '.private.json')) {
      throw new SecurityError('SECURITY_INVALID_REQUEST');
    }
    const key = createMigrationKey(passphrase());
    writeNew(prefix + '.private.json', key.privateKey);
    writeNew(prefix + '.public.pem', key.publicKey);
    process.stdout.write(
      JSON.stringify({
        recipientId: key.recipientId,
        publicKeyFile: prefix + '.public.pem',
        privateKeyFile: prefix + '.private.json',
      }) + '\n',
    );
    return;
  }
  const config = options.get('-c') ?? options.get('--config');
  if (options.has('-c') && options.has('--config')) {
    throw new SecurityError('SECURITY_INVALID_REQUEST');
  }
  if (!config || !yes || !options.get('--instance')) {
    throw new SecurityError('SECURITY_CONFIRMATION_REQUIRED');
  }
  const cfg = await loadModelDBServerConfig(config, {});
  if (cfg.securityMode !== 'registry') {
    throw new SecurityError('SECURITY_INVALID_CONFIG');
  }
  const directory = assertRecoveryPath(join(dirname(cfg.configFilePath), 'security'));
  if (!existsSync(join(directory, 'registry.mds'))) {
    throw new SecurityError('SECURITY_NOT_FOUND');
  }
  const registry = SecurityRegistry.open(directory, {
    auditLimit: cfg.securityAudit.maxEvents,
    auditRetentionDays: cfg.securityAudit.retentionDays,
  });
  try {
    if (registry.status().instanceId !== required('--instance')) {
      throw new SecurityError('SECURITY_CONFIRMATION_REQUIRED');
    }
    const provider = new LocalVaultKeyProvider(directory),
      database = required('--database');
    assertFlatGraphSegment(database, 'database');
    registry.recordMaintenance('backup.task.started');
    let result: unknown;
    if (action === 'backup-export') {
      const output = assertRecoveryPath(required('--output'));
      const inside = (parent: string): boolean => {
        const rel = relative(assertRecoveryPath(parent), output);
        return (
          rel === '' ||
          (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../'))
        );
      };
      // Independent delivery files stay outside both the security store and source data tree.
      if (inside(directory) || inside(cfg.storageRoot) || existsSync(output)) {
        throw new SecurityError('SECURITY_INVALID_REQUEST');
      }
      const recipient = createPublicKey(readBackupBytes(required('--public-key'), 8192));
      const authoring = new AuthoringBridge(cfg.storageRoot, provider);
      let backup;
      try {
        const engine = await authoring.getEngine(database);
        await engine.flushAll();
        backup = createDatabaseBackup(
          cfg.storageRoot,
          database,
          'migration',
          undefined,
          provider,
          recipient,
        );
      } finally {
        await authoring.close();
      }
      const file = readDatabaseBackupFile(cfg.storageRoot, backup.fileName, provider);
      writeNew(output, file.content);
      result = { ok: true, recipientId: backupRecipientId(recipient), backup };
    } else if (action === 'backup-import') {
      const privatePath = assertRecoveryPath(required('--private-key'));
      protector.ensureDirectory(dirname(privatePath));
      const key = openMigrationKey(readBackupBytes(privatePath, 16384), passphrase());
      const backup = importMigrationBackup(
        cfg.storageRoot,
        database,
        readBackupBytes(required('--package')),
        key,
        provider,
      );
      result = { ok: true, imported: backup, restored: false };
    } else {
      throw new SecurityError('SECURITY_INVALID_REQUEST');
    }
    registry.recordMaintenance('backup.task.completed');
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    try {
      registry.recordMaintenance('backup.task.failed');
    } catch {
      /* Preserve the original failure. */
    }
    throw error;
  } finally {
    registry.close();
  }
}

import { closeSync, existsSync, fsyncSync, openSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { assertFlatGraphSegment, fileDigest } from '@mode-db/common';
import {
  createDatabaseBackup,
  importMigrationBackup,
  readBackupBytes,
  readDatabaseBackupFile,
} from './backup-manager.js';
import { loadModelDBServerConfig } from './config-loader.js';
import { backupRecipientId, MAX_BACKUP_VAULT_BYTES } from './security/backup-package.js';
import { createMigrationKey, openMigrationKey } from './security/migration-key.js';
import { assertRecoveryPath, readRecoveryPassphraseFile } from './security/recovery-material.js';
import { LocalVaultKeyProvider } from './security/local-vault-key-provider.js';
import { SecurityRegistry } from './security/security-registry.js';
import { SecurityError } from './security/security-errors.js';
import { WindowsSecretProtector } from './security/windows-secret-protector.js';
import { AuthoringBridge } from './authoring-bridge.js';
import { selectCliExportRecipient } from './cli-recipient-delivery.js';
import { recipientDeliveryOptions } from './security/recipient-delivery.js';

export async function runBackupSecurityCli(argv: string[]): Promise<void> {
  const action = argv[0],
    options = new Map<string, string>();
  const allowed: Record<string, readonly string[]> = {
    'backup-key-create': ['--output', '--passphrase-file'],
    'backup-export': [
      '-c',
      '--config',
      '--instance',
      '--database',
      '--output',
      '--public-key',
      ...recipientDeliveryOptions,
    ],
    'backup-import': [
      '-c',
      '--config',
      '--instance',
      '--database',
      '--private-key',
      '--package',
      '--passphrase-file',
    ],
  };
  if (!action || !Object.hasOwn(allowed, action)) {
    throw new SecurityError('SECURITY_INVALID_REQUEST');
  }
  let yes = false;
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === '--yes') {
      if (yes || action === 'backup-key-create') {
        throw new SecurityError('SECURITY_INVALID_REQUEST');
      }
      yes = true;
      continue;
    }
    if (
      !allowed[action]!.includes(arg) ||
      !argv[index + 1] ||
      argv[index + 1]!.startsWith('--') ||
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
  let outputAttempted = false;
  try {
    if (registry.status().instanceId !== required('--instance')) {
      throw new SecurityError('SECURITY_CONFIRMATION_REQUIRED');
    }
    const provider = new LocalVaultKeyProvider(directory),
      database = required('--database');
    assertFlatGraphSegment(database, 'database');
    const selected =
      action === 'backup-export'
        ? selectCliExportRecipient(registry, options, required('--instance'), yes, protector)
        : undefined;
    registry.recordMaintenance('backup.task.started');
    const deliveryRevision = registry.status().revision;
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
      const nested = assertRecoveryPath(join(cfg.storageRoot, database, 'atlas.mld'));
      const flat = assertRecoveryPath(join(cfg.storageRoot, database + '.mld'));
      if (existsSync(nested) === existsSync(flat)) {
        throw new SecurityError('SECURITY_INVALID_REQUEST');
      }
      readBackupBytes(existsSync(nested) ? nested : flat, MAX_BACKUP_VAULT_BYTES);
      const recipient = selected!.key;
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
      const packageSha256 = fileDigest(file.content);
      if (selected?.selection) {
        registry.withLocalActor(selected.sid, () =>
          registry.recordSealedRecipientDelivery(
            { ...selected.selection, revision: deliveryRevision },
            database,
            'backup',
            packageSha256,
          ),
        );
      }
      outputAttempted = true;
      writeNew(output, file.content);
      result = {
        ok: true,
        recipientId: backupRecipientId(recipient),
        packageSha256,
        ...(selected?.recipient ? { recipient: selected.recipient } : {}),
        backup,
      };
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
    if (outputAttempted) {
      throw new SecurityError('SECURITY_OUTCOME_UNCONFIRMED');
    }
    throw error;
  } finally {
    registry.close();
  }
}

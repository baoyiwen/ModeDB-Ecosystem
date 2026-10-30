import { createPublicKey } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { assertFlatGraphSegment, fileDigest } from '@mode-db/common';
import {
  collectAssetGraph,
  collectDesignerAsset,
  type AssetSelection,
  type DesignerAssetSelection,
} from '@mode-db/core';
import { AuthoringBridge } from './authoring-bridge.js';
import { readBackupBytes } from './backup-manager.js';
import { importAssetAsNewDatabase, previewAssetImport } from './asset-transfer.js';
import { importDesignerAsset, previewDesignerAssetImport } from './designer-asset-transfer.js';
import { loadModelDBServerConfig } from './config-loader.js';
import { backupRecipientId, MAX_BACKUP_VAULT_BYTES } from './security/backup-package.js';
import {
  openAnyAssetPackage,
  sealAssetPackage,
  sealDesignerAssetPackage,
} from './security/asset-package.js';
import {
  createAssetSigningKey,
  openAssetSigningKey,
  openMigrationKey,
} from './security/migration-key.js';
import { assertRecoveryPath, readRecoveryPassphraseFile } from './security/recovery-material.js';
import { LocalVaultKeyProvider } from './security/local-vault-key-provider.js';
import { SecurityRegistry } from './security/security-registry.js';
import { WindowsSecretProtector } from './security/windows-secret-protector.js';
import { SecurityError } from './security/security-errors.js';
import { selectCliExportRecipient } from './cli-recipient-delivery.js';
import { recipientDeliveryOptions } from './security/recipient-delivery.js';

/** Offline OS-owner entry point; no HTTP path accepts private keys or passphrases. */
export async function runAssetCli(argv: string[]): Promise<void> {
  const action = argv[0],
    options = new Map<string, string>();
  let yes = false;
  const allowed: Record<string, string[]> = {
    'asset-signing-key-create': ['--output', '--passphrase-file'],
    'asset-export': [
      '-c',
      '--config',
      '--instance',
      '--database',
      '--selection',
      '--asset-id',
      '--asset-version',
      '--public-key',
      ...recipientDeliveryOptions,
      '--signing-key',
      '--passphrase-file',
      '--output',
    ],
    'asset-preview': [
      '-c',
      '--config',
      '--instance',
      '--database',
      '--package',
      '--private-key',
      '--passphrase-file',
      '--publisher-key',
      '--publisher-fingerprint',
    ],
    'asset-import': [
      '-c',
      '--config',
      '--instance',
      '--database',
      '--package',
      '--private-key',
      '--passphrase-file',
      '--publisher-key',
      '--publisher-fingerprint',
      '--preview-digest',
    ],
  };
  if (!allowed[action!]) {
    throw new SecurityError('SECURITY_INVALID_REQUEST');
  }
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--yes' && !yes && ['asset-export', 'asset-import'].includes(action!)) {
      yes = true;
      continue;
    }
    if (
      !allowed[action!]!.includes(arg) ||
      options.has(arg) ||
      !argv[i + 1] ||
      argv[i + 1]!.startsWith('--')
    ) {
      throw new SecurityError('SECURITY_INVALID_REQUEST');
    }
    options.set(arg, argv[++i]!);
  }
  const required = (key: string): string => {
    const value = options.get(key);
    if (!value) {
      throw new SecurityError('SECURITY_INVALID_REQUEST');
    }
    return value;
  };
  const protector = new WindowsSecretProtector();
  const phrase = () =>
    readRecoveryPassphraseFile(required('--passphrase-file'), (path) =>
      protector.ensureDirectory(path),
    );
  const writeNew = (path: string, bytes: Buffer | string): void => {
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
  if (action === 'asset-signing-key-create') {
    const prefix = assertRecoveryPath(required('--output'));
    if (existsSync(prefix + '.public.pem') || existsSync(prefix + '.private.json')) {
      throw new SecurityError('SECURITY_POLICY_CONFLICT');
    }
    const key = createAssetSigningKey(phrase());
    writeNew(prefix + '.private.json', key.privateKey);
    writeNew(prefix + '.public.pem', key.publicKey);
    process.stdout.write(
      JSON.stringify({
        publisherId: key.recipientId,
        publicKeyFile: prefix + '.public.pem',
        privateKeyFile: prefix + '.private.json',
      }) + '\n',
    );
    return;
  }
  if (options.has('-c') && options.has('--config')) {
    throw new SecurityError('SECURITY_INVALID_REQUEST');
  }
  const config = options.get('-c') ?? options.get('--config');
  if (!config || !options.get('--instance') || (action !== 'asset-preview' && !yes)) {
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
    resumeAssetPublication: action === 'asset-preview' || action === 'asset-import',
    auditLimit: cfg.securityAudit.maxEvents,
    auditRetentionDays: cfg.securityAudit.retentionDays,
  });
  let resultWritten = false;
  try {
    if (registry.status().instanceId !== required('--instance')) {
      throw new SecurityError('SECURITY_CONFIRMATION_REQUIRED');
    }
    const database = required('--database'),
      provider = new LocalVaultKeyProvider(directory);
    assertFlatGraphSegment(database, 'database');
    if (
      database.toLowerCase() === cfg.designerWorkspace.toLowerCase() ||
      database.toLowerCase().startsWith('sys_')
    ) {
      throw new SecurityError('SECURITY_FORBIDDEN');
    }
    const selected =
      action === 'asset-export'
        ? selectCliExportRecipient(registry, options, required('--instance'), yes, protector)
        : undefined;
    registry.recordMaintenance('asset.task.started');
    const deliveryRevision = registry.status().revision;
    let result: unknown;
    if (action === 'asset-export') {
      const nested = assertRecoveryPath(join(cfg.storageRoot, database, 'atlas.mld'));
      const flat = assertRecoveryPath(join(cfg.storageRoot, database + '.mld'));
      if (existsSync(nested) === existsSync(flat)) {
        throw new SecurityError('SECURITY_INVALID_REQUEST');
      }
      // Reject aliases/oversized source files before opening an engine or provisioning keys.
      readBackupBytes(existsSync(nested) ? nested : flat, MAX_BACKUP_VAULT_BYTES);
      const output = assertRecoveryPath(required('--output'));
      const inside = (parent: string): boolean => {
        const rel = relative(assertRecoveryPath(parent), output);
        return (
          rel === '' ||
          (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../'))
        );
      };
      if (inside(directory) || inside(cfg.storageRoot) || existsSync(output)) {
        throw new SecurityError('SECURITY_INVALID_REQUEST');
      }
      const keyPath = assertRecoveryPath(required('--signing-key'));
      protector.ensureDirectory(dirname(keyPath));
      const key = openAssetSigningKey(readBackupBytes(keyPath, 16384), phrase());
      const recipient = selected!.key;
      const selection = JSON.parse(
        readBackupBytes(required('--selection'), 65536).toString('utf8'),
      ) as AssetSelection | DesignerAssetSelection;
      const bridge = new AuthoringBridge(cfg.storageRoot, provider);
      try {
        const engine = await bridge.getEngine(database);
        await engine.flushAll();
        const metadata = {
          assetId: required('--asset-id'),
          assetVersion: required('--asset-version'),
          sourceInstanceId: registry.status().instanceId,
        };
        let bytes: Buffer;
        if ('designer' in selection) {
          const nestedWorkspace = assertRecoveryPath(
            join(cfg.storageRoot, cfg.designerWorkspace, 'atlas.mld'),
          );
          const flatWorkspace = assertRecoveryPath(
            join(cfg.storageRoot, cfg.designerWorkspace + '.mld'),
          );
          if (existsSync(nestedWorkspace) === existsSync(flatWorkspace)) {
            throw new SecurityError('SECURITY_INVALID_REQUEST');
          }
          readBackupBytes(
            existsSync(nestedWorkspace) ? nestedWorkspace : flatWorkspace,
            MAX_BACKUP_VAULT_BYTES,
          );
          const workspace = await bridge.getEngine(cfg.designerWorkspace);
          await workspace.flushAll();
          const collected = collectDesignerAsset(
            engine.atlasVault!,
            workspace.atlasVault!,
            selection,
          );
          bytes = sealDesignerAssetPackage(
            collected.graph,
            collected.designer,
            metadata,
            recipient,
            key,
          );
        } else {
          bytes = sealAssetPackage(
            collectAssetGraph(engine.atlasVault!, selection),
            metadata,
            recipient,
            key,
          );
        }
        const packageSha256 = fileDigest(bytes);
        if (selected?.selection) {
          registry.withLocalActor(selected.sid, () =>
            registry.recordSealedRecipientDelivery(
              { ...selected.selection, revision: deliveryRevision },
              database,
              'asset',
              packageSha256,
            ),
          );
        }
        resultWritten = true;
        writeNew(output, bytes);
        result = {
          exported: true,
          bytes: bytes.length,
          publisherId: backupRecipientId(key),
          recipientId: backupRecipientId(recipient),
          packageSha256,
          ...(selected?.recipient ? { recipient: selected.recipient } : {}),
        };
      } finally {
        await bridge.close();
      }
    } else {
      const privatePath = assertRecoveryPath(required('--private-key'));
      protector.ensureDirectory(dirname(privatePath));
      const key = openMigrationKey(readBackupBytes(privatePath, 16384), phrase());
      const publisher = createPublicKey(readBackupBytes(required('--publisher-key'), 8192));
      const content = openAnyAssetPackage(
        readBackupBytes(required('--package')),
        key,
        publisher,
        required('--publisher-fingerprint'),
      );
      const input = {
        content,
        storageRoot: cfg.storageRoot,
        database,
        instanceId: registry.status().instanceId,
        designerWorkspace: cfg.designerWorkspace,
        provider,
      };
      if (content.version === 2) {
        const designerInput = { ...input, content, securityDirectory: directory, registry };
        result =
          action === 'asset-preview'
            ? previewDesignerAssetImport(designerInput)
            : importDesignerAsset({
                ...designerInput,
                confirmationDigest: required('--preview-digest'),
              });
      } else {
        if (
          ['', '.pending', '.commit', '.lock', '.reclaim'].some((suffix) =>
            existsSync(join(directory, 'asset-publication.mld') + suffix),
          )
        ) {
          throw new SecurityError('SECURITY_MAINTENANCE_FAILED');
        }
        result =
          action === 'asset-preview'
            ? previewAssetImport(input)
            : importAssetAsNewDatabase({
                ...input,
                confirmationDigest: required('--preview-digest'),
              });
      }
      resultWritten = action === 'asset-import';
    }
    registry.recordMaintenance('asset.task.completed');
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    try {
      registry.recordMaintenance('asset.task.failed');
    } catch {
      /* Preserve original failure. */
    }
    if (resultWritten) {
      throw new SecurityError('SECURITY_OUTCOME_UNCONFIRMED');
    }
    if (error instanceof SecurityError) {
      throw error;
    }
    throw new SecurityError('SECURITY_INVALID_REQUEST');
  } finally {
    registry.close();
  }
}

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  fileDigest,
  stableStringify,
  type AtomicCommitPoint,
  type VaultKeyProvider,
} from '@mode-db/common';
import {
  assetGraphVault,
  AtlasSingleVault,
  readAtlasVaultKeyReferenceFromBytes,
} from '@mode-db/core';
import { importDatabaseBackup, readBackupBytes, restoreDatabaseBackup } from './backup-manager.js';
import { sealBackupPackage, MAX_BACKUP_VAULT_BYTES } from './security/backup-package.js';
import { assertRecoveryPath } from './security/recovery-material.js';
import { SecurityError } from './security/security-errors.js';
import type { AssetContent, AnyAssetContent } from './security/asset-package.js';

const RECEIPT = '__asset_receipt__';
const fail = (): never => {
  throw new SecurityError('SECURITY_POLICY_CONFLICT');
};
export interface AssetImportPreview {
  readonly format: 'modeldb.asset-preview.v1';
  readonly packageId: string;
  readonly packageDigest: string;
  readonly assetId: string;
  readonly assetVersion: string;
  readonly publisherId: string;
  readonly targetDatabase: string;
  readonly localAssetInstanceId: string;
  readonly statistics: AssetContent['statistics'];
  readonly includeData: boolean;
  readonly models: readonly AssetContent['graph']['models'][number]['definition'][];
  readonly relations: readonly AssetContent['graph']['relations'][number]['definition'][];
  readonly conflicts: readonly string[];
  readonly resume: boolean;
  readonly requiredAuthority: 'offline-os-owner';
  readonly confirmationDigest: string;
}
export function assetTargetVault(content: AnyAssetContent, database: string, instanceId: string) {
  const localAssetInstanceId = fileDigest(
    Buffer.from(stableStringify({ instanceId, database, packageId: content.packageId })),
  );
  const vault = assetGraphVault(content.graph, database);
  vault.set(
    RECEIPT,
    stableStringify({
      version: 1,
      localAssetInstanceId,
      assetId: content.assetId,
      assetVersion: content.assetVersion,
      packageId: content.packageId,
      publisherId: content.publisherId,
      contentDigest: content.contentDigest,
    }),
  );
  return { vault, localAssetInstanceId };
}
/** Read-only preview. Existing or changed content is never silently overwritten. */
export function previewAssetImport(input: {
  content: AnyAssetContent;
  storageRoot: string;
  database: string;
  instanceId: string;
  designerWorkspace: string;
  provider: VaultKeyProvider;
}): AssetImportPreview {
  const { content, storageRoot, database, instanceId, designerWorkspace, provider } = input;
  const { vault, localAssetInstanceId } = assetTargetVault(content, database, instanceId);
  const path = assertRecoveryPath(join(storageRoot, database, 'atlas.mld'));
  const flat = assertRecoveryPath(join(storageRoot, database + '.mld'));
  const directory = assertRecoveryPath(join(storageRoot, database));
  const conflicts: string[] = [];
  let resume = false;
  if (
    database.toLowerCase() === designerWorkspace.toLowerCase() ||
    database.toLowerCase().startsWith('sys_')
  ) {
    conflicts.push('reserved-database');
  }
  if (
    ['', '.pending', '.commit', '.lock', '.reclaim'].some((suffix) => existsSync(flat + suffix))
  ) {
    conflicts.push('existing-flat-database');
  }
  if (existsSync(directory)) {
    const names = readdirSync(directory);
    if (
      names.some(
        (name) =>
          !['atlas.mld', 'atlas.mld.pending', 'atlas.mld.commit', 'atlas.mld.lock'].includes(name),
      )
    ) {
      conflicts.push('existing-directory');
    }
    if (existsSync(path + '.lock')) {
      try {
        const owner = JSON.parse(readBackupBytes(path + '.lock', 1024).toString('utf8')) as {
          pid?: number;
        };
        if (!Number.isSafeInteger(owner.pid) || owner.pid! <= 0) {
          throw new Error();
        }
        try {
          process.kill(owner.pid!, 0);
          conflicts.push('target-busy');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
            conflicts.push('target-busy');
          }
        }
      } catch {
        conflicts.push('unverified-target');
      }
    }
    const candidate = existsSync(path)
      ? path
      : existsSync(path + '.pending')
        ? path + '.pending'
        : undefined;
    if (candidate) {
      try {
        const bytes = readBackupBytes(candidate, MAX_BACKUP_VAULT_BYTES);
        const material = provider.resolveKey(database, readAtlasVaultKeyReferenceFromBytes(bytes));
        const current = new AtlasSingleVault();
        try {
          current.loadBytes(bytes, material);
        } finally {
          material.key.fill(0);
        }
        const entries = (v: AtlasSingleVault) =>
          stableStringify(Object.fromEntries([...v.keys()].map((key) => [key, v.get(key)])));
        resume = entries(current) === entries(vault);
        if (!resume) {
          conflicts.push('existing-database');
        }
      } catch {
        conflicts.push('unverified-target');
      }
    } else {
      conflicts.push('existing-directory');
    }
  }
  const result = {
    format: 'modeldb.asset-preview.v1' as const,
    packageId: content.packageId,
    packageDigest: fileDigest(Buffer.from(stableStringify(content))),
    assetId: content.assetId,
    assetVersion: content.assetVersion,
    publisherId: content.publisherId,
    targetDatabase: database,
    localAssetInstanceId,
    statistics: content.statistics,
    includeData: content.graph.includeData,
    models: content.graph.models.map(({ definition }) => definition),
    relations: content.graph.relations.map(({ definition }) => definition),
    conflicts,
    resume,
    requiredAuthority: 'offline-os-owner' as const,
  };
  return { ...result, confirmationDigest: fileDigest(Buffer.from(stableStringify(result))) };
}
/** Single-Vault publication only. Designer/cross-storage metadata is not accepted by this format. */
export function importAssetAsNewDatabase(
  input: Parameters<typeof previewAssetImport>[0] & {
    confirmationDigest: string;
    onPoint?: (point: AtomicCommitPoint) => void;
  },
): {
  database: string;
  localAssetInstanceId: string;
  packageId: string;
  statistics: AssetContent['statistics'];
  resumed: boolean;
} {
  const preview = previewAssetImport(input);
  if (input.content.version !== 1) {
    throw new SecurityError('SECURITY_INVALID_REQUEST');
  }
  if (preview.conflicts.length) {
    fail();
  }
  if (
    !/^[a-f0-9]{64}$/.test(input.confirmationDigest) ||
    preview.confirmationDigest !== input.confirmationDigest
  ) {
    throw new SecurityError('SECURITY_CONFIRMATION_REQUIRED');
  }
  const { vault } = assetTargetVault(input.content, input.database, input.instanceId);
  const material = input.provider.resolveKey(input.database);
  let bytes: Buffer;
  try {
    bytes = sealBackupPackage(vault.exportBytes(material), material, {
      database: input.database,
      kind: 'nested',
    });
  } finally {
    material.key.fill(0);
  }
  // Reuse authenticated candidate matching and journal recovery, including first-publication stages.
  const backup = importDatabaseBackup(
    input.storageRoot,
    'asset.modeldb-backup.json',
    bytes,
    input.provider,
  );
  restoreDatabaseBackup(
    input.storageRoot,
    input.database,
    backup.fileName,
    input.provider,
    input.onPoint,
  );
  return {
    database: input.database,
    localAssetInstanceId: preview.localAssetInstanceId,
    packageId: input.content.packageId,
    statistics: input.content.statistics,
    resumed: preview.resume,
  };
}

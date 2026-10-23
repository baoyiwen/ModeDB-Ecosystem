import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID, type KeyObject } from 'node:crypto';
import {
  assertFlatGraphSegment,
  acquireFileLeaseSync,
  fileDigest,
  readAtomicFileSync,
  type AtomicCommitPoint,
  type VaultKeyMaterial,
  type VaultKeyProvider,
} from '@mode-db/common';
import {
  AtlasSingleVault,
  readAtlasVaultKeyReference,
  readAtlasVaultKeyReferenceFromBytes,
} from '@mode-db/core';
import { assertRecoveryPath } from './security/recovery-material.js';
import { SecurityError } from './security/security-errors.js';
import {
  MAX_BACKUP_BYTES,
  MAX_BACKUP_VAULT_BYTES,
  normalizeSecureBackupName,
  openBackupPackage,
  sealBackupPackage,
  type BackupManifest,
  type BackupStatistics,
  type BackupUnlock,
} from './security/backup-package.js';

export { normalizeSecureBackupName as normalizeBackupName } from './security/backup-package.js';
export interface ModelDbBackupInfo {
  readonly fileName: string;
  readonly name?: string;
  readonly database: string;
  readonly createdAt: string;
  readonly bytes: number;
  readonly path: string;
  readonly format: 'modeldb.backup.v2';
  readonly packageId: string;
  readonly statistics: BackupStatistics;
}
const invalid = (): never => {
  throw new SecurityError('SECURITY_INVALID_REQUEST');
};
function providerRequired(provider?: VaultKeyProvider): VaultKeyProvider {
  if (!provider) {
    throw new SecurityError('SECURITY_INVALID_CONFIG');
  }
  return provider;
}
function backupRoot(workspace: string): string {
  return assertRecoveryPath(join(workspace, 'modeldb', 'backups'));
}
function backupPath(workspace: string, fileName: string): string {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,240}\.modeldb-backup\.json$/.test(fileName)) {
    return invalid();
  }
  return assertRecoveryPath(join(backupRoot(workspace), fileName));
}
/** Bounded reads reject aliases and non-regular files before allocating. */
export function readBackupBytes(path: string, max = MAX_BACKUP_BYTES): Buffer {
  const file = assertRecoveryPath(path),
    before = lstatSync(file);
  if (!before.isFile() || before.nlink !== 1 || before.size > max) {
    return invalid();
  }
  const fd = openSync(file, 'r');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > max || stat.ino !== before.ino) {
      return invalid();
    }
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!count) {
        return invalid();
      }
      offset += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, null)) {
      return invalid();
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}
function info(
  workspace: string,
  fileName: string,
  manifest: BackupManifest,
  bytes: number,
): ModelDbBackupInfo {
  return {
    fileName,
    name: manifest.name,
    database: manifest.database,
    createdAt: manifest.createdAt,
    bytes,
    path: backupPath(workspace, fileName),
    format: 'modeldb.backup.v2',
    packageId: manifest.packageId,
    statistics: manifest.statistics,
  };
}
function vaultPath(
  workspace: string,
  database: string,
  creating = false,
): { path: string; kind: 'nested' | 'flat' } {
  assertFlatGraphSegment(database, 'database');
  assertRecoveryPath(workspace);
  const nested = assertRecoveryPath(join(workspace, database, 'atlas.mld'));
  const flat = assertRecoveryPath(join(workspace, `${database}.mld`));
  const present = (path: string) =>
    ['', '.pending', '.commit', '.lock', '.reclaim'].some((suffix) => existsSync(path + suffix));
  if (present(nested) && present(flat)) {
    return invalid();
  }
  if (present(nested)) {
    return { path: nested, kind: 'nested' };
  }
  if (present(flat)) {
    return { path: flat, kind: 'flat' };
  }
  if (!creating) {
    throw new SecurityError('SECURITY_NOT_FOUND');
  }
  return { path: nested, kind: 'nested' };
}
function assertVaultArtifacts(path: string): void {
  for (const suffix of ['', '.pending', '.commit', '.lock', '.reclaim']) {
    assertRecoveryPath(path + suffix);
    if (existsSync(path + suffix)) {
      const stat = lstatSync(path + suffix);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size > (suffix === '' || suffix === '.pending' ? MAX_BACKUP_VAULT_BYTES : 1024)
      ) {
        return invalid();
      }
    }
  }
}
function snapshot(
  path: string,
  database: string,
  provider: VaultKeyProvider,
): { bytes: Buffer; material: VaultKeyMaterial } {
  assertVaultArtifacts(path);
  const reference = readAtlasVaultKeyReferenceFromBytes(
    readBackupBytes(existsSync(path) ? path : path + '.pending', MAX_BACKUP_VAULT_BYTES),
  );
  const material = { reference, key: Buffer.from(provider.resolveKey(database, reference).key) };
  try {
    const bytes = readAtomicFileSync(path, (candidate) => {
      if (candidate.length > MAX_BACKUP_VAULT_BYTES) {
        throw new SecurityError('SECURITY_RESPONSE_LIMIT');
      }
      new AtlasSingleVault().loadBytes(candidate, material);
    });
    if (!bytes) {
      throw new SecurityError('SECURITY_NOT_FOUND');
    }
    return { bytes, material };
  } catch (error) {
    material.key.fill(0);
    throw error;
  }
}
/** A first restore may crash before its intent is written. Only the exact authenticated content
 * requested again may complete that initial intent; other/invalid stages remain untouched. */
function resumeInitialRestore(
  path: string,
  material: VaultKeyMaterial,
  requested: AtlasSingleVault,
): void {
  const release = acquireFileLeaseSync(path);
  try {
    if (existsSync(path) || existsSync(path + '.commit') || !existsSync(path + '.pending')) {
      return;
    }
    const bytes = readBackupBytes(path + '.pending', MAX_BACKUP_VAULT_BYTES);
    const staged = new AtlasSingleVault();
    staged.loadBytes(bytes, material);
    const keys = [...requested.keys()];
    if (
      [...staged.keys()].length !== keys.length ||
      keys.some((key) => requested.get(key) !== staged.get(key))
    ) {
      return invalid();
    }
    const fd = openSync(path + '.commit', 'wx', 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ version: 1, previous: null, next: fileDigest(bytes) }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } finally {
    release();
  }
}
function store(workspace: string, content: Buffer, unlock: BackupUnlock): ModelDbBackupInfo {
  const verified = openBackupPackage(content, unlock);
  try {
    const root = backupRoot(workspace);
    mkdirSync(root, { recursive: true });
    const fileName = `backup-${randomUUID()}.modeldb-backup.json`;
    const path = backupPath(workspace, fileName);
    if (statfsSync(root).bavail * statfsSync(root).bsize < content.length * 2 + 1024 * 1024) {
      throw new SecurityError('SECURITY_RESPONSE_LIMIT');
    }
    const fd = openSync(path, 'wx', 0o600);
    try {
      writeFileSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const reread = openBackupPackage(readBackupBytes(path), unlock);
    reread.material.key.fill(0);
    return info(workspace, fileName, verified.manifest, content.length);
  } finally {
    verified.material.key.fill(0);
  }
}
/** Call under the database write gate after flushAll, or while holding the offline instance lease. */
export function createDatabaseBackup(
  workspace: string,
  database: string,
  _reason = 'manual',
  name?: string,
  provider?: VaultKeyProvider,
  recipient?: KeyObject,
): ModelDbBackupInfo {
  normalizeSecureBackupName(name);
  const source = vaultPath(workspace, database),
    keys = providerRequired(provider);
  const current = snapshot(source.path, database, keys);
  try {
    const content = sealBackupPackage(
      current.bytes,
      current.material,
      { database, name, kind: source.kind },
      recipient,
    );
    return store(workspace, content, { provider: keys });
  } finally {
    current.material.key.fill(0);
  }
}
export function listDatabaseBackups(
  workspace: string,
  database?: string,
  provider?: VaultKeyProvider,
): readonly ModelDbBackupInfo[] {
  if (database) {
    assertFlatGraphSegment(database, 'database');
  }
  const root = backupRoot(workspace);
  if (!existsSync(root)) {
    return [];
  }
  const keys = providerRequired(provider),
    out: ModelDbBackupInfo[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.modeldb-backup.json')) {
      continue;
    }
    try {
      const content = readBackupBytes(backupPath(workspace, entry.name));
      const opened = openBackupPackage(content, { provider: keys });
      try {
        if (!database || opened.manifest.database === database) {
          out.push(info(workspace, entry.name, opened.manifest, content.length));
        }
      } finally {
        opened.material.key.fill(0);
      }
    } catch {
      /* Unsupported, damaged or unavailable packages are never advertised as verified backups. */
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export function readDatabaseBackupFile(
  workspace: string,
  fileName: string,
  provider?: VaultKeyProvider,
): { info: ModelDbBackupInfo; content: Buffer } {
  const path = backupPath(workspace, fileName);
  if (!existsSync(path)) {
    throw new SecurityError('SECURITY_NOT_FOUND');
  }
  const content = readBackupBytes(path),
    opened = openBackupPackage(content, { provider: providerRequired(provider) });
  try {
    return { info: info(workspace, fileName, opened.manifest, content.length), content };
  } finally {
    opened.material.key.fill(0);
  }
}
/** Imported files are authenticated before storage; names cannot inject extraction paths. */
export function importDatabaseBackup(
  workspace: string,
  _requestedFileName: string,
  content: Uint8Array,
  provider?: VaultKeyProvider,
): ModelDbBackupInfo {
  return store(workspace, Buffer.from(content), { provider: providerRequired(provider) });
}
/** Verify an incoming package without changing the target database. */
export function verifyDatabaseBackup(
  workspace: string,
  fileName: string,
  provider: VaultKeyProvider,
): ModelDbBackupInfo {
  return readDatabaseBackupFile(workspace, fileName, provider).info;
}
/** Explicit trusted full migration, re-encrypted for a new destination database before local storage. */
export function importMigrationBackup(
  workspace: string,
  database: string,
  content: Uint8Array,
  privateKey: KeyObject,
  provider: VaultKeyProvider,
): ModelDbBackupInfo {
  const target = vaultPath(workspace, database, true);
  if (
    existsSync(target.path) ||
    existsSync(target.path + '.pending') ||
    existsSync(target.path + '.commit')
  ) {
    return invalid();
  }
  const opened = openBackupPackage(content, { privateKey });
  try {
    opened.vault.relocateAtlas(opened.manifest.database, database);
    const key = provider.resolveKey(database);
    const material = { reference: key.reference, key: Buffer.from(key.key) };
    try {
      return store(
        workspace,
        sealBackupPackage(opened.vault.exportBytes(material), material, {
          database,
          name: opened.manifest.name,
          kind: 'nested',
        }),
        { provider },
      );
    } finally {
      material.key.fill(0);
    }
  } finally {
    opened.material.key.fill(0);
  }
}
/** Atomic replacement preserves the existing directory, access ledger, policies and unrelated files. */
export function restoreDatabaseBackup(
  workspace: string,
  database: string,
  fileName: string,
  provider?: VaultKeyProvider,
  onPoint?: (point: AtomicCommitPoint) => void,
): ModelDbBackupInfo {
  const keys = providerRequired(provider),
    result = readDatabaseBackupFile(workspace, fileName, keys);
  const opened = openBackupPackage(result.content, { provider: keys });
  let destination: VaultKeyMaterial | undefined;
  try {
    opened.vault.relocateAtlas(opened.manifest.database, database);
    const target = vaultPath(workspace, database, true);
    assertVaultArtifacts(target.path);
    let expected: string | null = null;
    if (existsSync(target.path)) {
      const current = snapshot(target.path, database, keys);
      destination = current.material;
      expected = fileDigest(current.bytes);
    } else {
      const existing = readAtlasVaultKeyReference(target.path);
      const key = keys.resolveKey(database, existing);
      destination = { reference: key.reference, key: Buffer.from(key.key) };
      if (existing) {
        resumeInitialRestore(target.path, destination, opened.vault);
        const recovered = readAtomicFileSync(target.path, (bytes) =>
          new AtlasSingleVault().loadBytes(bytes, destination!),
        );
        expected = recovered ? fileDigest(recovered) : null;
      }
    }
    const parent =
      target.kind === 'nested'
        ? assertRecoveryPath(join(workspace, database))
        : assertRecoveryPath(workspace);
    mkdirSync(parent, { recursive: true });
    if (
      statfsSync(parent).bavail * statfsSync(parent).bsize <
      opened.vaultBytes.length * 3 + 1024 * 1024
    ) {
      throw new SecurityError('SECURITY_RESPONSE_LIMIT');
    }
    opened.vault.saveReplacingSync(target.path, destination, expected, onPoint);
    const check = new AtlasSingleVault();
    if (!check.loadSync(target.path, destination)) {
      return invalid();
    }
    return result.info;
  } finally {
    opened.material.key.fill(0);
    destination?.key.fill(0);
  }
}
export function forceResetDatabase(workspace: string, database: string): void {
  assertFlatGraphSegment(database, 'database');
  const nested = assertRecoveryPath(join(workspace, database)),
    flat = assertRecoveryPath(join(workspace, `${database}.mld`));
  if (existsSync(nested)) {
    rmSync(nested, { recursive: true, force: true });
  }
  if (existsSync(flat)) {
    rmSync(flat, { force: true });
  }
  mkdirSync(nested, { recursive: true });
}

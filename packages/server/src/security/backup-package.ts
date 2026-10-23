import {
  constants,
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  randomUUID,
  type KeyObject,
} from 'node:crypto';
import {
  assertFlatGraphSegment,
  fileDigest,
  isVaultKeyReference,
  vaultKeyReferenceAAD,
  type VaultKeyMaterial,
  type VaultKeyProvider,
  type VaultKeyReference,
} from '@mode-db/common';
import { AtlasSingleVault, readAtlasVaultKeyReferenceFromBytes } from '@mode-db/core';
import { SecurityError } from './security-errors.js';

export const MAX_BACKUP_BYTES = 128 * 1024 * 1024;
export const MAX_BACKUP_VAULT_BYTES = 48 * 1024 * 1024;
export interface BackupStatistics {
  readonly vaultBytes: number;
  readonly entries: number;
  readonly models: number;
  readonly relations: number;
}
export interface BackupManifest {
  readonly database: string;
  readonly name?: string;
  readonly createdAt: string;
  readonly kind: 'nested' | 'flat';
  readonly packageId: string;
  readonly sourceReference: VaultKeyReference;
  readonly vaultDigest: string;
  readonly statistics: BackupStatistics;
}
interface RecipientHeader {
  alg: 'A256KW' | 'RSA-OAEP-256';
  kid: string;
}
interface BackupPackage {
  format: 'modeldb.backup.v2';
  protected: string;
  recipients: { header: RecipientHeader; encrypted_key: string }[];
  iv: string;
  ciphertext: string;
  tag: string;
}
export interface BackupUnlock {
  readonly provider?: VaultKeyProvider;
  readonly privateKey?: KeyObject;
}
const invalid = (): never => {
  throw new SecurityError('SECURITY_INVALID_REQUEST');
};
function exact(value: unknown, names: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalid();
  }
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== names.length || names.some((name) => !(name in object))) {
    return invalid();
  }
  return object;
}
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
function decode(value: unknown, max: number, length?: number): Buffer {
  if (
    typeof value !== 'string' ||
    value.length > Math.ceil((max * 4) / 3) ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    return invalid();
  }
  const bytes = Buffer.from(value, 'base64url');
  if (
    bytes.length > max ||
    b64(bytes) !== value ||
    (length !== undefined && bytes.length !== length)
  ) {
    return invalid();
  }
  return bytes;
}
export function normalizeSecureBackupName(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.trim().length > 120 ||
    /[\x00-\x1f\x7f]/.test(value)
  ) {
    return invalid();
  }
  return value.trim();
}
export function backupStatistics(vault: AtlasSingleVault, bytes: number): BackupStatistics {
  const keys = [...vault.keys()];
  return {
    vaultBytes: bytes,
    entries: keys.length,
    models: keys.filter((key) => key.startsWith('m:')).length,
    relations: keys.filter((key) => key.startsWith('r:')).length,
  };
}
/** RSA public-key fingerprint; callers must verify it through a trusted channel. */
export function backupRecipientId(key: KeyObject): string {
  const publicKey = key.type === 'public' ? key : createPublicKey(key);
  const bits = publicKey.asymmetricKeyDetails?.modulusLength;
  if (publicKey.asymmetricKeyType !== 'rsa' || !bits || bits < 3072 || bits > 4096) {
    return invalid();
  }
  return fileDigest(publicKey.export({ type: 'spki', format: 'der' }));
}
/** RFC 7516 General JSON serialization, A256KW and optional RSA-OAEP-256 recipients. */
export function sealBackupPackage(
  vaultBytes: Buffer,
  material: VaultKeyMaterial,
  metadata: { database: string; name?: string; kind: 'nested' | 'flat' },
  recipient?: KeyObject,
): Buffer {
  if (vaultBytes.length > MAX_BACKUP_VAULT_BYTES) {
    throw new SecurityError('SECURITY_RESPONSE_LIMIT');
  }
  assertFlatGraphSegment(metadata.database, 'database');
  const vault = new AtlasSingleVault();
  vault.loadBytes(vaultBytes, material);
  const manifest: BackupManifest = {
    database: metadata.database,
    name: normalizeSecureBackupName(metadata.name),
    kind: metadata.kind,
    createdAt: new Date().toISOString(),
    packageId: randomUUID(),
    sourceReference: material.reference,
    vaultDigest: fileDigest(vaultBytes),
    statistics: backupStatistics(vault, vaultBytes.length),
  };
  const headers: RecipientHeader[] = [{ alg: 'A256KW', kid: material.reference.keyId }];
  if (recipient) {
    headers.push({ alg: 'RSA-OAEP-256', kid: backupRecipientId(recipient) });
  }
  const protectedHeader = b64(
    Buffer.from(
      JSON.stringify({
        enc: 'A256GCM',
        typ: 'modeldb.backup.v2',
        manifest,
        recipientBindings: headers,
      }),
    ),
  );
  const pek = randomBytes(32);
  const plain = Buffer.from(
    JSON.stringify({ version: 2, vault: b64(vaultBytes), key: b64(material.key) }),
  );
  try {
    const wrap = createCipheriv('id-aes256-wrap', material.key, Buffer.alloc(8, 0xa6));
    const wrapped = Buffer.concat([wrap.update(pek), wrap.final()]);
    const recipients: BackupPackage['recipients'] = [
      { header: headers[0]!, encrypted_key: b64(wrapped) },
    ];
    if (recipient) {
      recipients.push({
        header: headers[1]!,
        encrypted_key: b64(
          publicEncrypt(
            { key: recipient, oaepHash: 'sha256', padding: constants.RSA_PKCS1_OAEP_PADDING },
            pek,
          ),
        ),
      });
    }
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', pek, iv);
    cipher.setAAD(Buffer.from(protectedHeader));
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    const pkg: BackupPackage = {
      format: 'modeldb.backup.v2',
      protected: protectedHeader,
      recipients,
      iv: b64(iv),
      ciphertext: b64(ciphertext),
      tag: b64(cipher.getAuthTag()),
    };
    const content = Buffer.from(JSON.stringify(pkg));
    if (content.length > MAX_BACKUP_BYTES) {
      throw new SecurityError('SECURITY_RESPONSE_LIMIT');
    }
    return content;
  } finally {
    plain.fill(0);
    pek.fill(0);
  }
}
/** Fully authenticate the package, dependency key, inner Vault and derived statistics. */
export function openBackupPackage(
  content: Uint8Array,
  unlock: BackupUnlock,
): {
  manifest: BackupManifest;
  vaultBytes: Buffer;
  material: VaultKeyMaterial;
  vault: AtlasSingleVault;
} {
  let pek: Buffer | undefined, plain: Buffer | undefined, key: Buffer | undefined;
  try {
    if (!content.byteLength || content.byteLength > MAX_BACKUP_BYTES) {
      throw new SecurityError('SECURITY_RESPONSE_LIMIT');
    }
    const value = JSON.parse(Buffer.from(content).toString('utf8'));
    if (value?.format === 'modeldb.backup.v1') {
      throw new SecurityError('SECURITY_PROTOCOL_UNSUPPORTED');
    }
    const pkg = exact(value, ['format', 'protected', 'recipients', 'iv', 'ciphertext', 'tag']);
    if (pkg.format !== 'modeldb.backup.v2') {
      return invalid();
    }
    const header = exact(JSON.parse(decode(pkg.protected, 16384).toString('utf8')), [
      'enc',
      'typ',
      'manifest',
      'recipientBindings',
    ]);
    if (
      header.enc !== 'A256GCM' ||
      header.typ !== pkg.format ||
      !Array.isArray(pkg.recipients) ||
      pkg.recipients.length < 1 ||
      pkg.recipients.length > 2
    ) {
      return invalid();
    }
    const raw = header.manifest;
    const manifestObject = exact(raw, [
      'database',
      'createdAt',
      'kind',
      'packageId',
      'sourceReference',
      'vaultDigest',
      'statistics',
      ...(raw && typeof raw === 'object' && 'name' in raw ? ['name'] : []),
    ]);
    const manifest = manifestObject as unknown as BackupManifest;
    assertFlatGraphSegment(manifest.database, 'database');
    normalizeSecureBackupName(manifest.name);
    if (
      !Number.isFinite(Date.parse(manifest.createdAt)) ||
      !['nested', 'flat'].includes(manifest.kind) ||
      !/^[a-f0-9-]{36}$/.test(manifest.packageId) ||
      !isVaultKeyReference(manifest.sourceReference) ||
      !/^[a-f0-9]{64}$/.test(manifest.vaultDigest)
    ) {
      return invalid();
    }
    exact(manifest.sourceReference, ['instanceId', 'databaseId', 'keyId', 'keyVersion']);
    exact(manifest.statistics, ['vaultBytes', 'entries', 'models', 'relations']);
    if (
      Object.values(manifest.statistics).some(
        (n) => !Number.isSafeInteger(n) || n < 0 || n > MAX_BACKUP_VAULT_BYTES,
      )
    ) {
      return invalid();
    }
    const bindings: RecipientHeader[] = [];
    for (const [index, recipientValue] of pkg.recipients.entries()) {
      const entry = exact(recipientValue, ['header', 'encrypted_key']);
      const binding = exact(entry.header, ['alg', 'kid']) as unknown as RecipientHeader;
      if (
        index === 0
          ? binding.alg !== 'A256KW' || binding.kid !== manifest.sourceReference.keyId
          : binding.alg !== 'RSA-OAEP-256' || !/^[a-f0-9]{64}$/.test(binding.kid)
      ) {
        return invalid();
      }
      decode(entry.encrypted_key, 512, index === 0 ? 40 : undefined);
      bindings.push(binding);
    }
    if (JSON.stringify(header.recipientBindings) !== JSON.stringify(bindings)) {
      return invalid();
    }
    for (const [index, binding] of bindings.entries()) {
      let candidate: Buffer | undefined;
      try {
        const encrypted = decode(pkg.recipients[index].encrypted_key, 512);
        if (binding.alg === 'A256KW' && unlock.provider) {
          candidate = Buffer.from(
            unlock.provider.resolveKey(manifest.database, manifest.sourceReference).key,
          );
          const unwrap = createDecipheriv('id-aes256-wrap', candidate, Buffer.alloc(8, 0xa6));
          pek = Buffer.concat([unwrap.update(encrypted), unwrap.final()]);
        } else if (
          binding.alg === 'RSA-OAEP-256' &&
          unlock.privateKey &&
          backupRecipientId(unlock.privateKey) === binding.kid
        ) {
          pek = privateDecrypt(
            {
              key: unlock.privateKey,
              oaepHash: 'sha256',
              padding: constants.RSA_PKCS1_OAEP_PADDING,
            },
            encrypted,
          );
        }
        if (pek?.length === 32) {
          break;
        }
        pek?.fill(0);
        pek = undefined;
      } catch {
        pek?.fill(0);
        pek = undefined;
      } finally {
        candidate?.fill(0);
      }
    }
    if (!pek) {
      throw new SecurityError('SECURITY_MAINTENANCE_FAILED');
    }
    const cipher = createDecipheriv('aes-256-gcm', pek, decode(pkg.iv, 12, 12));
    cipher.setAAD(Buffer.from(pkg.protected as string));
    cipher.setAuthTag(decode(pkg.tag, 16, 16));
    plain = Buffer.concat([
      cipher.update(decode(pkg.ciphertext, MAX_BACKUP_BYTES)),
      cipher.final(),
    ]);
    const body = exact(JSON.parse(plain.toString('utf8')), ['version', 'vault', 'key']);
    if (body.version !== 2) {
      return invalid();
    }
    key = decode(body.key, 32, 32);
    const vaultBytes = decode(body.vault, MAX_BACKUP_VAULT_BYTES);
    if (
      fileDigest(vaultBytes) !== manifest.vaultDigest ||
      vaultKeyReferenceAAD(readAtlasVaultKeyReferenceFromBytes(vaultBytes)) !==
        vaultKeyReferenceAAD(manifest.sourceReference)
    ) {
      return invalid();
    }
    const material = { reference: manifest.sourceReference, key };
    const vault = new AtlasSingleVault();
    vault.loadBytes(vaultBytes, material);
    vault.relocateAtlas(manifest.database, manifest.database);
    const statistics = backupStatistics(vault, vaultBytes.length);
    if (
      Object.keys(statistics).some(
        (name) =>
          statistics[name as keyof BackupStatistics] !==
          manifest.statistics[name as keyof BackupStatistics],
      )
    ) {
      return invalid();
    }
    key = undefined;
    return { manifest, vaultBytes, material, vault };
  } catch (error) {
    if (error instanceof SecurityError) {
      throw error;
    }
    throw new SecurityError('SECURITY_INVALID_REQUEST');
  } finally {
    pek?.fill(0);
    plain?.fill(0);
    key?.fill(0);
  }
}

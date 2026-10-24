import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import {
  assertVaultKeyMaterial,
  computeAtlasManifestChecksum,
  fileDigest,
  isVaultKeyReference,
  readAtomicFileSync,
  parseAtlasManifestJson,
  vaultKeyReferenceAAD,
  VaultSecurityError,
  writeAtomicFileSync,
  type AtomicCommitPoint,
  type AtlasManifestFileJson,
  type VaultKeyMaterial,
  type VaultKeyReference,
} from '@mode-db/common';

/** Random-DEK format; MDB4SVLT is rejected as legacy. */
export const ATLAS_SINGLE_VAULT_MAGIC = Buffer.from('MDB5SVLT', 'ascii');
const LEGACY_MAGIC = Buffer.from('MDB4SVLT', 'ascii');
const MAX_HEADER = 2048;

export interface VaultCatalogV1 {
  readonly v: 1;
  entries: Record<string, string>;
}

interface VaultHeader {
  version: 2;
  algorithm: 'A256GCM';
  reference: VaultKeyReference;
}

function parseHeader(bytes: Buffer): { header: VaultHeader; aad: Buffer; offset: number } {
  if (bytes.subarray(0, 8).equals(LEGACY_MAGIC)) {
    throw new VaultSecurityError('VAULT_LEGACY_FORMAT');
  }
  try {
    if (bytes.length < 12 || !bytes.subarray(0, 8).equals(ATLAS_SINGLE_VAULT_MAGIC)) {
      throw new Error();
    }
    const length = bytes.readUInt32BE(8);
    if (length < 1 || length > MAX_HEADER || bytes.length < 12 + length + 28) {
      throw new Error();
    }
    const header = JSON.parse(bytes.subarray(12, 12 + length).toString('utf8')) as VaultHeader;
    if (
      header.version !== 2 ||
      header.algorithm !== 'A256GCM' ||
      !isVaultKeyReference(header.reference)
    ) {
      throw new Error();
    }
    return { header, aad: bytes.subarray(0, 12 + length), offset: 12 + length };
  } catch {
    throw new VaultSecurityError('VAULT_FORMAT_INVALID');
  }
}

/** Inspect public identity only; loading must still authenticate the full file. */
export function readAtlasVaultKeyReference(path: string): VaultKeyReference | undefined {
  const candidate = existsSync(path)
    ? path
    : existsSync(`${path}.pending`)
      ? `${path}.pending`
      : undefined;
  if (!candidate) {
    if (['.commit', '.lock', '.reclaim'].some((suffix) => existsSync(path + suffix))) {
      throw new VaultSecurityError('VAULT_COMMIT_INCOMPLETE');
    }
    return undefined;
  }
  try {
    return parseHeader(readFileSync(candidate)).header.reference;
  } catch (error) {
    if (error instanceof VaultSecurityError) {
      throw error;
    }
    throw new VaultSecurityError('VAULT_FORMAT_INVALID');
  }
}

/** Public identity from an in-memory snapshot; authentication still requires loading the bytes. */
export function readAtlasVaultKeyReferenceFromBytes(bytes: Uint8Array): VaultKeyReference {
  return parseHeader(Buffer.from(bytes)).header.reference;
}

/** Recognize both versions so callers receive the explicit legacy-format error. */
export async function fileLooksLikeAtlasSingleVault(path: string): Promise<boolean> {
  if (!existsSync(path)) {
    return false;
  }
  const fh = await open(path, 'r');
  try {
    const magic = Buffer.alloc(8);
    const { bytesRead } = await fh.read(magic, 0, 8, 0);
    return (
      bytesRead === 8 && (magic.equals(ATLAS_SINGLE_VAULT_MAGIC) || magic.equals(LEGACY_MAGIC))
    );
  } finally {
    await fh.close();
  }
}

/** Encrypted catalog with authenticated identity and recoverable commits. */
export class AtlasSingleVault {
  private readonly entries = new Map<string, string>();
  private digest: string | null = null;
  private poisoned = false;
  static manifestKey = '__manifest__';
  static modelKey(name: string): string {
    return `m:${name}`;
  }
  static relationKey(name: string): string {
    return `r:${name}`;
  }
  get(key: string): string | undefined {
    return this.entries.get(key);
  }
  set(key: string, value: string): void {
    this.entries.set(key, value);
  }
  delete(key: string): void {
    this.entries.delete(key);
  }
  keys(): IterableIterator<string> {
    return this.entries.keys();
  }

  /** Missing files return false; invalid files throw without clearing live data. */
  loadSync(path: string, material: VaultKeyMaterial): boolean {
    assertVaultKeyMaterial(material);
    const bytes = readAtomicFileSync(path, (candidate) => {
      this.decode(candidate, material);
    });
    if (!bytes) {
      return false;
    }
    const parsed = this.decode(bytes, material);
    this.entries.clear();
    for (const [key, value] of Object.entries(parsed.entries)) {
      this.entries.set(key, value);
    }
    this.digest = fileDigest(bytes);
    this.poisoned = false;
    return true;
  }

  /** Authenticate a portable snapshot without creating plaintext or source-key files. */
  loadBytes(bytes: Uint8Array, material: VaultKeyMaterial): void {
    assertVaultKeyMaterial(material);
    const parsed = this.decode(Buffer.from(bytes), material);
    this.entries.clear();
    for (const [key, value] of Object.entries(parsed.entries)) {
      this.entries.set(key, value);
    }
    this.digest = null;
    this.poisoned = false;
  }

  /** Validate the embedded catalog and preserve schema/data identity when restoring under a new name. */
  relocateAtlas(source: string, destination: string): void {
    const raw = this.get(AtlasSingleVault.manifestKey);
    if (raw === undefined) {
      return;
    }
    parseAtlasManifestJson(raw, source);
    if (source === destination) {
      return;
    }
    const manifest = { ...JSON.parse(raw), atlas: destination } as AtlasManifestFileJson;
    const updated = JSON.stringify({
      ...manifest,
      checksum: computeAtlasManifestChecksum(manifest),
    });
    parseAtlasManifestJson(updated, destination);
    this.set(AtlasSingleVault.manifestKey, updated);
  }

  /** Encrypt the current catalog for a destination key domain. */
  exportBytes(material: VaultKeyMaterial): Buffer {
    assertVaultKeyMaterial(material);
    const header: VaultHeader = { version: 2, algorithm: 'A256GCM', reference: material.reference };
    const rawHeader = Buffer.from(JSON.stringify(header), 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(rawHeader.length);
    const aad = Buffer.concat([ATLAS_SINGLE_VAULT_MAGIC, length, rawHeader]);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', material.key, iv);
    cipher.setAAD(aad);
    const plain = Buffer.from(JSON.stringify({ v: 1, entries: Object.fromEntries(this.entries) }));
    try {
      const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
      return Buffer.concat([aad, iv, cipher.getAuthTag(), ciphertext]);
    } finally {
      plain.fill(0);
    }
  }

  /** Caller supplies the authenticated destination revision, never the source snapshot revision. */
  saveReplacingSync(
    path: string,
    material: VaultKeyMaterial,
    expectedDigest: string | null,
    onPoint?: (point: AtomicCommitPoint) => void,
  ): void {
    if (this.poisoned) {
      throw new VaultSecurityError('VAULT_COMMIT_INCOMPLETE');
    }
    const bytes = this.exportBytes(material);
    try {
      writeAtomicFileSync(
        path,
        bytes,
        expectedDigest,
        (candidate) => {
          this.decode(candidate, material);
        },
        onPoint,
      );
      this.digest = fileDigest(bytes);
    } catch (error) {
      this.poisoned = true;
      throw error;
    }
  }

  /** Failed commits require reopening; stale memory cannot overwrite recovery. */
  saveSync(
    path: string,
    material: VaultKeyMaterial,
    onPoint?: (point: AtomicCommitPoint) => void,
  ): void {
    if (this.poisoned) {
      throw new VaultSecurityError('VAULT_COMMIT_INCOMPLETE');
    }
    assertVaultKeyMaterial(material);
    const header: VaultHeader = { version: 2, algorithm: 'A256GCM', reference: material.reference };
    const rawHeader = Buffer.from(JSON.stringify(header), 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(rawHeader.length);
    const aad = Buffer.concat([ATLAS_SINGLE_VAULT_MAGIC, length, rawHeader]);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', material.key, iv);
    cipher.setAAD(aad);
    const plain: VaultCatalogV1 = { v: 1, entries: Object.fromEntries(this.entries) };
    const enc = Buffer.concat([cipher.update(JSON.stringify(plain), 'utf8'), cipher.final()]);
    const bytes = Buffer.concat([aad, iv, cipher.getAuthTag(), enc]);
    try {
      writeAtomicFileSync(
        path,
        bytes,
        this.digest,
        (candidate) => {
          this.decode(candidate, material);
        },
        onPoint,
      );
      this.digest = fileDigest(bytes);
    } catch (error) {
      this.poisoned = true;
      if (error instanceof VaultSecurityError) {
        throw error;
      }
      throw new VaultSecurityError('VAULT_WRITE_FAILED');
    }
  }

  /** Re-encrypt the loaded catalog under a new DEK while authenticating the old file first. */
  saveRekeyedSync(
    path: string,
    previous: VaultKeyMaterial,
    next: VaultKeyMaterial,
    onPoint?: (point: AtomicCommitPoint) => void,
    expectedPreviousDigest?: string,
  ): void {
    if (this.poisoned) {
      throw new VaultSecurityError('VAULT_COMMIT_INCOMPLETE');
    }
    assertVaultKeyMaterial(previous);
    assertVaultKeyMaterial(next);
    if (vaultKeyReferenceAAD(previous.reference) === vaultKeyReferenceAAD(next.reference)) {
      throw new VaultSecurityError('VAULT_KEY_MISMATCH');
    }
    const materialFor = (candidate: Buffer): VaultKeyMaterial => {
      const ref = parseHeader(candidate).header.reference;
      if (vaultKeyReferenceAAD(ref) === vaultKeyReferenceAAD(next.reference)) {
        return next;
      }
      if (vaultKeyReferenceAAD(ref) === vaultKeyReferenceAAD(previous.reference)) {
        return previous;
      }
      throw new VaultSecurityError('VAULT_KEY_MISMATCH');
    };
    const validate = (candidate: Buffer): void => {
      this.decode(candidate, materialFor(candidate));
    };
    const current = readAtomicFileSync(path, validate);
    if (!current || (this.digest !== null && fileDigest(current) !== this.digest)) {
      throw new VaultSecurityError('VAULT_COMMIT_CONFLICT');
    }
    // A journal may already have promoted the new file. Authenticate it before completing the task.
    if (materialFor(current) === next) {
      this.digest = fileDigest(current);
      return;
    }
    if (expectedPreviousDigest !== undefined && fileDigest(current) !== expectedPreviousDigest) {
      throw new VaultSecurityError('VAULT_COMMIT_CONFLICT');
    }
    const catalog = this.decode(current, previous);
    this.entries.clear();
    for (const [key, value] of Object.entries(catalog.entries)) {
      this.entries.set(key, value);
    }
    this.digest = fileDigest(current);
    const header: VaultHeader = { version: 2, algorithm: 'A256GCM', reference: next.reference };
    const rawHeader = Buffer.from(JSON.stringify(header), 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(rawHeader.length);
    const aad = Buffer.concat([ATLAS_SINGLE_VAULT_MAGIC, length, rawHeader]);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', next.key, iv);
    cipher.setAAD(aad);
    const plain: VaultCatalogV1 = { v: 1, entries: Object.fromEntries(this.entries) };
    const enc = Buffer.concat([cipher.update(JSON.stringify(plain), 'utf8'), cipher.final()]);
    const bytes = Buffer.concat([aad, iv, cipher.getAuthTag(), enc]);
    try {
      writeAtomicFileSync(path, bytes, this.digest, validate, onPoint);
      this.digest = fileDigest(bytes);
    } catch (error) {
      this.poisoned = true;
      if (error instanceof VaultSecurityError) {
        throw error;
      }
      throw new VaultSecurityError('VAULT_WRITE_FAILED');
    }
  }

  private decode(bytes: Buffer, material: VaultKeyMaterial): VaultCatalogV1 {
    const { header, aad, offset } = parseHeader(bytes);
    if (vaultKeyReferenceAAD(header.reference) !== vaultKeyReferenceAAD(material.reference)) {
      throw new VaultSecurityError('VAULT_KEY_MISMATCH');
    }
    let plain: Buffer;
    try {
      const cipher = createDecipheriv(
        'aes-256-gcm',
        material.key,
        bytes.subarray(offset, offset + 12),
      );
      cipher.setAAD(aad);
      cipher.setAuthTag(bytes.subarray(offset + 12, offset + 28));
      plain = Buffer.concat([cipher.update(bytes.subarray(offset + 28)), cipher.final()]);
    } catch {
      throw new VaultSecurityError('VAULT_AUTHENTICATION_FAILED');
    }
    try {
      const value = JSON.parse(plain.toString('utf8')) as VaultCatalogV1;
      if (
        value.v !== 1 ||
        !value.entries ||
        typeof value.entries !== 'object' ||
        Array.isArray(value.entries) ||
        Object.values(value.entries).some((entry) => typeof entry !== 'string')
      ) {
        throw new Error();
      }
      return value;
    } catch {
      throw new VaultSecurityError('VAULT_FORMAT_INVALID');
    } finally {
      plain.fill(0);
    }
  }
}

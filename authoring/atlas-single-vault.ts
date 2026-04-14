/**
 * Single atlas file (`atlas.mld`): opaque prefix + AES-256-GCM encrypted catalog of named blobs.
 * Model rows and relation indices are stored as UTF-8 payloads under keys `m:*` and `r:*`;
 * manifest under `__manifest__`. No separate `.rid` or per-model files when this vault is active.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DiagnosticCenter, ErrorCodes, DiskAdapter } from '@mode-db/common';

/** First bytes of `atlas.mld` (single-file vault). */
export const ATLAS_SINGLE_VAULT_MAGIC = Buffer.from('MDB4SVLT', 'ascii');

const MAGIC = ATLAS_SINGLE_VAULT_MAGIC;
const FAKE_OFFSET_BLOCK = 256;
const SALT_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;
const UINT64 = 8;

export interface VaultCatalogV1 {
  readonly v: 1;
  entries: Record<string, string>;
}

/** True if `absPath` exists and begins with the vault magic (cheap O(1) probe; does not decrypt). */
export async function fileLooksLikeAtlasSingleVault(absPath: string): Promise<boolean> {
  if (!existsSync(absPath)) {
    return false;
  }
  const fh = await open(absPath, 'r');
  try {
    const buf = Buffer.alloc(MAGIC.length);
    const { bytesRead } = await fh.read(buf, 0, MAGIC.length, 0);
    return bytesRead === MAGIC.length && buf.equals(MAGIC);
  } finally {
    await fh.close();
  }
}

export class AtlasSingleVault {
  private readonly entries = new Map<string, string>();

  static manifestKey = '__manifest__';

  static modelKey(modelName: string): string {
    return `m:${modelName}`;
  }

  static relationKey(ridBaseName: string): string {
    return `r:${ridBaseName}`;
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

  /** @returns true if file existed and was decrypted */
  loadSync(absPath: string, secret: string): boolean {
    if (!existsSync(absPath)) {
      return false;
    }
    let buf: Buffer;
    try {
      buf = DiskAdapter.readFileSync(absPath);
    } catch (err) {
      this.reportCorrupt('read', absPath, err);
      return false;
    }
    try {
      const plain = AtlasSingleVault.decryptPackage(buf, secret);
      const parsed = JSON.parse(plain.toString('utf-8')) as VaultCatalogV1;
      if (parsed.v !== 1 || !parsed.entries || typeof parsed.entries !== 'object') {
        throw new Error('Invalid vault catalog shape');
      }
      this.entries.clear();
      for (const [k, v] of Object.entries(parsed.entries)) {
        if (typeof v === 'string') {
          this.entries.set(k, v);
        }
      }
      return true;
    } catch (err) {
      this.reportCorrupt('decode', absPath, err);
      this.entries.clear();
      return false;
    }
  }

  saveSync(absPath: string, secret: string): void {
    const catalog: VaultCatalogV1 = { v: 1, entries: Object.fromEntries(this.entries) };
    const plain = Buffer.from(JSON.stringify(catalog), 'utf-8');
    const salt = randomBytes(SALT_LEN);
    const key = scryptSync(secret, salt, 32);
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
    const tag = cipher.getAuthTag();
    const inner = Buffer.concat([salt, iv, tag, enc]);
    const fake = randomBytes(FAKE_OFFSET_BLOCK);
    const lenBe = Buffer.allocUnsafe(UINT64);
    lenBe.writeBigUInt64BE(BigInt(inner.length), 0);
    const out = Buffer.concat([MAGIC, fake, lenBe, inner]);
    mkdirSync(dirname(absPath), { recursive: true });
    DiskAdapter.writeFileSync(absPath, out);
  }

  private reportCorrupt(phase: string, path: string, cause: unknown): void {
    const detail = cause instanceof Error ? cause.message : String(cause);
    DiagnosticCenter.report(
      ErrorCodes.PHYSICAL_ADDRESS_CORRUPT,
      { detail, filePath: path, phase },
      'collect',
    );
  }

  private static decryptPackage(buf: Buffer, secret: string): Buffer {
    const min = MAGIC.length + FAKE_OFFSET_BLOCK + UINT64 + SALT_LEN + IV_LEN + TAG_LEN;
    if (buf.length < min) {
      throw new Error('Vault file truncated');
    }
    if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new Error('Bad vault magic');
    }
    let o = MAGIC.length + FAKE_OFFSET_BLOCK;
    const innerLen = Number(buf.readBigUInt64BE(o));
    o += UINT64;
    if (innerLen <= 0 || o + innerLen > buf.length) {
      throw new Error('Invalid inner length');
    }
    const inner = buf.subarray(o, o + innerLen);
    const salt = inner.subarray(0, SALT_LEN);
    const iv = inner.subarray(SALT_LEN, SALT_LEN + IV_LEN);
    const tag = inner.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + TAG_LEN);
    const enc = inner.subarray(SALT_LEN + IV_LEN + TAG_LEN);
    const key = scryptSync(secret, salt, 32);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]);
  }
}

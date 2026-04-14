/**
 * Wire payload XOR keyed by session material (not TLS).
 * Single source of truth for wire payload XOR; consumed by **@mode-db/sdk** and **@mode-db/server** (and re-exported from the monorepo root for convenience).
 */
import { createHash } from 'node:crypto';

function mixBytesWithKey(buf: Buffer, keyMaterial: string): Buffer {
  const key = createHash('sha256').update(keyMaterial, 'utf-8').digest();
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) {
    out[i] = buf[i]! ^ key[i % key.length]! ^ (i & 0xff);
  }
  return out;
}

/** Derive shared wire key from connect token + logical DB name (atlas or dbName; same string on both sides). */
export function deriveWireSessionKey(connectToken: string, logicalDb: string): string {
  return createHash('sha256')
    .update(`${connectToken}:${logicalDb}:mode-db-wire-v2`, 'utf-8')
    .digest('hex');
}

export function encodeWirePayload(plainUtf8: string, sessionKey: string): string {
  const mixed = mixBytesWithKey(Buffer.from(plainUtf8, 'utf-8'), sessionKey);
  return mixed.toString('base64url');
}

export function decodeWirePayload(encoded: string, sessionKey: string): string {
  const mixed = Buffer.from(encoded, 'base64url');
  return mixBytesWithKey(mixed, sessionKey).toString('utf-8');
}

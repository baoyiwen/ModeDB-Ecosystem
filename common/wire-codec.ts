/**
 * XOR transport obfuscation for ModelDB wire protocol (not a substitute for TLS).
 * Same algorithm family as {@link shadow-codec} but keyed by session material.
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

/** Derive shared wire key from connect token + atlas (both sides must use same formula). */
export function deriveWireSessionKey(connectToken: string, atlas: string): string {
  return createHash('sha256')
    .update(`${connectToken}:${atlas}:mode-db-wire-v2`, 'utf-8')
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

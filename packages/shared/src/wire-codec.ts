/**
 * Wire payload XOR keyed by session material (not TLS).
 * Single source of truth for wire payload XOR; consumed by **@mode-db/sdk** / **@mode-db/server**.
 * Uses **Uint8Array**, **TextEncoder** / **TextDecoder**, and **@noble/hashes** (no Node Buffer).
 */
import { sha256 } from '@noble/hashes/sha256';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8');

function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i]!.toString(16).padStart(2, '0');
  }
  return s;
}

/** RFC 4648 base64url without Node `Buffer` `'base64url'`. */
function bytesToBase64Url(buf: Uint8Array): string {
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < buf.length; i += chunk) {
    const sub = buf.subarray(i, i + chunk);
    binary += String.fromCharCode(...sub);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(encoded: string): Uint8Array {
  const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4;
  const padded = pad ? b64 + '='.repeat(4 - pad) : b64;
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i) & 0xff;
  }
  return out;
}

function mixBytesWithKey(buf: Uint8Array, keyMaterial: string): Uint8Array {
  const key = sha256(textEncoder.encode(keyMaterial));
  const out = new Uint8Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    out[i] = buf[i]! ^ key[i % key.length]! ^ (i & 0xff);
  }
  return out;
}

/** Derive shared wire key from connect token + logical DB name (atlas or dbName; same string on both sides). */
export function deriveWireSessionKey(connectToken: string, logicalDb: string): string {
  const msg = `${connectToken}:${logicalDb}:mode-db-wire-v2`;
  return bytesToHex(sha256(textEncoder.encode(msg)));
}

export function encodeWirePayload(plainUtf8: string, sessionKey: string): string {
  const mixed = mixBytesWithKey(textEncoder.encode(plainUtf8), sessionKey);
  return bytesToBase64Url(mixed);
}

export function decodeWirePayload(encoded: string, sessionKey: string): string {
  const mixed = base64UrlToBytes(encoded);
  return textDecoder.decode(mixBytesWithKey(mixed, sessionKey));
}

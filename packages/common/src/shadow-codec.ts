/**
 * Obfuscated on-disk encoding for `.mld` data lines (not cryptographic security).
 * Lines prefixed with {@link SHADOW_LINE_PREFIX} store Base64URL(bytes) where bytes
 * are UTF-8 JSON XOR-mixed with a deterministic mask.
 */
import { createHash } from 'node:crypto';
import type { ModelRecord } from './types.js';

export const SHADOW_LINE_PREFIX = 'MDB2S1:';

const SCHEMA_HEADER_KEY = '__schema__';

/** XOR mask: reversible, fast, hides UTF-8 plaintext from casual file inspection. */
function mixBytes(buf: Buffer): Buffer {
  const out = Buffer.alloc(buf.length);
  const key = createHash('sha256').update('mode-db-shadow-v1').digest();
  for (let i = 0; i < buf.length; i++) {
    out[i] = buf[i]! ^ key[i % key.length]! ^ (i & 0xff);
  }
  return out;
}

export function encodeShadowPayload(jsonUtf8: string): string {
  const mixed = mixBytes(Buffer.from(jsonUtf8, 'utf-8'));
  return mixed.toString('base64url');
}

export function decodeShadowPayload(encoded: string): string {
  const mixed = Buffer.from(encoded, 'base64url');
  const plain = mixBytes(mixed);
  return plain.toString('utf-8');
}

/** Encode any JSON-serializable row or header object to one `.mld` line. */
export function encodeMldLine(obj: unknown, shadow: boolean): string {
  const json = JSON.stringify(obj);
  if (!shadow) {
    return json;
  }
  return SHADOW_LINE_PREFIX + encodeShadowPayload(json);
}

export type ParsedMldLine =
  | { readonly kind: 'header' }
  | { readonly kind: 'record'; record: ModelRecord };

/**
 * Parse one non-empty `.mld` line: plain JSON or {@link SHADOW_LINE_PREFIX} obfuscated form.
 */
export function parseMldLine(trimmed: string): ParsedMldLine | null {
  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.startsWith(SHADOW_LINE_PREFIX)) {
    const payload = trimmed.slice(SHADOW_LINE_PREFIX.length);
    let obj: unknown;
    try {
      obj = JSON.parse(decodeShadowPayload(payload)) as unknown;
    } catch {
      return null;
    }
    if (obj !== null && typeof obj === 'object' && SCHEMA_HEADER_KEY in (obj as object)) {
      return { kind: 'header' };
    }
    return { kind: 'record', record: obj as ModelRecord };
  }

  if (trimmed.startsWith(`{"${SCHEMA_HEADER_KEY}":`)) {
    return { kind: 'header' };
  }

  try {
    const record = JSON.parse(trimmed) as ModelRecord;
    return { kind: 'record', record };
  } catch {
    return null;
  }
}

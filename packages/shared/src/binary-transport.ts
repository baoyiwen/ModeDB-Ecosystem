import { sha256 } from '@noble/hashes/sha256';

const textEncoder = new TextEncoder();

function hashKeyMaterialUtf8(keyMaterial: string): Uint8Array {
  return sha256(textEncoder.encode(keyMaterial));
}

function u8Equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function readUint32BE(u8: Uint8Array, offset: number): number {
  return new DataView(u8.buffer, u8.byteOffset + offset, 4).getUint32(0, false);
}

function writeUint32BE(u8: Uint8Array, offset: number, value: number): void {
  new DataView(u8.buffer, u8.byteOffset + offset, 4).setUint32(0, value, false);
}

/** 4-byte ASCII wire magic (UTF-8 equals ASCII for these labels). */
function asciiLabel4(label: string): Uint8Array {
  const u = textEncoder.encode(label);
  if (u.length !== 4) {
    throw new Error(`binary-transport: expected 4-byte ASCII label, got length ${u.length}`);
  }
  return u;
}

/** Outer binary frame: XOR-mixed payload (same key material = symmetric). */
export const TRANSPORT_OUTER_MAGIC = asciiLabel4('MDBX');

/** Inner envelope (UTF-8 JSON) optional wrapper marker. */
export const TRANSPORT_INNER_MAGIC = asciiLabel4('MDB1');

/**
 * XOR + per-byte rotation mix (same family as wire codec). Reversible.
 * `keyMaterial` must match on encode/decode (e.g. `mdb2-outer:${connectToken}:v1`).
 */
export function transportKeyXorMix(buf: Uint8Array, keyMaterial: string): Uint8Array {
  const key = hashKeyMaterialUtf8(keyMaterial);
  const out = new Uint8Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    out[i] = buf[i]! ^ key[i % key.length]! ^ ((i * 7 + 13) & 0xff);
  }
  return out;
}

const outerKey = (connectToken: string): string => `mdb2-outer:${connectToken}:v1`;

/**
 * If buffer starts with **`MDBX`**, strips header and XOR-decodes the payload using
 * **`mdb2-outer:${connectToken}:v1`**. Otherwise returns **`raw`** unchanged.
 */
export function decodeInboundTransportBuffer(raw: Uint8Array, connectToken: string): Uint8Array {
  if (
    raw.length >= 8 &&
    u8Equal(raw.subarray(0, 4), TRANSPORT_OUTER_MAGIC) &&
    readUint32BE(raw, 4) <= raw.length - 8
  ) {
    const len = readUint32BE(raw, 4);
    const payload = raw.subarray(8, 8 + len);
    const copy = new Uint8Array(payload);
    return transportKeyXorMix(copy, outerKey(connectToken));
  }
  return raw;
}

/** Encode payload for clients that wrap with **`MDBX`**. */
export function encodeOutboundTransportBuffer(inner: Uint8Array, connectToken: string): Uint8Array {
  const mixed = transportKeyXorMix(inner, outerKey(connectToken));
  const out = new Uint8Array(8 + mixed.length);
  out.set(TRANSPORT_OUTER_MAGIC, 0);
  writeUint32BE(out, 4, mixed.length);
  out.set(mixed, 8);
  return out;
}

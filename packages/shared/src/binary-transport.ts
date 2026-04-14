import { createHash } from 'node:crypto';

/** Outer binary frame: XOR-mixed payload (same key material = symmetric). */
export const TRANSPORT_OUTER_MAGIC = Buffer.from('MDBX', 'ascii');

/** Inner envelope (UTF-8 JSON) optional wrapper (legacy). */
export const TRANSPORT_INNER_MAGIC = Buffer.from('MDB1', 'ascii');

/**
 * XOR + per-byte rotation mix (same family as wire codec). Reversible.
 * `keyMaterial` must match on encode/decode (e.g. `mdb2-outer:${connectToken}:v1`).
 */
export function transportKeyXorMix(buf: Buffer, keyMaterial: string): Buffer {
  const key = createHash('sha256').update(keyMaterial, 'utf-8').digest();
  const out = Buffer.alloc(buf.length);
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
export function decodeInboundTransportBuffer(raw: Buffer, connectToken: string): Buffer {
  if (
    raw.length >= 8 &&
    raw.subarray(0, 4).equals(TRANSPORT_OUTER_MAGIC) &&
    raw.readUInt32BE(4) <= raw.length - 8
  ) {
    const len = raw.readUInt32BE(4);
    const payload = raw.subarray(8, 8 + len);
    return transportKeyXorMix(Buffer.from(payload), outerKey(connectToken));
  }
  return raw;
}

/** Encode payload for clients that wrap with **`MDBX`**. */
export function encodeOutboundTransportBuffer(inner: Buffer, connectToken: string): Buffer {
  const mixed = transportKeyXorMix(inner, outerKey(connectToken));
  const out = Buffer.allocUnsafe(8 + mixed.length);
  TRANSPORT_OUTER_MAGIC.copy(out, 0);
  out.writeUInt32BE(mixed.length, 4);
  mixed.copy(out, 8);
  return out;
}

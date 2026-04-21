/**
 * 文本与 UTF-8 字节互转；禁止使用 Node Buffer，统一 Uint8Array / DataView。
 */
export function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** 对 `Uint8Array` 建立 `DataView`（后续二进制帧头、数值字段均经此路径，禁止 Buffer）。 */
export function dataViewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** RFC 4648 base64url（与 wire codec 一致，无 Node Buffer）。 */
export function bytesToBase64Url(buf: Uint8Array): string {
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < buf.length; i += chunk) {
    const sub = buf.subarray(i, i + chunk);
    binary += String.fromCharCode(...sub);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlToBytes(encoded: string): Uint8Array {
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

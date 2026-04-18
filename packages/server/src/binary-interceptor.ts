import {
  decodeInboundTransportBuffer,
  TRANSPORT_INNER_MAGIC,
  deriveWireSessionKey,
  decodeWirePayload,
  type WireExecuteBody,
} from '@mode-db/shared';
import { EngineLogger } from '@mode-db/common';
import { TransportAuthError } from './transport-errors.js';

export { TransportAuthError };

const utf8Decoder = new TextDecoder('utf-8');

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

/**
 * Transport pipeline: **outer `MDBX` XOR** (see `@mode-db/shared`) → optional **`MDB1`**
 * length-prefixed UTF-8 → JSON text for wire RPC / handshake.
 */
export class BinaryInterceptor {
  constructor(private readonly expectedConnectToken: string) {}

  validateConnectToken(token: string | undefined): void {
    const got = typeof token === 'string' ? token.trim() : '';
    const expected = this.expectedConnectToken.trim();
    if (!got || got !== expected) {
      throw new TransportAuthError('Invalid or missing connect token.');
    }
  }

  /**
   * Outer XOR decode (keyed by server **connect token**), then optional **`MDB1`** inner frame;
   * otherwise treat as UTF-8 JSON text.
   */
  unwrapTransportPayload(buf: Uint8Array): string {
    const t0 = performance.now();
    const decoded = decodeInboundTransportBuffer(buf, this.expectedConnectToken);
    let out: string;
    if (
      decoded.length >= 8 &&
      u8Equal(decoded.subarray(0, 4), TRANSPORT_INNER_MAGIC) &&
      readUint32BE(decoded, 4) <= decoded.length - 8
    ) {
      const innerLen = readUint32BE(decoded, 4);
      const inner = decoded.subarray(8, 8 + innerLen);
      out = utf8Decoder.decode(inner);
    } else {
      out = utf8Decoder.decode(decoded);
    }
    EngineLogger.instance.recordBinaryInterceptor(performance.now() - t0, buf.length);
    return out;
  }

  decodeWireCommand(cipher: string, connectToken: string, atlas: string): WireExecuteBody {
    const sessionKey = deriveWireSessionKey(connectToken, atlas);
    const plain = decodeWirePayload(cipher, sessionKey);
    return JSON.parse(plain) as WireExecuteBody;
  }
}

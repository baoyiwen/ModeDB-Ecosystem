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
  unwrapTransportPayload(buf: Buffer): string {
    const t0 = performance.now();
    const decoded = decodeInboundTransportBuffer(buf, this.expectedConnectToken);
    let out: string;
    if (
      decoded.length >= 8 &&
      decoded.subarray(0, 4).equals(TRANSPORT_INNER_MAGIC) &&
      decoded.readUInt32BE(4) <= decoded.length - 8
    ) {
      const innerLen = decoded.readUInt32BE(4);
      const inner = decoded.subarray(8, 8 + innerLen);
      out = inner.toString('utf8');
    } else {
      out = decoded.toString('utf8');
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

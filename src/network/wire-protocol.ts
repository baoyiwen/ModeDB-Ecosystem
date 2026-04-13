import type { RemoteExecuteSnapshot } from '../runtime/query.js';

export type WireClientMessage = WireHandshakeRequest | WireRpcEnvelope;

export interface WireHandshakeRequest {
  readonly type: 'handshake';
  readonly connectToken: string;
  readonly atlas: string;
}

export interface WireRpcEnvelope {
  readonly type: 'rpc';
  readonly id: string;
  /** {@link encodeWirePayload} of UTF-8 JSON {@link WireExecuteBody}. */
  readonly cipher: string;
}

export interface WireExecuteBody {
  readonly op: 'executeQuery';
  readonly snapshot: RemoteExecuteSnapshot;
}

export type WireServerMessage = WireHandshakeOk | WireRpcResponse | WireErrorMessage;

export interface WireHandshakeOk {
  readonly type: 'handshake.ok';
  readonly atlas: string;
}

export interface WireRpcResponse {
  readonly type: 'rpc.ok' | 'rpc.err';
  readonly id: string;
  readonly cipher?: string;
  readonly error?: string;
}

export interface WireErrorMessage {
  readonly type: 'error';
  readonly message: string;
}

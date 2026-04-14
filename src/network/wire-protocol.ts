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

export type WireExecuteBody =
  | {
      readonly op: 'executeQuery';
      readonly snapshot: RemoteExecuteSnapshot;
    }
  | {
      readonly op: 'insert';
      readonly model: string;
      readonly data: Record<string, unknown>;
      readonly sync?: boolean;
    }
  | {
      readonly op: 'update';
      readonly model: string;
      readonly id: string;
      readonly partial: Record<string, unknown>;
      readonly sync?: boolean;
    }
  | {
      readonly op: 'insertMany';
      readonly model: string;
      readonly rows: readonly Record<string, unknown>[];
      readonly sync?: boolean;
    };

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

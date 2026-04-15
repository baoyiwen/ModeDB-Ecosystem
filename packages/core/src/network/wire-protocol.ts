import type { RemoteExecuteSnapshot } from '@mode-db/shared';

export type WireClientMessage = WireHandshakeRequest | WireRpcEnvelope;

export interface WireHandshakeRequest {
  readonly type: 'handshake';
  readonly connectToken: string;
  /**
   * Logical library name → **`<workspace>/<dbName>/`** on the server (vault **`atlas.mld`** recommended for large scale).
   * Preferred for new clients; **`atlas`** remains an alias when **`dbName`** is omitted.
   */
  readonly dbName?: string;
  /** @deprecated Prefer **`dbName`**. Same string space as logical library directory name. */
  readonly atlas?: string;
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
  readonly dbName?: string;
  readonly atlas?: string;
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

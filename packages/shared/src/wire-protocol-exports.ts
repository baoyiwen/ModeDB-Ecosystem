/**
 * Wire types for clients/servers that only depend on **@mode-db/shared**.
 * Snapshot payloads are `unknown` here; the WebSocket host narrows and executes them at RPC dispatch.
 */
export type WireClientMessage = WireHandshakeRequest | WireRpcEnvelope;

export interface WireHandshakeRequest {
  readonly type: 'handshake';
  readonly connectToken: string;
  /**
   * Logical library name → directory **`<workspace>/<dbName>/`** (expects vault **`atlas.mld`** for production layouts).
   * Preferred over **`atlas`** for new integrations.
   */
  readonly dbName?: string;
  /** @deprecated Use **`dbName`**. When **`dbName`** is omitted, this is the logical library / atlas directory name. */
  readonly atlas?: string;
}

export interface WireRpcEnvelope {
  readonly type: 'rpc';
  readonly id: string;
  readonly cipher: string;
}

export type WireExecuteBody =
  | {
      readonly op: 'executeQuery';
      readonly snapshot: unknown;
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
    }
  | {
      readonly op: 'dropModel';
      readonly model: string;
    }
  | {
      readonly op: 'dropRelation';
      readonly relation: string;
    }
  | {
      readonly op: 'alterModel';
      readonly model: string;
      readonly schema: Readonly<Record<string, unknown>>;
    };

export type WireServerMessage = WireHandshakeOk | WireRpcResponse | WireErrorMessage;

export interface WireHandshakeOk {
  readonly type: 'handshake.ok';
  readonly dbName?: string;
  /** Echoed when client used legacy **`atlas`** field. */
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

/** JSON-safe execute result for wire transport (must match the host serializer contract). */
export type WireExecuteResultJson =
  | {
      readonly kind: 'rows';
      readonly rows: readonly { readonly model: string; readonly data: Record<string, unknown> }[];
    }
  | {
      readonly kind: 'analysis';
      readonly dimensionKeys: readonly string[];
      readonly shape: 'flat';
      readonly rows: readonly Record<string, unknown>[];
    }
  | {
      readonly kind: 'paginated';
      readonly page: number;
      readonly total: number;
      readonly limit: number;
      readonly pageCount: number;
      readonly items: WireExecuteResultJson;
    }
  | {
      readonly kind: 'mutation';
      readonly op: 'insert' | 'update' | 'insertMany' | 'dropModel' | 'dropRelation' | 'alterModel';
      readonly model: string;
      readonly record: Record<string, unknown> | null;
      readonly successCount?: number;
      readonly failureCount?: number;
      readonly relation?: string;
      readonly ok?: boolean;
    };

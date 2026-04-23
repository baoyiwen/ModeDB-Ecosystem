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

/** Cardinality logic for relation registration / update (mirror of `@mode-db/common` **`RelationLogic`**). */
export type WireRelationLogic = 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many';

/** Field-equality predicate used for PROTOCOL / CONDITIONAL `bind` (mirror of `@mode-db/common` **`MatchPredicate`**). */
export interface WireMatchPredicate {
  readonly sourceField: string;
  readonly targetField: string;
}

/** Compact row handle used by `bindPair` / `unlinkPair` to identify a single record. */
export interface WireRowRef {
  readonly model: string;
  readonly id: string;
}

/** Strategies accepted by the server-side `bind` op (mirror of `@mode-db/common` **`BindStrategy`**, minus CONDITIONAL which is not wire-safe). */
export type WireBindStrategy = 'GLOBAL' | 'PROTOCOL' | 'MANUAL';

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
      /** When true, server echoes each successfully-staged row (with `_id`) back on the wire. */
      readonly returning?: boolean;
    }
  | {
      readonly op: 'batchUpdate';
      readonly updates: readonly {
        readonly model: string;
        readonly id: string;
        readonly partial: Record<string, unknown>;
      }[];
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
      /** When true, **`schema`** is merged onto the current model (see {@link AuthoringEngine.alterModelPatch}). */
      readonly patch?: boolean;
    }
  | {
      readonly op: 'registerModel';
      readonly model: string;
      readonly schema: Readonly<Record<string, unknown>>;
    }
  | {
      readonly op: 'registerRelation';
      readonly source: string;
      readonly target: string;
      readonly forward: string;
      readonly reverse: string;
      readonly logic: WireRelationLogic;
    }
  /**
   * Batch authoring DDL: register any missing **models** and **relations** in one gated write.
   * - Idempotent: models/relations that already exist are skipped.
   * - With **`quickLink: true`**, source/target models referenced by **`relations[*]`** are auto-registered
   *   when absent (same semantics as **`AuthoringEngine.quickLink`**).
   */
  | {
      readonly op: 'batchRegister';
      readonly models?: readonly {
        readonly name: string;
        readonly schema?: Readonly<Record<string, unknown>>;
        readonly parentId?: string | null;
      }[];
      readonly relations?: readonly {
        readonly source: string;
        readonly target: string;
        readonly forward: string;
        readonly reverse: string;
        readonly logic?: WireRelationLogic;
        readonly matchOn?: WireMatchPredicate;
      }[];
      readonly quickLink?: boolean;
    }
  /**
   * Bind one source record to one target record on an **already registered** relation.
   * Server enforces that `source.model` / `target.model` match the relation's registration order.
   */
  | {
      readonly op: 'bindPair';
      readonly forward: string;
      readonly reverse: string;
      readonly source: WireRowRef;
      readonly target: WireRowRef;
    }
  | {
      readonly op: 'unlinkPair';
      readonly forward: string;
      readonly reverse: string;
      readonly source: WireRowRef;
      readonly target: WireRowRef;
    }
  /**
   * Strategy-driven bulk bind (maps to **`AuthoringEngine.bind`**).
   *
   * - `PROTOCOL`: requires `matchOn` (sets / updates relation.matchOn when provided) and scans both sides.
   * - `GLOBAL`: cross-join bind (use with caution; `many-to-many` recommended).
   * - `MANUAL`: explicit `pairs` (srcId/targetId in registration order).
   */
  | {
      readonly op: 'bind';
      readonly forward: string;
      readonly strategy: WireBindStrategy;
      readonly matchOn?: WireMatchPredicate;
      readonly pairs?: ReadonlyArray<readonly [string, string]>;
      readonly sync?: boolean;
    }
  /** Read-only dry-run for **`bind`** — returns a capped sample of pairs plus the full count. */
  | {
      readonly op: 'previewBind';
      readonly forward: string;
      readonly strategy: WireBindStrategy;
      readonly matchOn?: WireMatchPredicate;
      readonly pairs?: ReadonlyArray<readonly [string, string]>;
      /** Max pairs returned in `sample` (default **20**). */
      readonly sample?: number;
    }
  /** Read-only: `RelationIndexer.getStats()` for a registered relation. */
  | {
      readonly op: 'relationStats';
      readonly forward: string;
    }
  /** Update a relation's logic / matchOn without rebinding existing edges. */
  | {
      readonly op: 'updateRelationLogic';
      readonly forward: string;
      readonly logic: WireRelationLogic;
      readonly matchOn?: WireMatchPredicate;
    };

export type WireServerMessage = WireHandshakeOk | WireRpcResponse | WireErrorMessage;

export interface WireHandshakeOk {
  readonly type: 'handshake.ok';
  readonly dbName?: string;
  /** Echoed when the client sent **`atlas`** (synonym for **`dbName`**). */
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

/** Aggregate counts for a relation index, mirror of `@mode-db/common` **`RelationStats`**. */
export interface WireRelationStats {
  readonly forwardKeys: number;
  readonly reverseKeys: number;
  readonly totalLinks: number;
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
      readonly op:
        | 'insert'
        | 'update'
        | 'insertMany'
        | 'batchUpdate'
        | 'dropModel'
        | 'dropRelation'
        | 'alterModel'
        | 'registerModel'
        | 'registerRelation'
        | 'batchRegister'
        | 'bindPair'
        | 'unlinkPair'
        | 'bind'
        | 'updateRelationLogic';
      readonly model: string;
      readonly record: Record<string, unknown> | null;
      /** Multi-row echo for **`insertMany({ returning: true })`** (each row carries its `_id`). */
      readonly records?: readonly Record<string, unknown>[];
      readonly successCount?: number;
      readonly failureCount?: number;
      readonly relation?: string;
      readonly ok?: boolean;
      /** Net edges created (or removed) by a `bind` / `bindPair` / `unlinkPair` RPC. */
      readonly pairsCount?: number;
      /** Post-op `RelationIndexer.getStats()` — included by `bind` for Designer UI counters. */
      readonly stats?: WireRelationStats;
      /** **`batchRegister`** diagnostics: which names were newly created vs. already-present. */
      readonly created?: {
        readonly models: readonly string[];
        readonly relations: readonly string[];
      };
      readonly skipped?: {
        readonly models: readonly string[];
        readonly relations: readonly string[];
      };
    }
  | {
      readonly kind: 'previewBind';
      readonly forward: string;
      /** Total pairs that `bind` would create with the same arguments (**not** capped by `sample`). */
      readonly pairsCount: number;
      readonly sample: readonly (readonly [string, string])[];
    }
  | {
      readonly kind: 'relationStats';
      readonly forward: string;
      readonly forwardKeys: number;
      readonly reverseKeys: number;
      readonly totalLinks: number;
    };

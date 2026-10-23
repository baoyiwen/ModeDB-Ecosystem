import {
  decodeWirePayload,
  deriveWireSessionKey,
  encodeWirePayload,
  isDatabaseOperation,
  isQueryInterfaceErrorDetail,
  queryInterfaceErrorDetailFromMessage,
  WireQueryChain,
  type EngineApplyOutcome,
  type EngineOperation,
  type EngineOperationResult,
  type ManagementBackupCreateResponse,
  type ManagementBackupImportResponse,
  type ManagementBackupInfo,
  type ManagementBackupRestoreResponse,
  type ManagementBackupsResponse,
  type ManagementCatalogResponse,
  type ManagementClearDatabaseResponse,
  type ManagementDatabaseInfo,
  type ManagementDatabasesResponse,
  type ManagementStatusResponse,
  type QueryExecuteOptions,
  type QueryInterfaceErrorDetail,
  type QueryStartSpec,
  type RemoteExecuteSnapshot,
  type WireBindStrategy,
  type WireBindingSurfaceAction,
  type WireEntityNode,
  type WireExecuteBody,
  type WireExecuteResultJson,
  type WireMatchPredicate,
  type WireRelationLogic,
  type WireRelationSelfLoopPolicy,
  type WireRelationStats,
  type WireRowRef,
} from '@mode-db/shared';
import {
  ConnectionSecurityError,
  connectionAuthHeaders,
  remoteResponseError,
} from './connection-security.js';
import { connectionOrigin, assertSecureCredentialOrigin } from './connection-endpoint.js';
import { browserSessionRequestInit } from './browser-session.js';

export type QueryInterfaceInvocationResult = Extract<
  WireExecuteResultJson,
  { readonly kind: 'interface' }
>;

export type OperationInterfaceInvocationResult = Extract<
  WireExecuteResultJson,
  { readonly kind: 'operationInterface' }
>;

export type BindingSurfaceInvocationResult = Extract<
  WireExecuteResultJson,
  { readonly kind: 'bindingSurface' }
>;

export class QueryInterfaceInvocationError extends Error {
  readonly code: string;
  readonly category: QueryInterfaceErrorDetail['category'];
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, string>> | undefined;

  constructor(detail: QueryInterfaceErrorDetail) {
    super(detail.message);
    this.name = 'QueryInterfaceInvocationError';
    this.code = detail.code;
    this.category = detail.category;
    this.retryable = detail.retryable;
    this.details = detail.details;
  }
}

function rpcError(message: string, detail: unknown): Error {
  const normalized = isQueryInterfaceErrorDetail(detail)
    ? detail
    : queryInterfaceErrorDetailFromMessage(message);
  return normalized ? new QueryInterfaceInvocationError(normalized) : new Error(message);
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function nextRpcId(): string {
  const c = globalThis.crypto;
  if (c && 'randomUUID' in c && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }
  return `rpc-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

interface InteractionTrace {
  readonly id: string;
  readonly scope: string;
  readonly action: string;
  readonly startedAt: number;
}

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function interactionLoggingEnabled(): boolean {
  const flags = globalThis as unknown as {
    __MODEDB_SILENCE_INTERACTION_LOGS?: boolean;
    MODEDB_INTERACTION_LOGS?: boolean;
    localStorage?: { getItem(key: string): string | null };
  };
  if (flags.__MODEDB_SILENCE_INTERACTION_LOGS === true || flags.MODEDB_INTERACTION_LOGS === false) {
    return false;
  }
  try {
    return flags.localStorage?.getItem('mode-db:interaction-logs') !== 'off';
  } catch {
    return true;
  }
}

function compactForLog(value: unknown, depth = 0): unknown {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    if (depth > 1) {
      return `[Array(${value.length})]`;
    }
    return value.slice(0, 8).map((item) => compactForLog(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>).slice(0, 16)) {
      if (/token|cipher|secret|password/i.test(key)) {
        out[key] = '[redacted]';
      } else {
        out[key] = depth > 1 ? `[${typeof raw}]` : compactForLog(raw, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

function explainInteraction(scope: string): string {
  if (scope === 'Management API') {
    return '前端正在调用引擎管理接口，用于读取数据库列表、catalog 或创建/删除库。';
  }
  if (scope === 'WebSocket RPC') {
    return '前端正在通过 WebSocket 调用引擎数据库操作，例如查询、写入、绑定关系或修改模型。';
  }
  if (scope === 'HTTP RPC') {
    return '前端正在通过 HTTP short mode 调用引擎数据库操作。';
  }
  if (scope === 'Connection') {
    return '前端正在建立与 ModelDB Engine 的连接或握手。';
  }
  return 'ModelDB 前端与引擎之间的一次交互。';
}

function logInteractionStart(
  scope: string,
  action: string,
  detail?: Record<string, unknown>,
): InteractionTrace {
  const trace: InteractionTrace = {
    id: nextRpcId().slice(0, 8),
    scope,
    action,
    startedAt: nowMs(),
  };
  if (interactionLoggingEnabled()) {
    // eslint-disable-next-line no-console
    console.groupCollapsed(`[ModeDB] START ${scope}: ${action} trace=${trace.id}`);
    // eslint-disable-next-line no-console
    console.info('说明:', explainInteraction(scope));
    if (detail) {
      // eslint-disable-next-line no-console
      console.info('请求摘要:', compactForLog(detail));
    }
    // eslint-disable-next-line no-console
    console.groupEnd();
  }
  return trace;
}

function logInteractionSuccess(trace: InteractionTrace, detail?: Record<string, unknown>): void {
  if (!interactionLoggingEnabled()) {
    return;
  }
  const ms = Number((nowMs() - trace.startedAt).toFixed(2));
  // eslint-disable-next-line no-console
  console.groupCollapsed(`[ModeDB] OK ${trace.scope}: ${trace.action} trace=${trace.id} ${ms}ms`);
  // eslint-disable-next-line no-console
  console.info('结果:', compactForLog({ ms, ...detail }));
  // eslint-disable-next-line no-console
  console.groupEnd();
}

function logInteractionError(trace: InteractionTrace, error: unknown): void {
  if (!interactionLoggingEnabled()) {
    return;
  }
  const ms = Number((nowMs() - trace.startedAt).toFixed(2));
  // eslint-disable-next-line no-console
  console.groupCollapsed(
    `[ModeDB] ERROR ${trace.scope}: ${trace.action} trace=${trace.id} ${ms}ms`,
  );

  console.error('错误:', {
    ms,
    message: error instanceof Error ? error.message : String(error),
  });
  // eslint-disable-next-line no-console
  console.groupEnd();
}

function summarizeWireBody(body: WireExecuteBody): Record<string, unknown> {
  const raw = body as unknown as Record<string, unknown>;
  if (body.op === 'executeBindingSurface') {
    return {
      op: body.op,
      surfaceId: body.surfaceId,
      version: body.version,
      action: body.action.kind,
      mutationId: body.action.kind === 'mutate' ? body.action.mutationId : undefined,
      parameterCount: Object.keys(body.parameters ?? {}).length,
    };
  }
  if (body.op === 'executeInterface' || body.op === 'executeOperationInterface') {
    return {
      op: body.op,
      callableName: body.callableName,
      version: body.version,
      parameterCount: Object.keys(body.parameters ?? {}).length,
      ...(body.op === 'executeInterface'
        ? {
            page: body.page,
            cursor:
              body.cursor === null
                ? 'first'
                : typeof body.cursor === 'string'
                  ? 'continuation'
                  : undefined,
            limit: body.limit,
          }
        : {}),
    };
  }
  if (body.op === 'executeQuery') {
    const snapshot = raw.snapshot as Record<string, unknown> | undefined;
    const plan = snapshot?.plan as Record<string, unknown> | undefined;
    const execute = snapshot?.execute as Record<string, unknown> | undefined;
    return {
      op: body.op,
      model: plan?.originModel,
      page: execute?.page,
      cursor:
        execute?.cursor === null
          ? 'first'
          : typeof execute?.cursor === 'string'
            ? 'continuation'
            : undefined,
      limit: execute?.limit,
    };
  }
  return {
    op: body.op,
    model: raw.model,
    relation: raw.forward ?? raw.relation,
    strategy: raw.strategy,
    batchSize: Array.isArray(raw.updates)
      ? raw.updates.length
      : Array.isArray(raw.deletes)
        ? raw.deletes.length
        : Array.isArray(raw.records)
          ? raw.records.length
          : undefined,
  };
}

function summarizeWireResult(result: WireExecuteResultJson): Record<string, unknown> {
  const raw = result as unknown as Record<string, unknown>;
  if (result.kind === 'rows') {
    return { kind: result.kind, rows: result.rows.length };
  }
  if (result.kind === 'interface') {
    return {
      kind: result.kind,
      callableName: result.callableName,
      version: result.version,
      rows: result.rows.length,
      hasNextCursor: Boolean(result.nextCursor),
    };
  }
  if (result.kind === 'operationInterface') {
    return {
      kind: result.kind,
      callableName: result.callableName,
      version: result.version,
      operation: result.operation,
    };
  }
  if (result.kind === 'bindingSurface') {
    return {
      kind: result.kind,
      surfaceId: result.surfaceId,
      version: result.version,
      action: result.action,
      status: result.status,
      rows: result.query?.rows.length,
      mutationId: result.mutation?.mutationId,
    };
  }
  if (result.kind === 'paginated') {
    return {
      kind: result.kind,
      total: result.total,
      page: result.page,
      pageCount: result.pageCount,
      hasNextCursor: Boolean(result.nextCursor),
    };
  }
  if (result.kind === 'analysis') {
    return { kind: result.kind, rows: result.rows.length, dimensions: result.dimensionKeys };
  }
  if (result.kind === 'groups') {
    return { kind: result.kind, groups: result.groups.length, dimensions: result.dimensionKeys };
  }
  if (result.kind === 'mutation') {
    return {
      kind: result.kind,
      op: raw.op,
      ok: raw.ok,
      successCount: raw.successCount,
      failureCount: raw.failureCount,
      pairsCount: raw.pairsCount,
    };
  }
  return { kind: result.kind };
}

function summarizeManagementResult(path: string, json: unknown): Record<string, unknown> {
  if (isRecord(json) && Array.isArray(json.databases)) {
    return { path, databases: json.databases.length };
  }
  if (isRecord(json) && Array.isArray(json.models) && Array.isArray(json.relations)) {
    let fieldLabels = 0;
    for (const model of json.models) {
      if (isRecord(model) && isRecord(model.fieldLabels)) {
        fieldLabels += Object.keys(model.fieldLabels).length;
      }
    }
    return {
      path,
      database: json.database,
      models: json.models.length,
      relations: json.relations.length,
      hasDatabaseDisplayName: isRecord(json.displayName),
      modelDisplayNames: json.models.filter(
        (model) => isRecord(model) && isRecord(model.displayName),
      ).length,
      fieldLabels,
    };
  }
  if (isRecord(json) && json.engine === 'ModelDB') {
    return {
      path,
      state: json.state,
      databases: Array.isArray(json.databases) ? json.databases.length : 0,
    };
  }
  return { path, resultType: typeof json };
}

/**
 * Minimal `{ model, id }` pair accepted by relation-binding APIs.
 * Both {@link RemoteHydratedEntity} rows and plain literals satisfy this shape.
 */
export interface RowRef {
  readonly model: string;
  readonly id: string;
}

/** Row handle compatible with {@link HydratedEntity} for `getData` / `getModelName`. */
export class RemoteHydratedEntity implements RowRef {
  constructor(
    private readonly row: Record<string, unknown>,
    readonly model: string,
  ) {}

  getData(_deep?: boolean): Record<string, unknown> {
    return this.row;
  }

  getModelName(): string {
    return this.model;
  }

  /** 本行所有关系槽位（`relates`）下的子行（按插入顺序合并）；树形查询通常只有一个自关联槽位。 */
  private childRows(): Record<string, unknown>[] {
    const rel = this.row.relates as Record<string, unknown> | undefined;
    if (!rel || typeof rel !== 'object') {
      return [];
    }
    const out: Record<string, unknown>[] = [];
    for (const v of Object.values(rel)) {
      if (Array.isArray(v)) {
        for (const child of v) {
          if (isRecord(child)) {
            out.push(child);
          }
        }
      }
    }
    return out;
  }

  /**
   * 将以本行为根的子树**展平**为有序行数组（含自身）。
   * 一对一链时即「上下游」强顺序；`dfs`（默认）前序，`bfs` 层序。
   */
  flatten(options?: { readonly order?: 'dfs' | 'bfs' }): RemoteHydratedEntity[] {
    const order = options?.order ?? 'dfs';
    const out: RemoteHydratedEntity[] = [];
    if (order === 'bfs') {
      const seen = new Set<Record<string, unknown>>();
      let level: RemoteHydratedEntity[] = [this];
      while (level.length > 0) {
        const next: RemoteHydratedEntity[] = [];
        for (const e of level) {
          out.push(e);
          if (seen.has(e.row)) {
            continue;
          }
          seen.add(e.row);
          next.push(...e.childRows().map((r) => new RemoteHydratedEntity(r, this.model)));
        }
        level = next;
      }
      return out;
    }
    const path = new Set<Record<string, unknown>>();
    const visit = (e: RemoteHydratedEntity): void => {
      out.push(e);
      if (path.has(e.row)) {
        return;
      }
      path.add(e.row);
      for (const r of e.childRows()) {
        visit(new RemoteHydratedEntity(r, this.model));
      }
      path.delete(e.row);
    };
    visit(this);
    return out;
  }

  /**
   * 将以本行为根的子树**聚合为一棵树**：返回纯 JSON，子节点置于 `childrenKey`（默认 `children`）字段下。
   */
  toTree(options?: { readonly childrenKey?: string }): Record<string, unknown> {
    return this._toTreeGuarded(this.row, options?.childrenKey ?? 'children', new Set());
  }

  private _toTreeGuarded(
    row: Record<string, unknown>,
    childrenKey: string,
    path: Set<Record<string, unknown>>,
  ): Record<string, unknown> {
    const { relates: _relates, ...rest } = row;
    const out: Record<string, unknown> = { ...rest };
    const rel = row.relates as Record<string, unknown> | undefined;
    if (rel && typeof rel === 'object' && !path.has(row)) {
      const kids: Record<string, unknown>[] = [];
      for (const v of Object.values(rel)) {
        if (Array.isArray(v)) {
          for (const child of v) {
            if (isRecord(child)) {
              kids.push(child);
            }
          }
        }
      }
      if (kids.length > 0) {
        path.add(row);
        out[childrenKey] = kids.map((c) => this._toTreeGuarded(c, childrenKey, path));
        path.delete(row);
      }
    }
    return out;
  }

  /** `_id` extracted from the row payload; throws if the backend did not include one. */
  get id(): string {
    const v = this.row._id;
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(
        `RemoteHydratedEntity.id: row has no "_id" (model=${this.model}); ` +
          `use { returning: true } or query() to obtain a row with _id.`,
      );
    }
    return v;
  }
}

/** Normalize `{ model, id }` / row instance / plain object into a {@link WireRowRef}. */
function toWireRowRef(x: RowRef | RemoteHydratedEntity): WireRowRef {
  if (x instanceof RemoteHydratedEntity) {
    return { model: x.getModelName(), id: x.id };
  }
  if (!x || typeof x.model !== 'string' || typeof x.id !== 'string') {
    throw new Error(
      'bindRelation: expected { model: string; id: string } or RemoteHydratedEntity.',
    );
  }
  return { model: x.model, id: x.id };
}

/** Result of {@link RemoteRuntimeModel.insertMany}; `records` is present only when `returning: true`. */
export interface InsertManyResult {
  readonly successCount: number;
  readonly failureCount: number;
  readonly insertedCount?: number;
  readonly updatedCount?: number;
  readonly records?: readonly RemoteHydratedEntity[];
}

/** Response shape for `bindPair` / `unlinkPair` / `bind`. */
export interface BindResult {
  readonly ok: boolean;
  /** Net edges added (positive) or removed (negative) by this RPC. */
  readonly pairsCount: number;
  /** Latest `RelationIndexer.getStats()` when server returned it (currently: `bind`). */
  readonly stats?: WireRelationStats;
}

export interface BatchRegisterInput {
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
    readonly selfLoopPolicy?: WireRelationSelfLoopPolicy;
  }[];
  /** Auto-create any source/target model referenced by `relations[*]` when absent (quickLink semantics). */
  readonly quickLink?: boolean;
}

export interface BatchRegisterResult {
  readonly ok: boolean;
  readonly created: { readonly models: readonly string[]; readonly relations: readonly string[] };
  readonly skipped: { readonly models: readonly string[]; readonly relations: readonly string[] };
}

/**
 * Compact tuple used by {@link RemoteModelDBClient.quickLinkBatch}:
 * `[sourceModel, targetModel, forwardLabel, reverseLabel]`.
 */
export type QuickLinkTuple = readonly [
  source: string,
  target: string,
  forward: string,
  reverse: string,
];

function reviveWireEntityNode(node: WireEntityNode): RemoteHydratedEntity {
  const data: Record<string, unknown> = { ...node.data };
  if (node.relates) {
    data.relates = Object.fromEntries(
      Object.entries(node.relates).map(([relation, children]) => [
        relation,
        children.map((child) => reviveWireEntityData(child)),
      ]),
    );
  }
  return new RemoteHydratedEntity(data, node.model);
}

function reviveWireEntityData(node: WireEntityNode): Record<string, unknown> {
  const data: Record<string, unknown> = { ...node.data };
  if (node.relates) {
    data.relates = Object.fromEntries(
      Object.entries(node.relates).map(([relation, children]) => [
        relation,
        children.map((child) => reviveWireEntityData(child)),
      ]),
    );
  }
  return data;
}

function reviveWireResult(json: WireExecuteResultJson): unknown {
  if (json.kind === 'paginated') {
    return {
      items: reviveWireResult(json.items),
      total: json.total,
      page: json.page,
      limit: json.limit,
      pageCount: json.pageCount,
      ...(json.nextCursor ? { nextCursor: json.nextCursor } : {}),
    };
  }
  if (json.kind === 'rows') {
    return json.rows.map((r) => reviveWireEntityNode(r));
  }
  if (json.kind === 'previewBind') {
    return {
      kind: 'previewBind' as const,
      forward: json.forward,
      pairsCount: json.pairsCount,
      sample: json.sample.map((p) => [p[0], p[1]] as const),
    };
  }
  if (json.kind === 'relationStats') {
    return {
      kind: 'relationStats' as const,
      forward: json.forward,
      forwardKeys: json.forwardKeys,
      reverseKeys: json.reverseKeys,
      totalLinks: json.totalLinks,
    };
  }
  if (json.kind === 'mutation') {
    if (json.op === 'insertMany') {
      const records = json.records
        ? json.records.map((r) => new RemoteHydratedEntity(r, json.model))
        : undefined;
      return {
        op: 'insertMany' as const,
        model: json.model,
        successCount: json.successCount ?? 0,
        failureCount: json.failureCount ?? 0,
        ...(records ? { records } : {}),
      };
    }
    if (json.op === 'batchUpdate') {
      return {
        op: 'batchUpdate' as const,
        successCount: json.successCount ?? 0,
        failureCount: json.failureCount ?? 0,
      };
    }
    if (json.op === 'batchDelete') {
      return {
        op: 'batchDelete' as const,
        successCount: json.successCount ?? 0,
        failureCount: json.failureCount ?? 0,
        ok: json.ok === true,
      };
    }
    if (
      json.op === 'dropModel' ||
      json.op === 'dropRelation' ||
      json.op === 'alterModel' ||
      json.op === 'registerModel' ||
      json.op === 'registerRelation' ||
      json.op === 'updateRelationLogic' ||
      json.op === 'delete'
    ) {
      return {
        op: json.op,
        model: json.model,
        relation: json.relation,
        ok: json.ok === true,
      };
    }
    if (
      json.op === 'bindPair' ||
      json.op === 'unlinkPair' ||
      json.op === 'rebindPair' ||
      json.op === 'bind'
    ) {
      return {
        op: json.op,
        model: json.model,
        relation: json.relation,
        ok: json.ok === true,
        pairsCount: json.pairsCount ?? 0,
        ...(json.stats ? { stats: json.stats } : {}),
      };
    }
    if (json.op === 'batchRegister') {
      return {
        op: 'batchRegister' as const,
        ok: json.ok === true,
        created: json.created ?? { models: [], relations: [] },
        skipped: json.skipped ?? { models: [], relations: [] },
      };
    }
    if (json.op === 'clearModelData' || json.op === 'clearAllData') {
      return {
        op: json.op,
        model: json.model,
        ok: json.ok === true,
        deletedCount: json.deletedCount ?? 0,
        ...(json.perModel ? { perModel: json.perModel } : {}),
      };
    }
    return {
      op: json.op,
      model: json.model,
      record: json.record ? new RemoteHydratedEntity(json.record, json.model) : null,
    };
  }
  return json;
}

type WsEmitter = {
  send(data: string): void;
  close(): void;
  /** Node **`ws`** style; browser **`WebSocket`** uses **`addEventListener`** only. */
  on?(event: string, fn: (...args: unknown[]) => void): void;
  once?(event: 'open' | 'error', fn: (...args: unknown[]) => void): void;
  addEventListener?(
    type: 'open' | 'error' | 'message' | 'close',
    fn: (ev: Event | MessageEvent) => void,
    opts?: { once?: boolean },
  ): void;
};

export type WebSocketCtor = new (url: string) => WsEmitter;

export function toHttpOrigin(url: string): string {
  const normalized = /^https?:\/\//i.test(url) || /^wss?:\/\//i.test(url) ? url : `http://${url}`;
  const u = new URL(normalized);
  if (u.protocol === 'ws:' || u.protocol === 'wss:') {
    const h = u.protocol === 'wss:' ? 'https:' : 'http:';
    return `${h}//${u.host}`;
  }
  return u.origin;
}

/** WebSocket URL for **`mode: 'stream'`** (defaults to **`/v2/stream`** when path is `/`). */
export function toWsStreamUrl(url: string): string {
  if (/^wss?:\/\//i.test(url)) {
    const u = new URL(url);
    if (u.pathname === '/' || u.pathname === '') {
      u.pathname = '/v2/stream';
    }
    return u.toString();
  }
  const u = new URL(/^https?:\/\//i.test(url) ? url : `http://${url}`);
  const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${u.host}/v2/stream`;
}

async function openWebSocket(url: string, WebSocketCtor?: WebSocketCtor): Promise<WsEmitter> {
  const trace = logInteractionStart('Connection', 'open websocket', { url });
  let W: WebSocketCtor | undefined = WebSocketCtor;
  try {
    if (!W) {
      /** Node 可能提供与 `ws` 服务器不兼容的全局 `WebSocket`；在 Node 中强制使用 `ws` 包。 */
      const isNode =
        typeof process !== 'undefined' &&
        process.versions !== undefined &&
        typeof process.versions.node === 'string';
      if (isNode) {
        const mod = (await import('ws')) as unknown as {
          WebSocket?: WebSocketCtor;
          default?: WebSocketCtor;
        };
        W = mod.WebSocket ?? mod.default;
      } else if (typeof globalThis.WebSocket === 'function') {
        W = globalThis.WebSocket as unknown as WebSocketCtor;
      } else {
        const mod = (await import('ws')) as unknown as {
          WebSocket?: WebSocketCtor;
          default?: WebSocketCtor;
        };
        W = mod.WebSocket ?? mod.default;
      }
    }
    if (!W) {
      throw new Error(
        'No WebSocket: pass ConnectRemoteOptions.webSocketCtor, install optional dependency "ws", or use a runtime with globalThis.WebSocket.',
      );
    }
    const ws = new W(url) as unknown as WsEmitter;
    await new Promise<void>((resolve, reject) => {
      if (typeof ws.once === 'function') {
        ws.once('open', () => resolve());
        ws.once('error', (e) => reject(e instanceof Error ? e : new Error(String(e))));
      } else if (typeof ws.addEventListener === 'function') {
        (ws as unknown as globalThis.WebSocket).addEventListener('open', () => resolve(), {
          once: true,
        });
        (ws as unknown as globalThis.WebSocket).addEventListener(
          'error',
          () => reject(new Error('WebSocket error')),
          { once: true },
        );
      } else {
        reject(new Error('WebSocket instance has neither once() nor addEventListener().'));
      }
    });
    logInteractionSuccess(trace, { url });
    return ws;
  } catch (e) {
    logInteractionError(trace, e);
    throw e;
  }
}

function bindSocketMessage(ws: WsEmitter, onMessage: (raw: unknown) => void): void {
  if (typeof ws.on === 'function') {
    ws.on('message', onMessage);
    return;
  }
  if (typeof ws.addEventListener === 'function') {
    ws.addEventListener('message', (ev) => {
      onMessage((ev as MessageEvent).data);
    });
    return;
  }
  throw new Error('WebSocket has neither on() nor addEventListener() for message.');
}

function bindSocketClose(ws: WsEmitter, onClose: () => void): void {
  if (typeof ws.on === 'function') {
    ws.on('close', onClose);
    return;
  }
  if (typeof ws.addEventListener === 'function') {
    ws.addEventListener('close', onClose);
    return;
  }
  throw new Error('WebSocket has neither on() nor addEventListener() for close.');
}

const utf8Decoder = new TextDecoder('utf-8');

function messageText(raw: unknown): string {
  if (typeof raw === 'string') {
    return raw;
  }
  if (raw instanceof ArrayBuffer) {
    return utf8Decoder.decode(raw);
  }
  if (ArrayBuffer.isView(raw)) {
    const v = raw as ArrayBufferView;
    return utf8Decoder.decode(
      v instanceof Uint8Array ? v : new Uint8Array(v.buffer, v.byteOffset, v.byteLength),
    );
  }
  return String(raw);
}

export interface ConnectRemoteOptions {
  readonly url: string;
  /**
   * Same secret as server **`connectToken`** / **`MODEL_DB_CONNECT_TOKEN`**.
   * **`token`** is an accepted alias (e.g. same name as **`connectNetwork`**).
   */
  readonly connectToken?: string;
  readonly token?: string;
  /** Use the browser's HttpOnly ModelDB session cookie instead of a bearer secret. */
  readonly browserSession?: boolean;
  /**
   * Logical library **`dbName`** → server resolves **`<workspace>/<dbName>/`** (vault **`atlas.mld`** recommended).
   * Preferred over **`atlas`** for new integrations.
   */
  readonly dbName?: string;
  /** @deprecated Prefer **`dbName`**. Same string space as logical library directory name. */
  readonly atlas?: string;
  /**
   * **`short`**: stateless **HTTP POST `/v2/action`** (good for tools / batch).
   * **`stream`**: **WebSocket `/v2/stream`** (default; good for interactive UIs).
   */
  readonly mode?: 'short' | 'stream';
  readonly webSocketCtor?: WebSocketCtor;
}

function resolveConnectToken(options: ConnectRemoteOptions): string {
  if (options.browserSession) {
    return '';
  }
  const t = options.connectToken ?? options.token;
  if (typeof t !== 'string' || !t.trim()) {
    throw new Error(
      'connectRemote: provide connectToken or token (same as server connectToken / MODEL_DB_CONNECT_TOKEN).',
    );
  }
  return t.trim();
}

/** Logical library directory name under the server **`workspace`** (`dbName` preferred; **`atlas`** is a synonym). */
function resolveConnectLogicalDb(options: ConnectRemoteOptions): string {
  const v = (options.dbName?.trim() || options.atlas?.trim() || '').trim();
  if (!v) {
    throw new Error('connectRemote: provide dbName or atlas (logical library name).');
  }
  return v;
}

type QuerySession = {
  /** Resolved logical library name (`dbName` or `atlas` under server **workspace**). */
  readonly atlas: string;
  connectHandshake(): Promise<void>;
  executeSnapshot(snapshot: RemoteExecuteSnapshot): Promise<unknown>;
  /** Send a wire op, returning the **revived** result (rows -> RemoteHydratedEntity, etc.). */
  executeWireBody(body: WireExecuteBody): Promise<unknown>;
  /** Send a wire op, returning the **raw** JSON result (protocol-faithful; used by `apply`). */
  executeWireBodyRaw(body: WireExecuteBody): Promise<WireExecuteResultJson>;
};

class RegistryRemoteSession implements QuerySession {
  constructor(
    private readonly origin: string,
    private readonly token: string,
    readonly atlas: string,
    private readonly browserSession = false,
  ) {}

  async connectHandshake(): Promise<void> {
    const response = await fetch(
      `${this.origin}/api/v1/security/context?database=${encodeURIComponent(this.atlas)}`,
      {
        redirect: 'error',
        ...(this.browserSession
          ? await browserSessionRequestInit(this.origin)
          : { headers: connectionAuthHeaders(this.token) }),
      },
    );
    if (!response.ok) {
      throw await remoteResponseError(response);
    }
    const result: unknown = await response.json();
    if (!isRecord(result) || result.version !== 1 || result.database !== this.atlas) {
      throw new ConnectionSecurityError('SECURITY_PROTOCOL_UNSUPPORTED', 426);
    }
  }

  async executeWireBodyRaw(body: WireExecuteBody): Promise<WireExecuteResultJson> {
    const auth = this.browserSession
      ? await browserSessionRequestInit(this.origin)
      : { headers: connectionAuthHeaders(this.token) };
    const response = await fetch(`${this.origin}/api/v1/rpc`, {
      ...auth,
      redirect: 'error',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...auth.headers,
      },
      ...(this.browserSession ? { credentials: 'include' as const } : {}),
      body: JSON.stringify({ version: 1, database: this.atlas, operation: body }),
    });
    if (!response.ok) {
      throw await remoteResponseError(response);
    }
    const result: unknown = await response.json();
    if (!isRecord(result) || result.version !== 1 || !isRecord(result.result)) {
      throw new ConnectionSecurityError('SECURITY_PROTOCOL_UNSUPPORTED', 426);
    }
    return result.result as unknown as WireExecuteResultJson;
  }
  async executeWireBody(body: WireExecuteBody): Promise<unknown> {
    return reviveWireResult(await this.executeWireBodyRaw(body));
  }
  executeSnapshot(snapshot: RemoteExecuteSnapshot): Promise<unknown> {
    return this.executeWireBody({ op: 'executeQuery', snapshot });
  }
}

class RegistryStreamSession implements QuerySession {
  private waiting?: {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    id?: string;
  };
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(
    private readonly ws: WsEmitter,
    private readonly token: string,
    readonly atlas: string,
    private readonly browserCsrf?: string,
  ) {
    bindSocketClose(ws, () => {
      this.closed = true;
      this.waiting?.reject(new ConnectionSecurityError('SECURITY_CONNECTION_CLOSED', 0));
      this.waiting = undefined;
    });
    bindSocketMessage(ws, (raw) => {
      try {
        const msg: unknown = JSON.parse(messageText(raw));
        if (!isRecord(msg) || msg.version !== 1) {
          throw new ConnectionSecurityError('SECURITY_PROTOCOL_UNSUPPORTED', 426);
        }
        if (msg.type === 'security.error') {
          this.waiting?.reject(
            new ConnectionSecurityError(
              String(msg.error),
              Number(msg.status),
              typeof msg.requestId === 'string' ? msg.requestId : undefined,
            ),
          );
        } else if (
          (msg.type === 'security.ready' && !this.waiting?.id && msg.database === this.atlas) ||
          (msg.type === 'security.result' && msg.id === this.waiting?.id)
        ) {
          this.waiting?.resolve(msg.result);
        } else {
          throw new ConnectionSecurityError('SECURITY_PROTOCOL_UNSUPPORTED', 426);
        }
        this.waiting = undefined;
      } catch (error) {
        this.waiting?.reject(error instanceof Error ? error : new Error('Invalid response'));
        this.waiting = undefined;
        ws.close();
      }
    });
  }
  private exchange(message: object, id?: string): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new ConnectionSecurityError('SECURITY_CONNECTION_CLOSED', 0));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ws.close();
        reject(new ConnectionSecurityError('SECURITY_CONNECTION_TIMEOUT', 0));
      }, 30000);
      this.waiting = {
        id,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      try {
        this.ws.send(JSON.stringify(message));
      } catch (error) {
        this.waiting.reject(error instanceof Error ? error : new Error('Send failed'));
        this.waiting = undefined;
      }
    });
  }
  async connectHandshake(): Promise<void> {
    await this.exchange({
      type: 'security.hello',
      version: 1,
      ...(this.browserCsrf ? { csrf: this.browserCsrf } : { token: this.token }),
      database: this.atlas,
    });
  }
  async executeWireBodyRaw(body: WireExecuteBody): Promise<WireExecuteResultJson> {
    const run = (): Promise<unknown> => {
      const id = nextRpcId();
      return this.exchange({ type: 'security.rpc', version: 1, id, operation: body }, id);
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return (await next) as WireExecuteResultJson;
  }
  async executeWireBody(body: WireExecuteBody): Promise<unknown> {
    return reviveWireResult(await this.executeWireBodyRaw(body));
  }
  executeSnapshot(snapshot: RemoteExecuteSnapshot): Promise<unknown> {
    return this.executeWireBody({ op: 'executeQuery', snapshot });
  }
}

class ShortRemoteSession implements QuerySession {
  constructor(
    private readonly httpOrigin: string,
    private readonly connectToken: string,
    readonly atlas: string,
  ) {}

  async connectHandshake(): Promise<void> {
    const trace = logInteractionStart('HTTP RPC', 'health handshake', {
      origin: this.httpOrigin,
      database: this.atlas,
    });
    try {
      const r = await fetch(`${this.httpOrigin}/health`);
      if (!r.ok) {
        throw new Error(`Short mode: health check failed (HTTP ${r.status}).`);
      }
      const j = (await r.json()) as { ok?: boolean };
      if (!j?.ok) {
        throw new Error('Short mode: server /health did not return { ok: true }.');
      }
      logInteractionSuccess(trace, { status: r.status, ok: j.ok });
    } catch (e) {
      logInteractionError(trace, e);
      throw e;
    }
  }

  async executeWireBodyRaw(body: WireExecuteBody): Promise<WireExecuteResultJson> {
    const id = nextRpcId();
    const trace = logInteractionStart('HTTP RPC', body.op, {
      id,
      database: this.atlas,
      ...summarizeWireBody(body),
    });
    const sessionKey = deriveWireSessionKey(this.connectToken, this.atlas);
    const cipher = encodeWirePayload(JSON.stringify(body), sessionKey);
    try {
      const r = await fetch(`${this.httpOrigin}/v2/action`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-modeldb-db-name': this.atlas,
          'x-modeldb-atlas': this.atlas,
          'x-modeldb-connect-token': this.connectToken,
        },
        body: JSON.stringify({ cipher, id }),
      });
      const text = await r.text();
      if (!r.ok) {
        throw new Error(`Short mode: HTTP ${r.status} ${text.slice(0, 500)}`);
      }
      let msg: unknown;
      try {
        msg = JSON.parse(text) as unknown;
      } catch {
        throw new Error('Short mode: response is not JSON.');
      }
      if (!isRecord(msg)) {
        throw new Error('Short mode: response JSON is not an object.');
      }
      if (msg.type === 'rpc.err') {
        const message = String(msg.error ?? 'RPC error');
        throw rpcError(message, msg.errorDetail);
      }
      if (msg.type !== 'rpc.ok' || typeof msg.cipher !== 'string') {
        throw new Error('Short mode: expected { type: "rpc.ok", cipher }.');
      }
      const plain = decodeWirePayload(msg.cipher, sessionKey);
      const result = JSON.parse(plain) as WireExecuteResultJson;
      logInteractionSuccess(trace, summarizeWireResult(result));
      return result;
    } catch (e) {
      logInteractionError(trace, e);
      throw e;
    }
  }

  async executeWireBody(body: WireExecuteBody): Promise<unknown> {
    return reviveWireResult(await this.executeWireBodyRaw(body));
  }

  async executeSnapshot(snapshot: RemoteExecuteSnapshot): Promise<unknown> {
    return this.executeWireBody({ op: 'executeQuery', snapshot });
  }
}

class RemoteSession implements QuerySession {
  private sessionKey = '';
  private handshakeDone = false;
  private handshakeWait: {
    readonly resolve: () => void;
    readonly reject: (e: Error) => void;
  } | null = null;
  private readonly pending = new Map<
    string,
    { readonly resolve: (v: WireExecuteResultJson) => void; readonly reject: (e: Error) => void }
  >();

  constructor(
    private readonly ws: WsEmitter,
    private readonly connectToken: string,
    readonly atlas: string,
  ) {
    bindSocketMessage(this.ws, (raw) => {
      this.onSocketMessage(raw);
    });
    bindSocketClose(this.ws, () => {
      if (!this.handshakeDone) {
        const w = this.handshakeWait;
        if (w) {
          this.handshakeWait = null;
          w.reject(new Error('WebSocket closed before handshake completed.'));
        }
      }
    });
  }

  private rejectHandshake(reason: string): void {
    const w = this.handshakeWait;
    if (w) {
      this.handshakeWait = null;
      w.reject(new Error(reason));
    }
  }

  private onSocketMessage(raw: unknown): void {
    let msg: unknown;
    try {
      msg = JSON.parse(messageText(raw)) as unknown;
    } catch {
      if (!this.handshakeDone) {
        this.rejectHandshake('Invalid JSON in WebSocket message (handshake phase).');
      }
      return;
    }
    if (!isRecord(msg)) {
      if (!this.handshakeDone) {
        this.rejectHandshake('Handshake response was not a JSON object.');
      }
      return;
    }

    if (!this.handshakeDone) {
      if (msg.type === 'handshake.ok') {
        this.sessionKey = deriveWireSessionKey(this.connectToken, this.atlas);
        this.handshakeDone = true;
        this.handshakeWait?.resolve();
        this.handshakeWait = null;
        return;
      }
      if (msg.type === 'error') {
        const err = new Error(String(msg.message ?? 'Handshake refused'));
        this.handshakeWait?.reject(err);
        this.handshakeWait = null;
        return;
      }
      this.rejectHandshake(`Unexpected message before handshake completed: ${JSON.stringify(msg)}`);
      return;
    }

    if (msg.type === 'rpc.ok') {
      const id = String(msg.id ?? '');
      const def = this.pending.get(id);
      const cipher = msg.cipher;
      if (def && typeof cipher === 'string') {
        try {
          const plain = decodeWirePayload(cipher, this.sessionKey);
          const body = JSON.parse(plain) as WireExecuteResultJson;
          def.resolve(body);
        } catch (e) {
          def.reject(e instanceof Error ? e : new Error(String(e)));
        }
        this.pending.delete(id);
      }
      return;
    }

    if (msg.type === 'rpc.err') {
      const id = String(msg.id ?? '');
      const def = this.pending.get(id);
      const errText = typeof msg.error === 'string' ? msg.error : 'RPC error';
      if (def) {
        def.reject(rpcError(errText, msg.errorDetail));
        this.pending.delete(id);
      }
    }
  }

  connectHandshake(): Promise<void> {
    const trace = logInteractionStart('WebSocket RPC', 'handshake', { database: this.atlas });
    return new Promise<void>((resolve, reject) => {
      this.handshakeWait = {
        resolve: () => {
          logInteractionSuccess(trace, { database: this.atlas });
          resolve();
        },
        reject: (e) => {
          logInteractionError(trace, e);
          reject(e);
        },
      };
      this.ws.send(
        JSON.stringify({
          type: 'handshake',
          connectToken: this.connectToken,
          dbName: this.atlas,
          atlas: this.atlas,
        }),
      );
    });
  }

  executeWireBodyRaw(body: WireExecuteBody): Promise<WireExecuteResultJson> {
    const id = nextRpcId();
    const trace = logInteractionStart('WebSocket RPC', body.op, {
      id,
      database: this.atlas,
      ...summarizeWireBody(body),
    });
    const cipher = encodeWirePayload(JSON.stringify(body), this.sessionKey);
    const payload = JSON.stringify({ type: 'rpc', id, cipher });
    const p = new Promise<WireExecuteResultJson>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (result) => {
          logInteractionSuccess(trace, summarizeWireResult(result));
          resolve(result);
        },
        reject: (e) => {
          logInteractionError(trace, e);
          reject(e);
        },
      });
    });
    this.ws.send(payload);
    return p;
  }

  async executeWireBody(body: WireExecuteBody): Promise<unknown> {
    return reviveWireResult(await this.executeWireBodyRaw(body));
  }

  executeSnapshot(snapshot: RemoteExecuteSnapshot): Promise<unknown> {
    return this.executeWireBody({ op: 'executeQuery', snapshot });
  }
}

/** Fluent query chain that RPCs server-side query execution over the wire. */
export class RemoteQueryChain<
  M extends Record<string, unknown> = Record<string, unknown>,
  Mode extends 'rows' | 'analysis' = 'rows',
> extends WireQueryChain<M, Mode> {
  constructor(
    private readonly getSession: () => Promise<QuerySession>,
    modelName: string,
    start: QueryStartSpec,
  ) {
    super(modelName, start);
  }

  override async execute(options?: QueryExecuteOptions): Promise<unknown> {
    const session = await this.getSession();
    const snapshot = this.getRemoteExecuteSnapshot(options);
    return session.executeSnapshot(snapshot);
  }
}

/** Remote model handle: `query()` returns a {@link RemoteQueryChain}; writes use the RPC gate. */
export class RemoteRuntimeModel {
  constructor(
    private readonly getSession: () => Promise<QuerySession>,
    readonly name: string,
  ) {}

  query<M extends Record<string, unknown> = Record<string, unknown>>(
    ids?: readonly string[],
  ): RemoteQueryChain<M, 'rows'> {
    if (ids === undefined) {
      return new RemoteQueryChain(this.getSession, this.name, { kind: 'all' });
    }
    return new RemoteQueryChain(this.getSession, this.name, { kind: 'ids', ids: [...ids] });
  }

  /**
   * Single-row insert over the wire (server runs {@link AuthoringEngine} **`insert`** inside the write gate).
   * Returns the freshly-persisted row as a {@link RemoteHydratedEntity}; pass the result directly to
   * {@link RemoteModelDBClient.bindRelation} / {@link RemoteModelDBClient.unlinkRelation} to build
   * data-level links without having to remember `_id`.
   */
  async insertOne(
    data: Record<string, unknown>,
    opts?: { sync?: boolean },
  ): Promise<RemoteHydratedEntity> {
    const session = await this.getSession();
    const out = await session.executeWireBody({
      op: 'insert',
      model: this.name,
      data,
      sync: opts?.sync,
    });
    if (!isRecord(out) || out.op !== 'insert') {
      throw new Error('insertOne: unexpected remote response shape.');
    }
    const rec = out.record;
    if (!(rec instanceof RemoteHydratedEntity)) {
      throw new Error('insertOne: server did not return a row record.');
    }
    return rec;
  }

  /**
   * Batch insert over the wire (server runs {@link AuthoringEngine} **`insertMany`** inside the write gate).
   * At most **20_000** rows per call (server cap).
   *
   * Pass `{ returning: true }` to receive each successfully-staged row (with `_id`) as
   * {@link RemoteHydratedEntity} via the `records` field.
   */
  async insertMany(
    rows: readonly Record<string, unknown>[],
    opts?: {
      sync?: boolean;
      returning?: boolean;
      upsert?: { readonly matchFields: readonly string[]; readonly updateExisting?: boolean };
    },
  ): Promise<InsertManyResult> {
    const session = await this.getSession();
    const out = await session.executeWireBody({
      op: 'insertMany',
      model: this.name,
      rows: [...rows],
      sync: opts?.sync,
      returning: opts?.returning,
      upsert: opts?.upsert,
    });
    if (
      !isRecord(out) ||
      out.op !== 'insertMany' ||
      typeof out.successCount !== 'number' ||
      typeof out.failureCount !== 'number'
    ) {
      throw new Error('insertMany: unexpected remote response shape.');
    }
    const records = Array.isArray(out.records)
      ? (out.records as unknown[]).filter(
          (r): r is RemoteHydratedEntity => r instanceof RemoteHydratedEntity,
        )
      : undefined;
    return {
      successCount: out.successCount,
      failureCount: out.failureCount,
      ...(typeof out.insertedCount === 'number' ? { insertedCount: out.insertedCount } : {}),
      ...(typeof out.updatedCount === 'number' ? { updatedCount: out.updatedCount } : {}),
      ...(records ? { records } : {}),
    };
  }
}

async function fetchManagementJson<T>(
  origin: string,
  auth: { readonly token?: string; readonly browserSession?: boolean },
  path: string,
): Promise<T> {
  assertSecureCredentialOrigin(
    origin,
    auth.browserSession ? 'mdbt_v1_browser-session' : (auth.token ?? ''),
  );
  const access = auth.browserSession
    ? await browserSessionRequestInit(origin)
    : { headers: connectionAuthHeaders(auth.token ?? '') };
  const base = origin.replace(/\/$/, '');
  const url = `${base}${path}`;
  const trace = logInteractionStart('Management API', `GET ${path}`, { url });
  try {
    const res = await fetch(url, {
      redirect: 'error',
      ...access,
      headers: access.headers,
    });
    if (!res.ok) {
      throw await remoteResponseError(res);
    }
    const json = (await res.json()) as T;
    logInteractionSuccess(trace, {
      status: res.status,
      ...summarizeManagementResult(path, json),
    });
    return json;
  } catch (e) {
    logInteractionError(trace, e);
    throw e;
  }
}

async function fetchManagementPostJson<T>(
  origin: string,
  auth: { readonly token?: string; readonly browserSession?: boolean },
  path: string,
  body: unknown,
): Promise<T> {
  assertSecureCredentialOrigin(
    origin,
    auth.browserSession ? 'mdbt_v1_browser-session' : (auth.token ?? ''),
  );
  const access = auth.browserSession
    ? await browserSessionRequestInit(origin)
    : { headers: connectionAuthHeaders(auth.token ?? '') };
  const base = origin.replace(/\/$/, '');
  const url = `${base}${path}`;
  const trace = logInteractionStart('Management API', `POST ${path}`, { url, body });
  try {
    const res = await fetch(url, {
      redirect: 'error',
      ...access,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...access.headers,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw await remoteResponseError(res);
    }
    const json = (await res.json()) as T;
    logInteractionSuccess(trace, {
      status: res.status,
      ...summarizeManagementResult(path, json),
    });
    return json;
  } catch (e) {
    logInteractionError(trace, e);
    throw e;
  }
}

async function fetchManagementBlob(
  origin: string,
  auth: { readonly token?: string; readonly browserSession?: boolean },
  path: string,
): Promise<Blob> {
  assertSecureCredentialOrigin(
    origin,
    auth.browserSession ? 'mdbt_v1_browser-session' : (auth.token ?? ''),
  );
  const access = auth.browserSession
    ? await browserSessionRequestInit(origin)
    : { headers: connectionAuthHeaders(auth.token ?? '') };
  const base = origin.replace(/\/$/, '');
  const url = `${base}${path}`;
  const trace = logInteractionStart('Management API', `GET ${path}`, { url, response: 'binary' });
  try {
    const res = await fetch(url, {
      redirect: 'error',
      ...access,
      headers: access.headers,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status === 404 && /Route\s+GET:/i.test(text)) {
        throw new Error(
          'The connected ModelDB Server does not provide the backup download API. Rebuild, upgrade, and restart @mode-db/server before exporting backups.',
        );
      }
      throw await remoteResponseError(new Response(text, { status: res.status }));
    }
    const blob = await res.blob();
    logInteractionSuccess(trace, { status: res.status, bytes: blob.size });
    return blob;
  } catch (e) {
    logInteractionError(trace, e);
    throw e;
  }
}

async function fetchManagementPostBlobJson<T>(
  origin: string,
  auth: { readonly token?: string; readonly browserSession?: boolean },
  path: string,
  body: Blob,
): Promise<T> {
  assertSecureCredentialOrigin(
    origin,
    auth.browserSession ? 'mdbt_v1_browser-session' : (auth.token ?? ''),
  );
  const access = auth.browserSession
    ? await browserSessionRequestInit(origin)
    : { headers: connectionAuthHeaders(auth.token ?? '') };
  const base = origin.replace(/\/$/, '');
  const url = `${base}${path}`;
  const trace = logInteractionStart('Management API', `POST ${path}`, {
    url,
    bytes: body.size,
    contentType: body.type || 'application/octet-stream',
  });
  try {
    const res = await fetch(url, {
      redirect: 'error',
      ...access,
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        ...access.headers,
      },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status === 404 && /Route\s+POST:/i.test(text)) {
        throw new Error(
          'The connected ModelDB Server does not provide the backup import API. Rebuild, upgrade, and restart @mode-db/server before importing backups.',
        );
      }
      throw await remoteResponseError(new Response(text, { status: res.status }));
    }
    const json = (await res.json()) as T;
    logInteractionSuccess(trace, {
      status: res.status,
      ...summarizeManagementResult(path, json),
    });
    return json;
  } catch (e) {
    logInteractionError(trace, e);
    throw e;
  }
}

async function fetchManagementDelete(
  origin: string,
  auth: { readonly token?: string; readonly browserSession?: boolean },
  path: string,
): Promise<void> {
  assertSecureCredentialOrigin(
    origin,
    auth.browserSession ? 'mdbt_v1_browser-session' : (auth.token ?? ''),
  );
  const access = auth.browserSession
    ? await browserSessionRequestInit(origin)
    : { headers: connectionAuthHeaders(auth.token ?? '') };
  const base = origin.replace(/\/$/, '');
  const url = `${base}${path}`;
  const trace = logInteractionStart('Management API', `DELETE ${path}`, { url });
  try {
    const res = await fetch(url, {
      redirect: 'error',
      ...access,
      method: 'DELETE',
      headers: access.headers,
    });
    if (!res.ok) {
      throw await remoteResponseError(res);
    }
    logInteractionSuccess(trace, { status: res.status });
  } catch (e) {
    logInteractionError(trace, e);
    throw e;
  }
}

export class RemoteModelDBClient {
  private _ws: WsEmitter | undefined;
  private _session: QuerySession | undefined;
  private _connectOnce: Promise<QuerySession> | null = null;

  constructor(private readonly options: ConnectRemoteOptions) {}

  private async doConnect(): Promise<QuerySession> {
    const logical = resolveConnectLogicalDb(this.options);
    const connectToken = resolveConnectToken(this.options);
    const mode = this.options.mode ?? (this.options.browserSession ? 'short' : 'stream');
    const origin = toHttpOrigin(this.options.url);
    assertSecureCredentialOrigin(
      origin,
      this.options.browserSession ? 'mdbt_v1_browser-session' : connectToken,
    );
    const health = await fetch(`${origin}/health`, {
      redirect: 'error',
      ...(this.options.browserSession ? { credentials: 'include' as const } : {}),
    });
    if (!health.ok) {
      throw await remoteResponseError(health);
    }
    const info: unknown = await health.json();
    if (!isRecord(info) || info.ok !== true) {
      throw new ConnectionSecurityError('SECURITY_PROTOCOL_UNSUPPORTED', 426);
    }
    const security = isRecord(info) && isRecord(info.security) ? info.security : undefined;
    if (security && security.mode !== 'registry' && security.mode !== 'legacy') {
      throw new ConnectionSecurityError('SECURITY_PROTOCOL_UNSUPPORTED', 426);
    }
    if (security?.mode === 'registry') {
      if (
        security.protocol !== 1 ||
        (!this.options.browserSession && !connectToken.startsWith('mdbt_v1_'))
      ) {
        throw new ConnectionSecurityError('SECURITY_PROTOCOL_UNSUPPORTED', 426);
      }
      const browserAccess = this.options.browserSession
        ? await browserSessionRequestInit(origin)
        : undefined;
      if (mode === 'short') {
        const session = new RegistryRemoteSession(
          origin,
          connectToken,
          logical,
          this.options.browserSession,
        );
        await session.connectHandshake();
        return session;
      }
      const url = new URL(toWsStreamUrl(this.options.url));
      url.pathname = '/api/v1/stream';
      url.search = '';
      const ws = await openWebSocket(url.toString(), this.options.webSocketCtor);
      this._ws = ws;
      const session = new RegistryStreamSession(
        ws,
        connectToken,
        logical,
        browserAccess?.headers['x-modeldb-csrf'],
      );
      await session.connectHandshake();
      return session;
    }
    if (this.options.browserSession || connectToken.startsWith('mdbt_v1_')) {
      throw new ConnectionSecurityError('SECURITY_PROTOCOL_UNSUPPORTED', 426);
    }
    if (mode === 'short') {
      const origin = toHttpOrigin(this.options.url);
      const session = new ShortRemoteSession(origin, connectToken, logical);
      await session.connectHandshake();
      return session;
    }
    const wsUrl = toWsStreamUrl(this.options.url);
    const ws = await openWebSocket(wsUrl, this.options.webSocketCtor);
    this._ws = ws;
    const session = new RemoteSession(ws, connectToken, logical);
    await session.connectHandshake();
    return session;
  }

  private async ensureSession(): Promise<QuerySession> {
    if (this._session) {
      return this._session;
    }
    if (!this._connectOnce) {
      this._connectOnce = this.doConnect()
        .then((s) => {
          this._session = s;
          return s;
        })
        .catch((e) => {
          this._ws?.close();
          this._ws = undefined;
          this._connectOnce = null;
          throw e;
        });
    }
    return this._connectOnce;
  }

  /** Eager connect (idempotent); first query/meta call also connects lazily. */
  async connect(): Promise<void> {
    await this.ensureSession();
  }

  /**
   * Lists logical databases under the server workspace (**`GET /api/v1/management/databases`**).
   * Uses **`X-ModelDB-Connect-Token`** (same as wire **`connectToken`**).
   */
  static async listDatabases(options: {
    readonly host: string;
    readonly port: number;
    readonly secure?: boolean;
    readonly token?: string;
    readonly browserSession?: boolean;
  }): Promise<readonly ManagementDatabaseInfo[]> {
    const origin = connectionOrigin(options);
    const json = await fetchManagementJson<ManagementDatabasesResponse>(
      origin,
      options,
      '/api/v1/management/databases',
    );
    if (!json || !Array.isArray(json.databases)) {
      throw new Error('listDatabases: invalid response shape.');
    }
    return json.databases;
  }

  /**
   * Engine / listen / workspace summary (**`GET /api/v1/management/status`**).
   */
  static async getManagementStatus(options: {
    readonly host: string;
    readonly port: number;
    readonly secure?: boolean;
    readonly token?: string;
    readonly browserSession?: boolean;
  }): Promise<ManagementStatusResponse> {
    const origin = connectionOrigin(options);
    return fetchManagementJson<ManagementStatusResponse>(
      origin,
      options,
      '/api/v1/management/status',
    );
  }

  /**
   * Model + relation catalog for one logical DB (**`GET …/databases/:name/catalog`**).
   */
  static async getDatabaseCatalog(options: {
    readonly host: string;
    readonly port: number;
    readonly secure?: boolean;
    readonly token?: string;
    readonly browserSession?: boolean;
    readonly database: string;
  }): Promise<ManagementCatalogResponse> {
    const origin = connectionOrigin(options);
    const enc = encodeURIComponent(options.database.trim());
    return fetchManagementJson<ManagementCatalogResponse>(
      origin,
      options,
      `/api/v1/management/databases/${enc}/catalog`,
    );
  }

  /** Server-side backup files under workspace/modeldb/backups. */
  static async listBackups(options: {
    readonly host: string;
    readonly port: number;
    readonly secure?: boolean;
    readonly token?: string;
    readonly browserSession?: boolean;
    readonly database?: string;
  }): Promise<readonly ManagementBackupInfo[]> {
    const origin = connectionOrigin(options);
    const database = options.database?.trim();
    const query = database ? `?database=${encodeURIComponent(database)}` : '';
    const json = await fetchManagementJson<ManagementBackupsResponse>(
      origin,
      options,
      `/api/v1/management/backups${query}`,
    );
    if (!json || !Array.isArray(json.backups)) {
      throw new Error('listBackups: invalid response shape.');
    }
    return json.backups;
  }

  /** Create a safety/manual backup for one logical DB. */
  static async createBackup(options: {
    readonly host: string;
    readonly port: number;
    readonly secure?: boolean;
    readonly token?: string;
    readonly browserSession?: boolean;
    readonly database: string;
    readonly reason?: string;
    readonly name?: string;
  }): Promise<ManagementBackupInfo> {
    const origin = connectionOrigin(options);
    const enc = encodeURIComponent(options.database.trim());
    const json = await fetchManagementPostJson<ManagementBackupCreateResponse>(
      origin,
      options,
      `/api/v1/management/databases/${enc}/backup`,
      { reason: options.reason ?? 'manual', name: options.name },
    );
    return json.backup;
  }

  /** Download an encrypted backup; another instance also needs recovery or recipient material. */
  static async downloadBackup(options: {
    readonly host: string;
    readonly port: number;
    readonly secure?: boolean;
    readonly token?: string;
    readonly browserSession?: boolean;
    readonly backupFile: string;
  }): Promise<Blob> {
    const origin = connectionOrigin(options);
    const file = encodeURIComponent(options.backupFile.trim());
    return fetchManagementBlob(origin, options, `/api/v1/management/backups/${file}/download`);
  }

  /** Upload and authenticate a v2 backup covered by this instance's retained keys. */
  static async importBackup(options: {
    readonly host: string;
    readonly port: number;
    readonly secure?: boolean;
    readonly token?: string;
    readonly browserSession?: boolean;
    readonly fileName: string;
    readonly file: Blob;
  }): Promise<ManagementBackupInfo> {
    const origin = connectionOrigin(options);
    const query = `?fileName=${encodeURIComponent(options.fileName.trim())}`;
    const json = await fetchManagementPostBlobJson<ManagementBackupImportResponse>(
      origin,
      options,
      `/api/v1/management/backups/import${query}`,
      options.file,
    );
    return json.backup;
  }

  /** Restore one logical DB from a server-side backup file. */
  static async restoreBackup(options: {
    readonly host: string;
    readonly port: number;
    readonly secure?: boolean;
    readonly token?: string;
    readonly browserSession?: boolean;
    readonly database: string;
    readonly backupFile: string;
  }): Promise<ManagementBackupRestoreResponse> {
    const origin = connectionOrigin(options);
    const enc = encodeURIComponent(options.database.trim());
    return fetchManagementPostJson<ManagementBackupRestoreResponse>(
      origin,
      options,
      `/api/v1/management/databases/${enc}/restore`,
      { backupFile: options.backupFile.trim() },
    );
  }

  /** Clear all rows, or force-reset corrupted physical DB files when requested. */
  static async clearDatabaseData(options: {
    readonly host: string;
    readonly port: number;
    readonly secure?: boolean;
    readonly token?: string;
    readonly browserSession?: boolean;
    readonly database: string;
    readonly forceReset?: boolean;
  }): Promise<ManagementClearDatabaseResponse> {
    const origin = connectionOrigin(options);
    const enc = encodeURIComponent(options.database.trim());
    return fetchManagementPostJson<ManagementClearDatabaseResponse>(
      origin,
      options,
      `/api/v1/management/databases/${enc}/clear`,
      { forceReset: options.forceReset === true },
    );
  }

  /** Create nested workspace directory and empty vault (`POST /api/v1/management/databases`). */
  static async createDatabase(options: {
    readonly host: string;
    readonly port: number;
    readonly secure?: boolean;
    readonly token?: string;
    readonly browserSession?: boolean;
    readonly name: string;
  }): Promise<void> {
    const origin = connectionOrigin(options);
    await fetchManagementPostJson<{ ok?: boolean }>(
      origin,
      options,
      '/api/v1/management/databases',
      { name: options.name.trim() },
    );
  }

  /** Remove logical DB directory or flat **`*.mld`** from workspace (**`DELETE …/databases/:name`**). */
  static async deleteDatabase(options: {
    readonly host: string;
    readonly port: number;
    readonly secure?: boolean;
    readonly token?: string;
    readonly browserSession?: boolean;
    readonly name: string;
  }): Promise<void> {
    const origin = connectionOrigin(options);
    const enc = encodeURIComponent(options.name.trim());
    await fetchManagementDelete(origin, options, `/api/v1/management/databases/${enc}`);
  }

  /**
   * Connect by host/port (HTTP origin + WebSocket stream); same wire protocol as {@link connectRemote}.
   */
  static async connectNetwork(options: {
    readonly host: string;
    readonly port: number;
    readonly secure?: boolean;
    readonly token?: string;
    readonly browserSession?: boolean;
    readonly database: string;
    readonly mode?: 'short' | 'stream';
    readonly webSocketCtor?: WebSocketCtor;
  }): Promise<RemoteModelDBClient> {
    const url = connectionOrigin(options);
    return RemoteModelDBClient.connect({
      url,
      connectToken: options.token,
      browserSession: options.browserSession,
      dbName: options.database,
      mode: options.mode,
      webSocketCtor: options.webSocketCtor,
    });
  }

  static async connect(options: ConnectRemoteOptions): Promise<RemoteModelDBClient> {
    const c = new RemoteModelDBClient(options);
    await c.connect();
    return c;
  }

  model(name: string): RemoteRuntimeModel {
    return new RemoteRuntimeModel(() => this.ensureSession(), name);
  }

  /**
   * Data: truncate **one** model — tombstone all of its rows and clear relation indexes touching it.
   * Schema / registration is preserved. Returns the number of rows deleted.
   */
  async clearModelData(model: string): Promise<number> {
    const session = await this.ensureSession();
    const out = await session.executeWireBody({ op: 'clearModelData', model });
    if (!isRecord(out) || out.op !== 'clearModelData' || out.ok !== true) {
      throw new Error('clearModelData: unexpected remote response.');
    }
    return typeof out.deletedCount === 'number' ? out.deletedCount : 0;
  }

  /**
   * Data: truncate **all** models in this library — tombstone every row and clear all relation indexes.
   * Schema / registration is preserved. Returns the total deleted plus a per-model breakdown.
   */
  async clearAllData(): Promise<{ totalDeleted: number; perModel: Record<string, number> }> {
    const session = await this.ensureSession();
    const out = await session.executeWireBody({ op: 'clearAllData' });
    if (!isRecord(out) || out.op !== 'clearAllData' || out.ok !== true) {
      throw new Error('clearAllData: unexpected remote response.');
    }
    const perModel =
      isRecord(out.perModel) && out.perModel ? (out.perModel as Record<string, number>) : {};
    return {
      totalDeleted: typeof out.deletedCount === 'number' ? out.deletedCount : 0,
      perModel,
    };
  }

  async invokeQueryInterface(
    callableName: string,
    options?: {
      readonly version?: string;
      readonly parameters?: Readonly<Record<string, unknown>>;
      readonly accessKey?: string;
      readonly page?: number;
      readonly cursor?: string | null;
      readonly limit?: number;
    },
  ): Promise<QueryInterfaceInvocationResult> {
    const name = callableName.trim();
    if (!name) {
      throw new Error('invokeQueryInterface: callableName is required.');
    }
    const session = await this.ensureSession();
    const result = await session.executeWireBodyRaw({
      op: 'executeInterface',
      callableName: name,
      ...(options?.version ? { version: options.version } : {}),
      ...(options?.parameters ? { parameters: options.parameters } : {}),
      ...(options?.accessKey ? { accessKey: options.accessKey } : {}),
      ...(options?.page !== undefined ? { page: options.page } : {}),
      ...(options && Object.prototype.hasOwnProperty.call(options, 'cursor')
        ? { cursor: options.cursor ?? null }
        : {}),
      ...(options?.limit !== undefined ? { limit: options.limit } : {}),
    });
    if (result.kind !== 'interface') {
      throw new Error(`invokeQueryInterface: unexpected result kind "${result.kind}".`);
    }
    return result;
  }
  async invokeOperationInterface(
    callableName: string,
    options?: {
      readonly version?: string;
      readonly parameters?: Readonly<Record<string, unknown>>;
      readonly accessKey?: string;
    },
  ): Promise<OperationInterfaceInvocationResult> {
    const name = callableName.trim();
    if (!name) {
      throw new Error('invokeOperationInterface: callableName is required.');
    }
    const session = await this.ensureSession();
    const result = await session.executeWireBodyRaw({
      op: 'executeOperationInterface',
      callableName: name,
      ...(options?.version ? { version: options.version } : {}),
      ...(options?.parameters ? { parameters: options.parameters } : {}),
      ...(options?.accessKey ? { accessKey: options.accessKey } : {}),
    });
    if (result.kind !== 'operationInterface') {
      throw new Error(`invokeOperationInterface: unexpected result kind "${result.kind}".`);
    }
    return result;
  }

  async invokeBindingSurface(
    surfaceId: string,
    options: {
      readonly action: WireBindingSurfaceAction;
      readonly version?: string;
      readonly parameters?: Readonly<Record<string, unknown>>;
      readonly accessKey?: string;
      readonly accessKeys?: Readonly<Record<string, string>>;
    },
  ): Promise<BindingSurfaceInvocationResult> {
    const id = surfaceId.trim();
    if (!id) {
      throw new Error('invokeBindingSurface: surfaceId is required.');
    }
    const session = await this.ensureSession();
    const result = await session.executeWireBodyRaw({
      op: 'executeBindingSurface',
      surfaceId: id,
      action: options.action,
      ...(options.version ? { version: options.version } : {}),
      ...(options.parameters ? { parameters: options.parameters } : {}),
      ...(options.accessKey ? { accessKey: options.accessKey } : {}),
      ...(options.accessKeys ? { accessKeys: options.accessKeys } : {}),
    });
    if (result.kind !== 'bindingSurface') {
      throw new Error(`invokeBindingSurface: unexpected result kind "${result.kind}".`);
    }
    return result;
  }

  /**
   * Protocol entry: run one **database-scope** {@link EngineDatabaseOperation} (JSON) against this
   * connected library and return the **raw** JSON {@link EngineOperationResult}. This is the JSON/
   * Designer-friendly counterpart of the fluent methods (`insert`, `bind`, `query().execute()`, ...),
   * which remain available unchanged. Use `model().query()` for revived entity results.
   */
  async apply(op: EngineOperation): Promise<EngineOperationResult> {
    if (!isDatabaseOperation(op)) {
      throw new Error(
        `RemoteModelDBClient.apply: "${op.op}" is not a database-scope operation; use the management API.`,
      );
    }
    const session = await this.ensureSession();
    return (await session.executeWireBodyRaw(op)) as EngineOperationResult;
  }

  /**
   * Protocol entry: run an ordered batch of database-scope operations over one connection. Returns one
   * {@link EngineApplyOutcome} per attempted op; with **`failFast`** (default `true`) it stops after the
   * first failure (the failing outcome is included).
   */
  async applyAll(
    ops: readonly EngineOperation[],
    opts?: { readonly failFast?: boolean },
  ): Promise<EngineApplyOutcome[]> {
    const failFast = opts?.failFast ?? true;
    const out: EngineApplyOutcome[] = [];
    for (const op of ops) {
      try {
        const result = await this.apply(op);
        out.push({ ok: true, result });
      } catch (e) {
        out.push({ ok: false, error: e instanceof Error ? e.message : String(e) });
        if (failFast) {
          break;
        }
      }
    }
    return out;
  }

  /** Meta: drop model schema and vault payload (server-side {@link AuthoringEngine.dropModel}). */
  async dropModel(model: string): Promise<void> {
    const session = await this.ensureSession();
    const out = await session.executeWireBody({ op: 'dropModel', model });
    if (!isRecord(out) || out.op !== 'dropModel' || out.ok !== true) {
      throw new Error('dropModel: unexpected remote response.');
    }
  }

  /** Meta: drop relation index and registry entry (server-side {@link AuthoringEngine.dropRelation}). */
  async dropRelation(
    relation: string,
    scope?: { readonly source: string; readonly target: string; readonly reverse: string },
  ): Promise<void> {
    const session = await this.ensureSession();
    const out = await session.executeWireBody({
      op: 'dropRelation',
      relation,
      ...(scope ? { source: scope.source, target: scope.target, reverse: scope.reverse } : {}),
    });
    if (!isRecord(out) || out.op !== 'dropRelation' || out.ok !== true) {
      throw new Error('dropRelation: unexpected remote response.');
    }
  }

  /**
   * Meta: schema change on the server (`AuthoringEngine.alterModel` or `alterModelPatch`).
   * Pass **`{ patch: true }`** to send only incremental field defs (Designer DDL).
   */
  async alterModel(
    model: string,
    schema: Readonly<Record<string, unknown>>,
    opts?: { readonly patch?: boolean },
  ): Promise<void> {
    const session = await this.ensureSession();
    const body: WireExecuteBody =
      opts?.patch === true
        ? { op: 'alterModel', model, schema, patch: true }
        : { op: 'alterModel', model, schema };
    const out = await session.executeWireBody(body);
    if (!isRecord(out) || out.op !== 'alterModel' || out.ok !== true) {
      throw new Error('alterModel: unexpected remote response.');
    }
  }

  /** Meta: idempotent model registration when absent (server-side authoring registry). */
  async registerModel(model: string, schema: Readonly<Record<string, unknown>>): Promise<void> {
    const session = await this.ensureSession();
    const out = await session.executeWireBody({ op: 'registerModel', model, schema });
    if (!isRecord(out) || out.op !== 'registerModel' || out.ok !== true) {
      throw new Error('registerModel: unexpected remote response.');
    }
  }

  /** Meta: idempotent relation registration when absent (server-side authoring registry). */
  async registerRelation(
    source: string,
    target: string,
    forward: string,
    reverse: string,
    logic: 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many',
    selfLoopPolicy?: WireRelationSelfLoopPolicy,
  ): Promise<void> {
    const session = await this.ensureSession();
    const out = await session.executeWireBody({
      op: 'registerRelation',
      source,
      target,
      forward,
      reverse,
      logic,
      ...(selfLoopPolicy ? { selfLoopPolicy } : {}),
    });
    if (!isRecord(out) || out.op !== 'registerRelation' || out.ok !== true) {
      throw new Error('registerRelation: unexpected remote response.');
    }
  }

  /**
   * 单次 RPC 内对多行执行 `update`（服务端在同一 write gate 内顺序执行并 `flushAll`）。
   * 与多次单独 `update` 相比减少往返与刷盘次数。
   */
  async batchUpdate(
    updates: readonly { model: string; id: string; partial: Record<string, unknown> }[],
    _opts?: { sync?: boolean },
  ): Promise<{ successCount: number; failureCount: number }> {
    const session = await this.ensureSession();
    const out = await session.executeWireBody({
      op: 'batchUpdate',
      updates: [...updates],
      sync: _opts?.sync,
    });
    if (
      !isRecord(out) ||
      out.op !== 'batchUpdate' ||
      typeof out.successCount !== 'number' ||
      typeof out.failureCount !== 'number'
    ) {
      throw new Error('batchUpdate: unexpected remote response shape.');
    }
    return { successCount: out.successCount, failureCount: out.failureCount };
  }

  /**
   * 单次 RPC 内对多行执行 `delete`（软删 + 清理关系边，服务端在同一 write gate 内 `flushAll`）。
   */
  async batchDelete(
    deletes: readonly { model: string; id: string }[],
    _opts?: { sync?: boolean },
  ): Promise<{ successCount: number; failureCount: number }> {
    if (deletes.length === 0) {
      return { successCount: 0, failureCount: 0 };
    }
    const session = await this.ensureSession();
    const out = await session.executeWireBody({
      op: 'batchDelete',
      deletes: [...deletes],
      sync: _opts?.sync,
    });
    if (
      !isRecord(out) ||
      out.op !== 'batchDelete' ||
      typeof out.successCount !== 'number' ||
      typeof out.failureCount !== 'number'
    ) {
      throw new Error('batchDelete: unexpected remote response shape.');
    }
    return { successCount: out.successCount, failureCount: out.failureCount };
  }

  // ---------------------------------------------------------------------------
  // Relation-authoring RPCs (data-level binding + bulk schema/topology DDL).
  //
  // Source-of-truth for topology lives in `AuthoringEngine`; this block is a
  // thin wire wrapper. The server always enforces that `source.model` /
  // `target.model` passed to `bindPair` / `unlinkPair` match the relation's
  // registered order — we do **not** replicate that check on the client.
  // ---------------------------------------------------------------------------

  /**
   * Link one source row to one target row on an **already-registered** relation.
   * Argument order must follow registration (`source → target`); mismatches are rejected server-side.
   */
  async bindRelation(
    source: RowRef | RemoteHydratedEntity,
    target: RowRef | RemoteHydratedEntity,
    forward: string,
    reverse: string,
  ): Promise<BindResult> {
    const session = await this.ensureSession();
    const out = await session.executeWireBody({
      op: 'bindPair',
      forward,
      reverse,
      source: toWireRowRef(source),
      target: toWireRowRef(target),
    });
    if (!isRecord(out) || out.op !== 'bindPair' || out.ok !== true) {
      throw new Error('bindRelation: unexpected remote response.');
    }
    return {
      ok: true,
      pairsCount: typeof out.pairsCount === 'number' ? out.pairsCount : 1,
    };
  }

  /** Remove a single `source → target` edge from a relation (order must match registration). */
  async unlinkRelation(
    source: RowRef | RemoteHydratedEntity,
    target: RowRef | RemoteHydratedEntity,
    forward: string,
    reverse: string,
  ): Promise<BindResult> {
    const session = await this.ensureSession();
    const out = await session.executeWireBody({
      op: 'unlinkPair',
      forward,
      reverse,
      source: toWireRowRef(source),
      target: toWireRowRef(target),
    });
    if (!isRecord(out) || out.op !== 'unlinkPair' || out.ok !== true) {
      throw new Error('unlinkRelation: unexpected remote response.');
    }
    return {
      ok: true,
      pairsCount: typeof out.pairsCount === 'number' ? out.pairsCount : 1,
    };
  }

  /**
   * Strategy-driven bulk bind (maps to {@link AuthoringEngine.bind}).
   *
   * - `'PROTOCOL'`: requires `matchOn` (persisted onto the relation when provided) and scans both sides
   *   for `src[sourceField] === tgt[targetField]`.
   * - `'GLOBAL'`: cross-join bind (use with `many-to-many`).
   * - `'MANUAL'`: explicit `pairs` (each `[srcId, targetId]` in registration order).
   */
  async bind(
    forward: string,
    strategy: WireBindStrategy,
    opts?: {
      readonly matchOn?: WireMatchPredicate;
      readonly pairs?: ReadonlyArray<readonly [string, string]>;
      readonly sync?: boolean;
    },
  ): Promise<BindResult> {
    const session = await this.ensureSession();
    const body: WireExecuteBody = {
      op: 'bind',
      forward,
      strategy,
      ...(opts?.matchOn ? { matchOn: opts.matchOn } : {}),
      ...(opts?.pairs ? { pairs: opts.pairs.map(([s, t]) => [s, t] as const) } : {}),
      ...(opts?.sync !== undefined ? { sync: opts.sync } : {}),
    };
    const out = await session.executeWireBody(body);
    if (!isRecord(out) || out.op !== 'bind' || out.ok !== true) {
      throw new Error('bind: unexpected remote response.');
    }
    return {
      ok: true,
      pairsCount: typeof out.pairsCount === 'number' ? out.pairsCount : 0,
      ...(isRecord(out.stats) ? { stats: out.stats as unknown as WireRelationStats } : {}),
    };
  }

  /**
   * Read-only dry-run for {@link bind}: returns the full pair count plus a bounded `sample`
   * (default 20) without writing the index. Intended for Designer "preview before bind" UX.
   */
  async previewBind(
    forward: string,
    strategy: WireBindStrategy,
    opts?: {
      readonly matchOn?: WireMatchPredicate;
      readonly pairs?: ReadonlyArray<readonly [string, string]>;
      readonly sample?: number;
    },
  ): Promise<{
    readonly forward: string;
    readonly pairsCount: number;
    readonly sample: readonly (readonly [string, string])[];
  }> {
    const session = await this.ensureSession();
    const body: WireExecuteBody = {
      op: 'previewBind',
      forward,
      strategy,
      ...(opts?.matchOn ? { matchOn: opts.matchOn } : {}),
      ...(opts?.pairs ? { pairs: opts.pairs.map(([s, t]) => [s, t] as const) } : {}),
      ...(opts?.sample !== undefined ? { sample: opts.sample } : {}),
    };
    const out = await session.executeWireBody(body);
    if (
      !isRecord(out) ||
      out.kind !== 'previewBind' ||
      typeof out.pairsCount !== 'number' ||
      !Array.isArray(out.sample)
    ) {
      throw new Error('previewBind: unexpected remote response.');
    }
    return {
      forward: String(out.forward ?? forward),
      pairsCount: out.pairsCount,
      sample: (out.sample as unknown[]).map((p) => {
        const tuple = p as readonly [string, string];
        return [tuple[0], tuple[1]] as const;
      }),
    };
  }

  /** Live counters for a relation index (drives Designer edge annotations). */
  async relationStats(forward: string): Promise<WireRelationStats & { readonly forward: string }> {
    const session = await this.ensureSession();
    const out = await session.executeWireBody({ op: 'relationStats', forward });
    if (
      !isRecord(out) ||
      out.kind !== 'relationStats' ||
      typeof out.forwardKeys !== 'number' ||
      typeof out.reverseKeys !== 'number' ||
      typeof out.totalLinks !== 'number'
    ) {
      throw new Error('relationStats: unexpected remote response.');
    }
    return {
      forward: String(out.forward ?? forward),
      forwardKeys: out.forwardKeys,
      reverseKeys: out.reverseKeys,
      totalLinks: out.totalLinks,
    };
  }

  /**
   * Update a relation's cardinality logic / `matchOn` without rebinding existing edges.
   * Typical use: Designer user picks match fields on an already-registered relation before
   * calling {@link bind} with `'PROTOCOL'`.
   */
  async updateRelationLogic(
    forward: string,
    logic: WireRelationLogic,
    matchOn?: WireMatchPredicate,
    selfLoopPolicy?: WireRelationSelfLoopPolicy,
    scope?: { readonly source: string; readonly target: string; readonly reverse: string },
  ): Promise<void> {
    const session = await this.ensureSession();
    const body: WireExecuteBody = {
      op: 'updateRelationLogic',
      forward,
      ...(scope ? { source: scope.source, target: scope.target, reverse: scope.reverse } : {}),
      logic,
      ...(matchOn ? { matchOn } : {}),
      ...(selfLoopPolicy ? { selfLoopPolicy } : {}),
    };
    const out = await session.executeWireBody(body);
    if (!isRecord(out) || out.op !== 'updateRelationLogic' || out.ok !== true) {
      throw new Error('updateRelationLogic: unexpected remote response.');
    }
  }

  /**
   * Idempotent bulk DDL: register any missing **models** and **relations** inside a single
   * server-side write gate (see `AuthoringEngine.registerModel` / `registerRelation`). Use
   * `{ quickLink: true }` to let the server auto-create source/target models referenced by
   * any relation that hasn't been registered yet.
   */
  async batchRegister(input: BatchRegisterInput): Promise<BatchRegisterResult> {
    const session = await this.ensureSession();
    const body: WireExecuteBody = {
      op: 'batchRegister',
      ...(input.models ? { models: input.models.map((m) => ({ ...m })) } : {}),
      ...(input.relations ? { relations: input.relations.map((r) => ({ ...r })) } : {}),
      ...(input.quickLink !== undefined ? { quickLink: input.quickLink } : {}),
    };
    const out = await session.executeWireBody(body);
    if (!isRecord(out) || out.op !== 'batchRegister' || out.ok !== true) {
      throw new Error('batchRegister: unexpected remote response.');
    }
    return {
      ok: true,
      created: (out.created as BatchRegisterResult['created']) ?? { models: [], relations: [] },
      skipped: (out.skipped as BatchRegisterResult['skipped']) ?? { models: [], relations: [] },
    };
  }

  /**
   * Sugar for {@link batchRegister} using compact `[source, target, forward, reverse]` tuples
   * — equivalent to calling {@link AuthoringEngine.quickLink} for each tuple on the server.
   */
  async quickLinkBatch(tuples: readonly QuickLinkTuple[]): Promise<BatchRegisterResult> {
    if (tuples.length === 0) {
      return {
        ok: true,
        created: { models: [], relations: [] },
        skipped: { models: [], relations: [] },
      };
    }
    return this.batchRegister({
      relations: tuples.map(([source, target, forward, reverse]) => ({
        source,
        target,
        forward,
        reverse,
      })),
      quickLink: true,
    });
  }

  close(): void {
    this._ws?.close();
    this._ws = undefined;
    this._session = undefined;
    this._connectOnce = null;
  }
}

/** Thin alias: network-only connector (no local engine); use {@link RemoteModelDBClient.connectNetwork}. */
export class ModelDBClient {
  static connect(options: {
    readonly host: string;
    readonly port: number;
    readonly secure?: boolean;
    readonly token: string;
    readonly database: string;
    readonly mode?: 'short' | 'stream';
    readonly webSocketCtor?: WebSocketCtor;
  }): Promise<RemoteModelDBClient> {
    return RemoteModelDBClient.connectNetwork(options);
  }
}

export async function connectRemote(options: ConnectRemoteOptions): Promise<RemoteModelDBClient> {
  return RemoteModelDBClient.connect(options);
}

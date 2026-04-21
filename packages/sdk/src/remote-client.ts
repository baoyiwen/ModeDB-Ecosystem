import {
  decodeWirePayload,
  deriveWireSessionKey,
  encodeWirePayload,
  WireQueryChain,
  type ManagementCatalogResponse,
  type ManagementDatabaseInfo,
  type ManagementDatabasesResponse,
  type ManagementStatusResponse,
  type QueryExecuteOptions,
  type QueryStartSpec,
  type RemoteExecuteSnapshot,
  type WireExecuteBody,
  type WireExecuteResultJson,
} from '@mode-db/shared';

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

/** Row handle compatible with {@link HydratedEntity} for `getData` / `getModelName`. */
export class RemoteHydratedEntity {
  constructor(
    private readonly row: Record<string, unknown>,
    private readonly model: string,
  ) {}

  getData(_deep?: boolean): Record<string, unknown> {
    return this.row;
  }

  getModelName(): string {
    return this.model;
  }
}

function reviveWireResult(json: WireExecuteResultJson): unknown {
  if (json.kind === 'paginated') {
    return {
      items: reviveWireResult(json.items),
      total: json.total,
      page: json.page,
      limit: json.limit,
      pageCount: json.pageCount,
    };
  }
  if (json.kind === 'rows') {
    return json.rows.map((r) => new RemoteHydratedEntity(r.data, r.model));
  }
  if (json.kind === 'mutation') {
    if (json.op === 'insertMany') {
      return {
        op: 'insertMany' as const,
        model: json.model,
        successCount: json.successCount ?? 0,
        failureCount: json.failureCount ?? 0,
      };
    }
    if (json.op === 'batchUpdate') {
      return {
        op: 'batchUpdate' as const,
        successCount: json.successCount ?? 0,
        failureCount: json.failureCount ?? 0,
      };
    }
    if (
      json.op === 'dropModel' ||
      json.op === 'dropRelation' ||
      json.op === 'alterModel' ||
      json.op === 'registerModel' ||
      json.op === 'registerRelation'
    ) {
      return {
        op: json.op,
        model: json.model,
        relation: json.relation,
        ok: json.ok === true,
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
  let W: WebSocketCtor | undefined = WebSocketCtor;
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
  return ws;
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
  executeWireBody(body: WireExecuteBody): Promise<unknown>;
};

class ShortRemoteSession implements QuerySession {
  constructor(
    private readonly httpOrigin: string,
    private readonly connectToken: string,
    readonly atlas: string,
  ) {}

  async connectHandshake(): Promise<void> {
    const r = await fetch(`${this.httpOrigin}/health`);
    if (!r.ok) {
      throw new Error(`Short mode: health check failed (HTTP ${r.status}).`);
    }
    const j = (await r.json()) as { ok?: boolean };
    if (!j?.ok) {
      throw new Error('Short mode: server /health did not return { ok: true }.');
    }
  }

  async executeWireBody(body: WireExecuteBody): Promise<unknown> {
    const id = nextRpcId();
    const sessionKey = deriveWireSessionKey(this.connectToken, this.atlas);
    const cipher = encodeWirePayload(JSON.stringify(body), sessionKey);
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
      throw new Error(String(msg.error ?? 'RPC error'));
    }
    if (msg.type !== 'rpc.ok' || typeof msg.cipher !== 'string') {
      throw new Error('Short mode: expected { type: "rpc.ok", cipher }.');
    }
    const plain = decodeWirePayload(msg.cipher, sessionKey);
    const json = JSON.parse(plain) as WireExecuteResultJson;
    return reviveWireResult(json);
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
    { readonly resolve: (v: unknown) => void; readonly reject: (e: Error) => void }
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
          def.resolve(reviveWireResult(body));
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
        def.reject(new Error(errText));
        this.pending.delete(id);
      }
    }
  }

  connectHandshake(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.handshakeWait = { resolve, reject };
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

  executeWireBody(body: WireExecuteBody): Promise<unknown> {
    const id = nextRpcId();
    const cipher = encodeWirePayload(JSON.stringify(body), this.sessionKey);
    const payload = JSON.stringify({ type: 'rpc', id, cipher });
    const p = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.ws.send(payload);
    return p;
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

/** Remote model handle: `query()` returns a {@link RemoteQueryChain}; `insertMany` uses the write RPC. */
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
   * Batch insert over the wire (server runs {@link AuthoringEngine} **`insertMany`** inside the write gate).
   * At most **20_000** rows per call (server cap).
   */
  async insertMany(
    rows: readonly Record<string, unknown>[],
    opts?: { sync?: boolean },
  ): Promise<{ successCount: number; failureCount: number }> {
    const session = await this.getSession();
    const out = await session.executeWireBody({
      op: 'insertMany',
      model: this.name,
      rows: [...rows],
      sync: opts?.sync,
    });
    if (
      !isRecord(out) ||
      out.op !== 'insertMany' ||
      typeof out.successCount !== 'number' ||
      typeof out.failureCount !== 'number'
    ) {
      throw new Error('insertMany: unexpected remote response shape.');
    }
    return { successCount: out.successCount, failureCount: out.failureCount };
  }
}

async function fetchManagementJson<T>(origin: string, token: string, path: string): Promise<T> {
  const base = origin.replace(/\/$/, '');
  const url = `${base}${path}`;
  const res = await fetch(url, {
    headers: { 'X-ModelDB-Connect-Token': token },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Management API failed (${path}): HTTP ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

async function fetchManagementPostJson<T>(
  origin: string,
  token: string,
  path: string,
  body: unknown,
): Promise<T> {
  const base = origin.replace(/\/$/, '');
  const url = `${base}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-ModelDB-Connect-Token': token,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Management API failed (${path}): HTTP ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

async function fetchManagementDelete(origin: string, token: string, path: string): Promise<void> {
  const base = origin.replace(/\/$/, '');
  const url = `${base}${path}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { 'X-ModelDB-Connect-Token': token },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Management API failed (${path}): HTTP ${res.status} ${text}`);
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
    const mode = this.options.mode ?? 'stream';
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
    readonly token: string;
  }): Promise<readonly ManagementDatabaseInfo[]> {
    const origin = `http://${options.host}:${options.port}`;
    const json = await fetchManagementJson<ManagementDatabasesResponse>(
      origin,
      options.token,
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
    readonly token: string;
  }): Promise<ManagementStatusResponse> {
    const origin = `http://${options.host}:${options.port}`;
    return fetchManagementJson<ManagementStatusResponse>(
      origin,
      options.token,
      '/api/v1/management/status',
    );
  }

  /**
   * Model + relation catalog for one logical DB (**`GET …/databases/:name/catalog`**).
   */
  static async getDatabaseCatalog(options: {
    readonly host: string;
    readonly port: number;
    readonly token: string;
    readonly database: string;
  }): Promise<ManagementCatalogResponse> {
    const origin = `http://${options.host}:${options.port}`;
    const enc = encodeURIComponent(options.database.trim());
    return fetchManagementJson<ManagementCatalogResponse>(
      origin,
      options.token,
      `/api/v1/management/databases/${enc}/catalog`,
    );
  }

  /** Create nested workspace directory and empty vault (`POST /api/v1/management/databases`). */
  static async createDatabase(options: {
    readonly host: string;
    readonly port: number;
    readonly token: string;
    readonly name: string;
  }): Promise<void> {
    const origin = `http://${options.host}:${options.port}`;
    await fetchManagementPostJson<{ ok?: boolean }>(
      origin,
      options.token,
      '/api/v1/management/databases',
      { name: options.name.trim() },
    );
  }

  /** Remove logical DB directory or flat **`*.mld`** from workspace (**`DELETE …/databases/:name`**). */
  static async deleteDatabase(options: {
    readonly host: string;
    readonly port: number;
    readonly token: string;
    readonly name: string;
  }): Promise<void> {
    const origin = `http://${options.host}:${options.port}`;
    const enc = encodeURIComponent(options.name.trim());
    await fetchManagementDelete(origin, options.token, `/api/v1/management/databases/${enc}`);
  }

  /**
   * Connect by host/port (HTTP origin + WebSocket stream); same wire protocol as {@link connectRemote}.
   */
  static async connectNetwork(options: {
    readonly host: string;
    readonly port: number;
    readonly token: string;
    readonly database: string;
    readonly mode?: 'short' | 'stream';
    readonly webSocketCtor?: WebSocketCtor;
  }): Promise<RemoteModelDBClient> {
    const url = `http://${options.host}:${options.port}`;
    return RemoteModelDBClient.connect({
      url,
      connectToken: options.token,
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

  /** Meta: drop model schema and vault payload (server-side {@link AuthoringEngine.dropModel}). */
  async dropModel(model: string): Promise<void> {
    const session = await this.ensureSession();
    const out = await session.executeWireBody({ op: 'dropModel', model });
    if (!isRecord(out) || out.op !== 'dropModel' || out.ok !== true) {
      throw new Error('dropModel: unexpected remote response.');
    }
  }

  /** Meta: drop relation index and registry entry (server-side {@link AuthoringEngine.dropRelation}). */
  async dropRelation(relation: string): Promise<void> {
    const session = await this.ensureSession();
    const out = await session.executeWireBody({ op: 'dropRelation', relation });
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
  ): Promise<void> {
    const session = await this.ensureSession();
    const out = await session.executeWireBody({
      op: 'registerRelation',
      source,
      target,
      forward,
      reverse,
      logic,
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

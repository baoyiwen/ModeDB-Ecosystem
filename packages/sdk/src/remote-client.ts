import { decodeWirePayload, deriveWireSessionKey, encodeWirePayload } from '@mode-db/shared';
import {
  ModelRegistry,
  QueryChain,
  RuntimeModel,
  type DataReader,
  type IndexReader,
  type QueryExecuteOptions,
  type QueryStartSpec,
  type RemoteExecuteSnapshot,
  type WireExecuteBody,
  type WireExecuteResultJson,
} from 'mode-db-engine';

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

function noLocal(): never {
  throw new Error('RemoteQueryChain does not perform local storage I/O.');
}

const stubDataReader: DataReader = {
  getByIds: () => noLocal(),
  getAll: () => noLocal(),
};

const stubIndexReader: IndexReader = {
  getForward: async () => [],
  getReverse: async () => [],
};

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
  on(event: string, fn: (...args: unknown[]) => void): void;
  once(event: 'open' | 'error', fn: (...args: unknown[]) => void): void;
  addEventListener?(
    type: 'open' | 'error' | 'message',
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

function messageText(raw: unknown): string {
  if (typeof raw === 'string') {
    return raw;
  }
  if (raw instanceof ArrayBuffer) {
    return new TextDecoder().decode(raw);
  }
  if (ArrayBuffer.isView(raw)) {
    return new TextDecoder().decode(raw as Uint8Array);
  }
  if (raw && typeof (raw as Buffer).toString === 'function') {
    return (raw as Buffer).toString('utf-8');
  }
  return String(raw);
}

export interface ConnectRemoteOptions {
  readonly url: string;
  readonly connectToken: string;
  readonly atlas: string;
  /**
   * **`short`**: stateless **HTTP POST `/v2/action`** (good for tools / batch).
   * **`stream`**: **WebSocket `/v2/stream`** (default; good for interactive UIs).
   */
  readonly mode?: 'short' | 'stream';
  readonly webSocketCtor?: WebSocketCtor;
}

type QuerySession = {
  readonly stubRegistry: ModelRegistry;
  readonly stubData: DataReader;
  readonly stubIndex: IndexReader;
  readonly atlas: string;
  connectHandshake(): Promise<void>;
  executeSnapshot(snapshot: RemoteExecuteSnapshot): Promise<unknown>;
  executeWireBody(body: WireExecuteBody): Promise<unknown>;
};

class ShortRemoteSession implements QuerySession {
  readonly stubRegistry = new ModelRegistry();
  readonly stubData: DataReader = stubDataReader;
  readonly stubIndex: IndexReader = stubIndexReader;

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
  readonly stubRegistry = new ModelRegistry();
  readonly stubData: DataReader = stubDataReader;
  readonly stubIndex: IndexReader = stubIndexReader;

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
    this.ws.on('message', (raw) => {
      this.onSocketMessage(raw);
    });
    this.ws.on('close', () => {
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

/** Fluent query chain that RPCs {@link QueryChain.execute} to the server. */
export class RemoteQueryChain<
  M extends Record<string, unknown> = Record<string, unknown>,
  Mode extends 'rows' | 'analysis' = 'rows',
> extends QueryChain<M, Mode> {
  constructor(
    private readonly session: QuerySession,
    modelName: string,
    start: QueryStartSpec,
  ) {
    super(session.stubRegistry, session.stubIndex, session.stubData, modelName, start);
  }

  override async execute(options?: QueryExecuteOptions): Promise<unknown> {
    const snapshot = this.getRemoteExecuteSnapshot(options);
    return this.session.executeSnapshot(snapshot);
  }
}

export class RemoteRuntimeModel extends RuntimeModel {
  constructor(
    private readonly session: QuerySession,
    name: string,
  ) {
    super(name, session.stubRegistry, session.stubData, session.stubIndex);
  }

  override query<M extends Record<string, unknown> = Record<string, unknown>>(
    ids?: readonly string[],
  ): RemoteQueryChain<M, 'rows'> {
    if (ids === undefined) {
      return new RemoteQueryChain(this.session, this.name, { kind: 'all' });
    }
    return new RemoteQueryChain(this.session, this.name, { kind: 'ids', ids: [...ids] });
  }

  /**
   * Batch insert over the wire (server runs {@link AuthoringEngine} **`insertMany`** inside the write gate).
   * At most **20_000** rows per call (server cap).
   */
  async insertMany(
    rows: readonly Record<string, unknown>[],
    opts?: { sync?: boolean },
  ): Promise<{ successCount: number; failureCount: number }> {
    const out = await this.session.executeWireBody({
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

export class RemoteModelDBClient {
  private constructor(
    private readonly ws: WsEmitter | undefined,
    private readonly session: QuerySession,
  ) {}

  static async connect(options: ConnectRemoteOptions): Promise<RemoteModelDBClient> {
    const mode = options.mode ?? 'stream';
    if (mode === 'short') {
      const origin = toHttpOrigin(options.url);
      const session = new ShortRemoteSession(origin, options.connectToken, options.atlas);
      await session.connectHandshake();
      return new RemoteModelDBClient(undefined, session);
    }
    const wsUrl = toWsStreamUrl(options.url);
    const ws = await openWebSocket(wsUrl, options.webSocketCtor);
    const session = new RemoteSession(ws, options.connectToken, options.atlas);
    await session.connectHandshake();
    return new RemoteModelDBClient(ws, session);
  }

  model(name: string): RemoteRuntimeModel {
    return new RemoteRuntimeModel(this.session, name);
  }

  close(): void {
    this.ws?.close();
  }
}

export async function connectRemote(options: ConnectRemoteOptions): Promise<RemoteModelDBClient> {
  return RemoteModelDBClient.connect(options);
}

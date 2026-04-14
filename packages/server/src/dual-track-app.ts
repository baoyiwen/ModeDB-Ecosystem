import { mkdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import WS, { type WebSocket, type RawData } from 'ws';
import {
  deriveWireSessionKey,
  type WireClientMessage,
  type WireHandshakeRequest,
  type WireRpcEnvelope,
  type WireServerMessage,
} from '@mode-db/shared';
import { configureModelDBStorageRoot, EngineLogger } from '@mode-db/common';
import { ModelDBClient } from '@mode-db/engine';
import { BinaryInterceptor, TransportAuthError } from './binary-interceptor.js';
import type { ResolvedModelDBServerConfig } from './config-loader.js';
import { AuthoringBridge } from './authoring-bridge.js';
import { WriteSerializationGate } from './write-serialization-gate.js';
import { WireRequestDispatcher, decodeExecuteBody } from './request-dispatcher.js';
import { atlasCatalogSignature } from './atlas-catalog-signature.js';
import { assertLogicalDatabaseExists } from './logical-database-guard.js';

const MAX_BULK_ITEMS = 50_000;
const BULK_CONCURRENCY = 4;
const WS_HEARTBEAT_MS = 25_000;

/** Logical library directory under **`workspace`** (aka **`storageRoot`**): `<workspace>/<logical>/`. */
export function resolveLogicalDbFromHandshake(hs: WireHandshakeRequest): string {
  const d = typeof hs.dbName === 'string' ? hs.dbName.trim() : '';
  const a = typeof hs.atlas === 'string' ? hs.atlas.trim() : '';
  const v = d || a;
  if (!v) {
    throw new Error('Handshake requires non-empty dbName or atlas.');
  }
  return v;
}

function resolveLogicalDbFromHttpHeaders(headers: IncomingMessage['headers']): string {
  const dn = String(headers['x-modeldb-db-name'] ?? '').trim();
  const at = String(headers['x-modeldb-atlas'] ?? '').trim();
  return dn || at;
}

type SocketState =
  | { readonly phase: 'guest' }
  | { readonly phase: 'ready'; readonly sessionKey: string; readonly atlas: string };

function sendJsonWs(ws: WebSocket, msg: WireServerMessage): void {
  ws.send(JSON.stringify(msg));
}

function parseWsText(interceptor: BinaryInterceptor, data: RawData): string {
  const buf =
    typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data as ArrayBufferLike);
  return interceptor.unwrapTransportPayload(buf);
}

function storageRootFingerprint(absoluteRoot: string): string {
  return createHash('sha256').update(absoluteRoot, 'utf8').digest('hex');
}

function attachWireSocket(
  ws: WebSocket,
  req: IncomingMessage,
  cfg: ResolvedModelDBServerConfig,
  getClient: (atlas: string) => Promise<ModelDBClient>,
  dispatcher: WireRequestDispatcher,
): void {
  const interceptor = new BinaryInterceptor(cfg.connectToken);
  const remote = req.socket.remoteAddress ?? 'unknown';
  EngineLogger.instance.info('WebSocket client connected', { remote }, 'ModelDBServer');
  // eslint-disable-next-line no-console
  console.log(`[modeldb-server] connect ${remote}`);

  const heartbeat = setInterval(() => {
    if (ws.readyState === WS.OPEN) {
      ws.ping();
    }
  }, WS_HEARTBEAT_MS);

  let state: SocketState = { phase: 'guest' };

  ws.on('close', (code, reason) => {
    clearInterval(heartbeat);
    EngineLogger.instance.info(
      'WebSocket client disconnected',
      {
        remote,
        code,
        reason: reason.toString(),
      },
      'ModelDBServer',
    );
    // eslint-disable-next-line no-console
    console.log(`[modeldb-server] disconnect ${remote} code=${code}`);
  });

  ws.on('message', async (data: RawData) => {
    let parsed: WireClientMessage | undefined;
    try {
      const text = parseWsText(interceptor, data);
      parsed = JSON.parse(text) as WireClientMessage;
    } catch {
      EngineLogger.instance.warn(
        'Invalid transport or JSON on WebSocket',
        { remote },
        'ModelDBServer',
      );
      sendJsonWs(ws, { type: 'error', message: 'Invalid transport or JSON message.' });
      ws.close();
      return;
    }

    try {
      if (state.phase === 'guest') {
        if (parsed.type !== 'handshake') {
          throw new Error('Expected handshake first.');
        }
        const hs: WireHandshakeRequest = parsed;
        interceptor.validateConnectToken(hs.connectToken);
        const logicalDb = resolveLogicalDbFromHandshake(hs);
        await getClient(logicalDb);
        const sessionKey = deriveWireSessionKey(hs.connectToken, logicalDb);
        state = { phase: 'ready', sessionKey, atlas: logicalDb };
        const d = typeof hs.dbName === 'string' ? hs.dbName.trim() : '';
        const a = typeof hs.atlas === 'string' ? hs.atlas.trim() : '';
        sendJsonWs(ws, {
          type: 'handshake.ok',
          ...(d ? { dbName: d } : {}),
          ...(a ? { atlas: a } : {}),
        });
        return;
      }

      if (parsed.type === 'handshake') {
        sendJsonWs(ws, { type: 'error', message: 'Already handshaken.' });
        return;
      }

      if (parsed.type !== 'rpc') {
        sendJsonWs(ws, { type: 'error', message: 'Unknown message type.' });
        return;
      }

      const env = parsed as WireRpcEnvelope;
      const body = decodeExecuteBody(env.cipher, state.sessionKey);
      if (cfg.dev) {
        console.error('[modeldb-server][dev] inbound RPC op', (body as { op?: string }).op);
      }
      await dispatcher.dispatchRpc(ws, state.sessionKey, state.atlas, body, env.id);
    } catch (e) {
      if (e instanceof TransportAuthError) {
        EngineLogger.instance.warn(
          'WebSocket transport auth failed',
          {
            remote,
            reason: e.message,
          },
          'ModelDBServer',
        );
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        const code =
          e instanceof Error && 'code' in e ? String((e as NodeJS.ErrnoException).code) : '';
        if (code && ['EIO', 'ENOSPC', 'EROFS'].includes(code)) {
          EngineLogger.instance.error(
            'Fatal storage I/O on WebSocket path',
            {
              remote,
              code,
              message: msg,
            },
            'ModelDBServer',
          );
        }
      }
      const message = e instanceof Error ? e.message : String(e);
      const id =
        parsed && typeof parsed === 'object' && 'type' in parsed && parsed.type === 'rpc'
          ? (parsed as WireRpcEnvelope).id
          : '';
      if (id) {
        sendJsonWs(ws, { type: 'rpc.err', id, error: message });
      } else {
        sendJsonWs(ws, { type: 'error', message });
      }
    }
  });
}

export function getServerListeningPort(app: FastifyInstance): number {
  const addr = app.server.address();
  if (typeof addr === 'object' && addr !== null) {
    return addr.port;
  }
  throw new Error('Server is not listening or address is not a TCP endpoint.');
}

function readActionEnvelope(
  interceptor: BinaryInterceptor,
  body: unknown,
): { cipher: string; id: string } {
  if (Buffer.isBuffer(body)) {
    const text = interceptor.unwrapTransportPayload(body);
    const envelope = JSON.parse(text) as { cipher?: string; id?: string };
    const cipher = envelope.cipher;
    const id =
      typeof envelope.id === 'string' && envelope.id.length > 0 ? envelope.id : randomUUID();
    if (!cipher || typeof cipher !== 'string') {
      throw new Error('Missing cipher in decoded body.');
    }
    return { cipher, id };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Expected JSON object body { cipher, id? } or application/octet-stream frame.');
  }
  const envelope = body as { cipher?: string; id?: string };
  const cipher = envelope.cipher;
  const id = typeof envelope.id === 'string' && envelope.id.length > 0 ? envelope.id : randomUUID();
  if (!cipher || typeof cipher !== 'string') {
    throw new Error('Missing cipher in body.');
  }
  return { cipher, id };
}

export async function buildDualTrackFastify(
  cfg: ResolvedModelDBServerConfig,
): Promise<FastifyInstance> {
  const dataRoot = cfg.workspace ?? cfg.storageRoot;
  configureModelDBStorageRoot({ storageRoot: dataRoot });
  process.env.MODEL_DB_CONNECT_TOKEN = cfg.connectToken;

  const rootPrint = storageRootFingerprint(dataRoot);

  if (cfg.serverLogDirectory) {
    EngineLogger.instance.configure({
      logDirectory: cfg.serverLogDirectory,
      enableAccessLog: cfg.accessLog === true,
    });
  } else {
    EngineLogger.instance.configure({
      atlasRoot: `${dataRoot}/.modeldb-server`,
      enableAccessLog: cfg.accessLog === true,
    });
  }

  mkdirSync(dataRoot, { recursive: true });
  EngineLogger.instance.info('Workspace directory ready', { workspace: dataRoot }, 'ModelDBServer');
  EngineLogger.instance.info(
    'ModelDB Server starting (dual-track)',
    {
      host: cfg.host,
      port: cfg.port,
      dev: cfg.dev,
      storageRootSha256: rootPrint,
    },
    'ModelDBServer',
  );
  // eslint-disable-next-line no-console
  console.log(`[modeldb-server] storage fingerprint (sha256): ${rootPrint}`);

  const atlasClients = new Map<
    string,
    { readonly sig: string; readonly promise: Promise<ModelDBClient> }
  >();
  function getClient(atlas: string): Promise<ModelDBClient> {
    assertLogicalDatabaseExists(dataRoot, atlas);
    const sig = atlasCatalogSignature(dataRoot, atlas);
    const hit = atlasClients.get(atlas);
    if (hit && hit.sig === sig) {
      return hit.promise;
    }
    const p = ModelDBClient.connect(atlas);
    atlasClients.set(atlas, { sig, promise: p });
    return p;
  }

  const authoring = new AuthoringBridge(dataRoot, cfg.connectToken, cfg.bufferFlushRowThreshold);
  const writeGate = new WriteSerializationGate();
  const dispatcher = new WireRequestDispatcher({
    dev: cfg.dev,
    getClient,
    getEngine: (atlas) => authoring.getEngine(atlas),
    writeGate,
  });

  const app = Fastify({ logger: false, bodyLimit: 128 * 1024 * 1024 });

  app.addHook('onResponse', async (request, reply) => {
    if (EngineLogger.instance.isAccessLogEnabled()) {
      EngineLogger.instance.accessInfo(
        `HTTP ${request.method} ${request.url}`,
        { status: reply.statusCode },
        'ModelDBServer',
      );
    }
  });

  await app.register(websocket);

  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    async (_req: FastifyRequest, body: Buffer) => body,
  );

  app.get('/health', async () => ({ ok: true as const, v: 2 }));

  app.post('/v2/action', async (request: FastifyRequest, reply: FastifyReply) => {
    const interceptor = new BinaryInterceptor(cfg.connectToken);
    try {
      const token = String(request.headers['x-modeldb-connect-token'] ?? '');
      interceptor.validateConnectToken(token);
      const logical = resolveLogicalDbFromHttpHeaders(request.headers);
      if (!logical) {
        return reply
          .code(400)
          .send({ error: 'Missing X-ModelDB-Db-Name or X-ModelDB-Atlas header.' });
      }

      const { cipher, id } = readActionEnvelope(interceptor, request.body);

      const sessionKey = deriveWireSessionKey(token, logical);
      await getClient(logical);
      const body = decodeExecuteBody(cipher, sessionKey);
      const out = await dispatcher.runRpcCipherReply(logical, sessionKey, body, id);
      return reply.send(out);
    } catch (e) {
      if (e instanceof TransportAuthError) {
        EngineLogger.instance.warn(
          'HTTP transport auth failed',
          {
            reason: e.message,
            route: '/v2/action',
          },
          'ModelDBServer',
        );
        return reply.code(401).send({ error: e.message });
      }
      const message = e instanceof Error ? e.message : String(e);
      const code =
        e instanceof Error && 'code' in e ? String((e as NodeJS.ErrnoException).code) : '';
      if (code && ['EIO', 'ENOSPC', 'EROFS'].includes(code)) {
        EngineLogger.instance.error(
          'Fatal storage I/O on HTTP /v2/action',
          { code, message },
          'ModelDBServer',
        );
      }
      return reply.code(500).send({ error: message });
    }
  });

  app.post('/v2/bulk', async (request: FastifyRequest, reply: FastifyReply) => {
    const interceptor = new BinaryInterceptor(cfg.connectToken);
    try {
      const token = String(request.headers['x-modeldb-connect-token'] ?? '');
      interceptor.validateConnectToken(token);
      const logical = resolveLogicalDbFromHttpHeaders(request.headers);
      if (!logical) {
        return reply
          .code(400)
          .send({ error: 'Missing X-ModelDB-Db-Name or X-ModelDB-Atlas header.' });
      }
      const root = request.body as { items?: unknown };
      if (!root || !Array.isArray(root.items)) {
        return reply.code(400).send({ error: 'Expected JSON { items: [{ cipher, id? }, ...] }.' });
      }
      const items = root.items as Array<{ cipher?: string; id?: string }>;
      if (items.length > MAX_BULK_ITEMS) {
        return reply.code(400).send({ error: `At most ${MAX_BULK_ITEMS} items per request.` });
      }

      const sessionKey = deriveWireSessionKey(token, logical);
      await getClient(logical);

      let ok = 0;
      for (let i = 0; i < items.length; i += BULK_CONCURRENCY) {
        const slice = items.slice(i, i + BULK_CONCURRENCY);
        await Promise.all(
          slice.map(async (item) => {
            const cipher = item.cipher;
            const id = typeof item.id === 'string' && item.id.length > 0 ? item.id : randomUUID();
            if (!cipher) {
              throw new Error('Bulk item missing cipher.');
            }
            const body = decodeExecuteBody(cipher, sessionKey);
            const out = await dispatcher.runRpcCipherReply(logical, sessionKey, body, id);
            if (out.type === 'rpc.err') {
              throw new Error(out.error);
            }
            ok++;
          }),
        );
        await new Promise<void>((r) => setImmediate(r));
      }

      return reply.send({ ok: true as const, frames: ok });
    } catch (e) {
      if (e instanceof TransportAuthError) {
        EngineLogger.instance.warn(
          'HTTP transport auth failed',
          {
            reason: e.message,
            route: '/v2/bulk',
          },
          'ModelDBServer',
        );
        return reply.code(401).send({ error: e.message });
      }
      const message = e instanceof Error ? e.message : String(e);
      const code =
        e instanceof Error && 'code' in e ? String((e as NodeJS.ErrnoException).code) : '';
      if (code && ['EIO', 'ENOSPC', 'EROFS'].includes(code)) {
        EngineLogger.instance.error(
          'Fatal storage I/O on HTTP /v2/bulk',
          { code, message },
          'ModelDBServer',
        );
      }
      return reply.code(500).send({ error: message });
    }
  });

  const wsHandler = (socket: WebSocket, rawRequest: FastifyRequest): void => {
    attachWireSocket(socket, rawRequest.raw, cfg, getClient, dispatcher);
  };

  app.get('/', { websocket: true }, (socket, request) => {
    wsHandler(socket as WebSocket, request);
  });

  app.get('/v2/stream', { websocket: true }, (socket, request) => {
    wsHandler(socket as WebSocket, request);
  });

  await app.listen({ port: cfg.port, host: cfg.host });

  const port = getServerListeningPort(app);
  // eslint-disable-next-line no-console
  console.log(
    `ModelDB Server is running on http://${cfg.host}:${port} (POST /v2/action, POST /v2/bulk, WS / & /v2/stream)`,
  );
  EngineLogger.instance.info(
    `ModelDB Server is running on port ${port}`,
    { host: cfg.host },
    'ModelDBServer',
  );

  return app;
}

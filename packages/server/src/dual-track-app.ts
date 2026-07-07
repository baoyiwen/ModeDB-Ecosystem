import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import WS, { type WebSocket, type RawData } from 'ws';
import {
  deriveWireSessionKey,
  type ManagementBackupCreateResponse,
  type ManagementBackupRestoreResponse,
  type ManagementBackupsResponse,
  type ManagementClearDatabaseResponse,
  type ManagementCatalogResponse,
  type ManagementDatabaseInfo,
  type ManagementDatabasesResponse,
  type ManagementStatusResponse,
  type WireClientMessage,
  type WireHandshakeRequest,
  type WireRpcEnvelope,
  type WireServerMessage,
} from '@mode-db/shared';
import { assertFlatGraphSegment, configureModelDBStorageRoot, EngineLogger } from '@mode-db/common';
import { ModelDBClient, type AuthoringEngine } from '@mode-db/core';
import { BinaryInterceptor, TransportAuthError } from './binary-interceptor.js';
import type { ResolvedModelDBServerConfig } from './config-loader.js';
import { AuthoringBridge } from './authoring-bridge.js';
import { startAutoBackupScheduler } from './auto-backup-scheduler.js';
import { WriteSerializationGate } from './write-serialization-gate.js';
import { WireRequestDispatcher, decodeExecuteBody } from './request-dispatcher.js';
import { atlasCatalogSignature } from './atlas-catalog-signature.js';
import { assertLogicalDatabaseExists } from './logical-database-guard.js';
import { scanWorkspaceDatabases } from './management-api.js';
import {
  createDatabaseBackup,
  forceResetDatabase,
  listDatabaseBackups,
  restoreDatabaseBackup,
} from './backup-manager.js';
import {
  getConnectedWebSocketClients,
  getProcessUptimeSeconds,
  recordWebSocketConnection,
} from './server-runtime-stats.js';

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

function readConnectTokenFromHttpRequest(request: FastifyRequest): string {
  const x = request.headers['x-modeldb-connect-token'];
  if (typeof x === 'string' && x.trim()) {
    return x.trim();
  }
  const auth = request.headers['authorization'];
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  return '';
}

type SocketState =
  | { readonly phase: 'guest' }
  | { readonly phase: 'ready'; readonly sessionKey: string; readonly atlas: string };

type CatalogModelDefinition = {
  readonly name: string;
  readonly parentId: string | null;
  readonly fields: ReadonlySet<string>;
  readonly fieldTypes: ReadonlyMap<string, { readonly type: string }>;
};

interface RowDataLike {
  getData?: (deep?: boolean) => Record<string, unknown>;
}

function hydrateRow(row: unknown): Record<string, unknown> {
  if (row && typeof row === 'object' && typeof (row as RowDataLike).getData === 'function') {
    return (row as Required<RowDataLike>).getData(true);
  }
  if (row && typeof row === 'object') {
    return row as Record<string, unknown>;
  }
  return {};
}

function parseI18nDisplay(
  value: unknown,
  fallbackUniqueName?: string,
): Readonly<Record<string, string>> | undefined {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    if (trimmed.startsWith('{')) {
      try {
        parsed = JSON.parse(trimmed) as unknown;
      } catch {
        return { en: trimmed, zh: trimmed, ja: trimmed };
      }
    } else {
      return { en: trimmed, zh: trimmed, ja: trimmed };
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  const fallback = fallbackUniqueName?.trim();
  for (const [key, raw] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof raw !== 'string') {
      continue;
    }
    const label = raw.trim();
    if (label.length > 0 && (!fallback || label !== fallback)) {
      out[key] = label;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function relatedRows(row: Record<string, unknown>, relation: string): Record<string, unknown>[] {
  const relates = row.relates as Record<string, unknown> | undefined;
  const slot = relates?.[relation];
  return Array.isArray(slot) ? slot.map((item) => hydrateRow(item)) : [];
}

function setFieldLabel(
  labelsByModel: Map<string, Record<string, Readonly<Record<string, string>>>>,
  modelName: string,
  fieldName: string,
  label: Readonly<Record<string, string>>,
): void {
  const bucket = labelsByModel.get(modelName) ?? {};
  bucket[fieldName] = label;
  labelsByModel.set(modelName, bucket);
}

function countFieldLabels(
  labelsByModel: ReadonlyMap<string, Readonly<Record<string, Readonly<Record<string, string>>>>>,
): number {
  let total = 0;
  for (const labels of labelsByModel.values()) {
    total += Object.keys(labels).length;
  }
  return total;
}

function mergeCatalogFieldLabels(
  fields: readonly string[],
  exactLabels: Readonly<Record<string, Readonly<Record<string, string>>>> | undefined,
  fallbackLabels: ReadonlyMap<string, Readonly<Record<string, string>>>,
): Readonly<Record<string, Readonly<Record<string, string>>>> {
  const out: Record<string, Readonly<Record<string, string>>> = { ...(exactLabels ?? {}) };
  for (const field of fields) {
    const fallback = fallbackLabels.get(field);
    if (!fallback) {
      continue;
    }
    out[field] = { ...fallback, ...(out[field] ?? {}) };
  }
  return out;
}

type CatalogDisplayMetadata = {
  readonly databaseDisplayName?: Readonly<Record<string, string>>;
  readonly modelDisplayNames: ReadonlyMap<string, Readonly<Record<string, string>>>;
  readonly modelFieldLabels: ReadonlyMap<
    string,
    Readonly<Record<string, Readonly<Record<string, string>>>>
  >;
  readonly fieldLabelsByName: ReadonlyMap<string, Readonly<Record<string, string>>>;
};

function hasCatalogDisplayMetadata(metadata: CatalogDisplayMetadata): boolean {
  return (
    Boolean(metadata.databaseDisplayName) ||
    metadata.modelDisplayNames.size > 0 ||
    countFieldLabels(metadata.modelFieldLabels) > 0 ||
    metadata.fieldLabelsByName.size > 0
  );
}

function catalogDisplayMetadataScore(metadata: CatalogDisplayMetadata): number {
  return (
    countFieldLabels(metadata.modelFieldLabels) * 1000 +
    metadata.fieldLabelsByName.size * 100 +
    metadata.modelDisplayNames.size * 10 +
    (metadata.databaseDisplayName ? 1 : 0)
  );
}

async function readCatalogDisplayMetadata(
  engine: AuthoringEngine,
  database: string,
  metadataSource = database,
): Promise<CatalogDisplayMetadata> {
  const modelDisplayNames = new Map<string, Readonly<Record<string, string>>>();
  const modelFieldLabels = new Map<string, Record<string, Readonly<Record<string, string>>>>();
  const fieldLabelsByName = new Map<string, Readonly<Record<string, string>>>();
  let databaseDisplayName: Readonly<Record<string, string>> | undefined;

  let modelRowsScanned = 0;
  let propRowsScanned = 0;
  let directFieldLabels = 0;
  let forwardFieldLabels = 0;
  let reverseFieldLabels = 0;

  try {
    if (engine.registry.getModel('sys_data_asset_map')) {
      const rows = await engine.persistence.getMergedReader().getAll('sys_data_asset_map');
      for (const row of rows) {
        const data = hydrateRow(row);
        if (data.code === database) {
          databaseDisplayName = parseI18nDisplay(data.name, database);
          break;
        }
      }
    }
  } catch (e) {
    EngineLogger.instance.warn(
      'Catalog display metadata: failed to read sys_data_asset_map',
      { database, metadataSource, message: e instanceof Error ? e.message : String(e) },
      'ManagementCatalog',
    );
  }

  try {
    if (engine.registry.getModel('sys_model')) {
      const rows = await engine.model('sys_model').query().group('modelOwnsProps').execute({
        includeRelates: true,
      });
      for (const row of Array.isArray(rows) ? rows : []) {
        const data = hydrateRow(row);
        if (data.library_code !== database || typeof data.engine_name !== 'string') {
          continue;
        }
        modelRowsScanned += 1;
        const displayName = parseI18nDisplay(data.name, data.engine_name);
        if (displayName) {
          modelDisplayNames.set(data.engine_name, displayName);
        }
        for (const propData of relatedRows(data, 'modelOwnsProps')) {
          if (propData.library_code !== database || typeof propData.engine_name !== 'string') {
            continue;
          }
          const label = parseI18nDisplay(propData.name, propData.engine_name);
          if (label) {
            setFieldLabel(modelFieldLabels, data.engine_name, propData.engine_name, label);
            forwardFieldLabels += 1;
          }
        }
      }
    }
  } catch (e) {
    EngineLogger.instance.warn(
      'Catalog display metadata: failed to read sys_model/modelOwnsProps',
      { database, metadataSource, message: e instanceof Error ? e.message : String(e) },
      'ManagementCatalog',
    );
  }

  try {
    if (engine.registry.getModel('sys_props')) {
      const propRows = await engine.persistence.getMergedReader().getAll('sys_props');
      for (const row of propRows) {
        const data = hydrateRow(row);
        if (data.library_code !== database || typeof data.engine_name !== 'string') {
          continue;
        }
        const label = parseI18nDisplay(data.name, data.engine_name);
        if (label) {
          fieldLabelsByName.set(data.engine_name, label);
          if (typeof data.model_engine_name === 'string' && data.model_engine_name.trim()) {
            setFieldLabel(modelFieldLabels, data.model_engine_name, data.engine_name, label);
            directFieldLabels += 1;
          }
        }
      }

      const rows = await engine.model('sys_props').query().group('propOwnedByModel').execute({
        includeRelates: true,
      });
      for (const row of Array.isArray(rows) ? rows : []) {
        const data = hydrateRow(row);
        if (data.library_code !== database || typeof data.engine_name !== 'string') {
          continue;
        }
        propRowsScanned += 1;
        const label = parseI18nDisplay(data.name, data.engine_name);
        if (!label) {
          continue;
        }
        for (const modelData of relatedRows(data, 'propOwnedByModel')) {
          if (modelData.library_code !== database || typeof modelData.engine_name !== 'string') {
            continue;
          }
          setFieldLabel(modelFieldLabels, modelData.engine_name, data.engine_name, label);
          reverseFieldLabels += 1;
        }
      }
    }
  } catch (e) {
    EngineLogger.instance.warn(
      'Catalog display metadata: failed to read sys_props/propOwnedByModel',
      { database, metadataSource, message: e instanceof Error ? e.message : String(e) },
      'ManagementCatalog',
    );
  }

  const fieldLabelCount = countFieldLabels(modelFieldLabels);
  EngineLogger.instance.info(
    'Catalog display metadata loaded',
    {
      database,
      metadataSource,
      hasDatabaseDisplayName: Boolean(databaseDisplayName),
      modelRowsScanned,
      modelDisplayNames: modelDisplayNames.size,
      propRowsScanned,
      fieldLabelModels: modelFieldLabels.size,
      fieldLabels: fieldLabelCount,
      fallbackFieldLabels: fieldLabelsByName.size,
      directFieldLabels,
      forwardFieldLabels,
      reverseFieldLabels,
    },
    'ManagementCatalog',
  );
  // eslint-disable-next-line no-console
  console.info(
    `[modeldb-server][catalog] ${database}: metadataSource=${metadataSource} displayName=${Boolean(databaseDisplayName)} modelLabels=${modelDisplayNames.size} fieldLabels=${fieldLabelCount} directFieldLabels=${directFieldLabels} fallbackFieldLabels=${fieldLabelsByName.size} props=${propRowsScanned}`,
  );

  return { databaseDisplayName, modelDisplayNames, modelFieldLabels, fieldLabelsByName };
}

async function readCatalogDisplayMetadataForDatabase(
  authoring: AuthoringBridge,
  dataRoot: string,
  database: string,
  businessEngine: AuthoringEngine,
  designerWorkspace: string,
): Promise<Awaited<ReturnType<typeof readCatalogDisplayMetadata>>> {
  const candidateNames = new Set<string>();
  const configuredDesignerDb = designerWorkspace.trim();
  if (configuredDesignerDb && configuredDesignerDb !== database) {
    candidateNames.add(configuredDesignerDb);
  }
  if ('model_designer_workspace' !== database) {
    candidateNames.add('model_designer_workspace');
  }
  for (const info of scanWorkspaceDatabases(dataRoot)) {
    if (info.name !== database && !candidateNames.has(info.name)) {
      candidateNames.add(info.name);
    }
  }

  let best:
    | {
        readonly source: string;
        readonly metadata: Awaited<ReturnType<typeof readCatalogDisplayMetadata>>;
        readonly score: number;
      }
    | undefined;

  for (const designerDb of candidateNames) {
    try {
      assertLogicalDatabaseExists(dataRoot, designerDb);
      const designerEngine = await authoring.getEngine(designerDb);
      const metadata = await readCatalogDisplayMetadata(designerEngine, database, designerDb);
      if (hasCatalogDisplayMetadata(metadata)) {
        const score = catalogDisplayMetadataScore(metadata);
        if (!best || score > best.score) {
          best = { source: designerDb, metadata, score };
        }
        continue;
      }
      EngineLogger.instance.info(
        'Designer metadata workspace had no labels for database; trying next candidate',
        { database, designerWorkspace: designerDb },
        'ManagementCatalog',
      );
    } catch (e) {
      EngineLogger.instance.warn(
        'Designer metadata workspace unavailable; falling back to business catalog metadata',
        {
          database,
          designerWorkspace: designerDb,
          message: e instanceof Error ? e.message : String(e),
        },
        'ManagementCatalog',
      );
    }
  }

  const businessMetadata = await readCatalogDisplayMetadata(businessEngine, database, database);
  if (hasCatalogDisplayMetadata(businessMetadata)) {
    const score = catalogDisplayMetadataScore(businessMetadata);
    if (!best || score > best.score) {
      best = { source: database, metadata: businessMetadata, score };
    }
  }
  if (best) {
    EngineLogger.instance.info(
      'Catalog display metadata source selected',
      { database, metadataSource: best.source, score: best.score },
      'ManagementCatalog',
    );
    return best.metadata;
  }

  return businessMetadata;
}

async function enrichWorkspaceDatabases(
  databases: readonly ManagementDatabaseInfo[],
  authoring: AuthoringBridge,
  dataRoot: string,
  designerWorkspace: string,
): Promise<readonly ManagementDatabaseInfo[]> {
  return Promise.all(
    databases.map(async (database) => {
      try {
        const engine = await authoring.getEngine(database.name);
        const metadata = await readCatalogDisplayMetadataForDatabase(
          authoring,
          dataRoot,
          database.name,
          engine,
          designerWorkspace,
        );
        return metadata.databaseDisplayName
          ? { ...database, displayName: metadata.databaseDisplayName }
          : database;
      } catch {
        return database;
      }
    }),
  );
}

function effectiveCatalogFields(
  defsByName: ReadonlyMap<string, CatalogModelDefinition>,
  modelName: string,
  seen = new Set<string>(),
): readonly string[] {
  const def = defsByName.get(modelName);
  if (!def || seen.has(modelName)) {
    return [];
  }
  seen.add(modelName);

  const inherited = def.parentId ? effectiveCatalogFields(defsByName, def.parentId, seen) : [];
  return [...new Set([...inherited, ...def.fields])];
}

function effectiveCatalogFieldTypes(
  defsByName: ReadonlyMap<string, CatalogModelDefinition>,
  modelName: string,
  seen = new Set<string>(),
): Readonly<Record<string, string>> {
  const def = defsByName.get(modelName);
  if (!def || seen.has(modelName)) {
    return {};
  }
  seen.add(modelName);

  return {
    ...(def.parentId ? effectiveCatalogFieldTypes(defsByName, def.parentId, seen) : {}),
    ...Object.fromEntries(
      [...def.fieldTypes.entries()].map(([field, typeDef]) => [field, typeDef.type]),
    ),
  };
}

function sendJsonWs(ws: WebSocket, msg: WireServerMessage): void {
  ws.send(JSON.stringify(msg));
}

const wsTextEncoder = new TextEncoder();

function parseWsText(interceptor: BinaryInterceptor, data: RawData): string {
  if (typeof data === 'string') {
    return interceptor.unwrapTransportPayload(wsTextEncoder.encode(data));
  }
  if (Buffer.isBuffer(data)) {
    return interceptor.unwrapTransportPayload(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    );
  }
  return interceptor.unwrapTransportPayload(new Uint8Array(data as ArrayBufferLike));
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
  const releaseWs = recordWebSocketConnection();
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
    releaseWs();
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
    const text = interceptor.unwrapTransportPayload(
      new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
    );
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
  mkdirSync(join(dataRoot, 'vault'), { recursive: true });
  mkdirSync(join(dataRoot, 'logs'), { recursive: true });
  mkdirSync(join(dataRoot, 'cache'), { recursive: true });
  EngineLogger.instance.info('Workspace directory ready', { workspace: dataRoot }, 'ModelDBServer');
  EngineLogger.instance.info(
    'ModelDB Server starting (dual-track)',
    {
      host: cfg.host,
      port: cfg.port,
      dev: cfg.dev,
      storageRootSha256: rootPrint,
      designerWorkspace: cfg.designerWorkspace,
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
  const autoBackup = startAutoBackupScheduler(dataRoot, cfg.autoBackup, authoring);
  const writeGate = new WriteSerializationGate();
  const dispatcher = new WireRequestDispatcher({
    dev: cfg.dev,
    getEngine: (atlas) => authoring.getEngine(atlas),
    writeGate,
  });

  const app = Fastify({ logger: false, bodyLimit: 128 * 1024 * 1024 });
  if (autoBackup) {
    app.addHook('onClose', (_instance, done) => {
      autoBackup.stop();
      done();
    });
  }

  await app.register(cors, {
    origin: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-ModelDB-Connect-Token',
      'X-ModelDB-Db-Name',
      'X-ModelDB-Atlas',
    ],
  });

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

  app.get('/api/v1/management/databases', async (request: FastifyRequest, reply: FastifyReply) => {
    const interceptor = new BinaryInterceptor(cfg.connectToken);
    try {
      const token = readConnectTokenFromHttpRequest(request);
      interceptor.validateConnectToken(token);
      const databases = await enrichWorkspaceDatabases(
        scanWorkspaceDatabases(dataRoot),
        authoring,
        dataRoot,
        cfg.designerWorkspace,
      );
      const body: ManagementDatabasesResponse = { databases };
      return reply.send(body);
    } catch (e) {
      if (e instanceof TransportAuthError) {
        return reply.code(401).send({ error: e.message });
      }
      const message = e instanceof Error ? e.message : String(e);
      return reply.code(500).send({ error: message });
    }
  });

  app.get('/api/v1/management/status', async (request: FastifyRequest, reply: FastifyReply) => {
    const interceptor = new BinaryInterceptor(cfg.connectToken);
    try {
      const token = readConnectTokenFromHttpRequest(request);
      interceptor.validateConnectToken(token);
      const databases = await enrichWorkspaceDatabases(
        scanWorkspaceDatabases(dataRoot),
        authoring,
        dataRoot,
        cfg.designerWorkspace,
      );
      const port = getServerListeningPort(app);
      const body: ManagementStatusResponse = {
        engine: 'ModelDB',
        state: 'RUNNING',
        uptimeSeconds: getProcessUptimeSeconds(),
        listen: { host: cfg.host, port },
        storageFormat: 'atlas.mld',
        storageVersion: '2.0',
        workspaceRoot: dataRoot,
        databases,
        connectedClients: getConnectedWebSocketClients(),
      };
      return reply.send(body);
    } catch (e) {
      if (e instanceof TransportAuthError) {
        return reply.code(401).send({ error: e.message });
      }
      const message = e instanceof Error ? e.message : String(e);
      return reply.code(500).send({ error: message });
    }
  });

  app.get(
    '/api/v1/management/databases/:dbName/catalog',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const interceptor = new BinaryInterceptor(cfg.connectToken);
      try {
        const token = readConnectTokenFromHttpRequest(request);
        interceptor.validateConnectToken(token);
        const params = request.params as { dbName?: string };
        const dbName = decodeURIComponent(String(params.dbName ?? '').trim());
        if (!dbName) {
          return reply.code(400).send({ error: 'Missing database name.' });
        }
        assertLogicalDatabaseExists(dataRoot, dbName);
        const engine = await authoring.getEngine(dbName);
        const defs = engine.registry.getModelDefinitions();
        const defsByName = new Map(defs.map((d) => [d.name, d] as const));
        const displayMetadata = await readCatalogDisplayMetadataForDatabase(
          authoring,
          dataRoot,
          dbName,
          engine,
          cfg.designerWorkspace,
        );
        const rels = engine.registry.getRelations();
        const body: ManagementCatalogResponse = {
          database: dbName,
          displayName: displayMetadata.databaseDisplayName,
          models: defs.map((d) => {
            const fields = effectiveCatalogFields(defsByName, d.name);
            return {
              name: d.name,
              parentId: d.parentId,
              displayName: displayMetadata.modelDisplayNames.get(d.name),
              fields,
              fieldLabels: mergeCatalogFieldLabels(
                fields,
                displayMetadata.modelFieldLabels.get(d.name),
                displayMetadata.fieldLabelsByName,
              ),
              fieldTypes: effectiveCatalogFieldTypes(defsByName, d.name),
            };
          }),
          relations: rels.map((r) => ({
            forward: r.forward,
            reverse: r.reverse,
            source: r.source,
            selfLoopPolicy: r.selfLoopPolicy ?? 'deny',
            target: r.target,
          })),
        };
        return reply.send(body);
      } catch (e) {
        if (e instanceof TransportAuthError) {
          return reply.code(401).send({ error: e.message });
        }
        const message = e instanceof Error ? e.message : String(e);
        return reply.code(500).send({ error: message });
      }
    },
  );

  app.get('/api/v1/management/backups', async (request: FastifyRequest, reply: FastifyReply) => {
    const interceptor = new BinaryInterceptor(cfg.connectToken);
    try {
      const token = readConnectTokenFromHttpRequest(request);
      interceptor.validateConnectToken(token);
      const query = request.query as { database?: string };
      const database = typeof query.database === 'string' ? query.database.trim() : '';
      if (database) {
        assertFlatGraphSegment(database, 'database name');
      }
      const body: ManagementBackupsResponse = {
        backups: listDatabaseBackups(dataRoot, database || undefined),
      };
      return reply.send(body);
    } catch (e) {
      if (e instanceof TransportAuthError) {
        return reply.code(401).send({ error: e.message });
      }
      const message = e instanceof Error ? e.message : String(e);
      return reply.code(500).send({ error: message });
    }
  });

  app.post(
    '/api/v1/management/databases/:dbName/backup',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const interceptor = new BinaryInterceptor(cfg.connectToken);
      try {
        const token = readConnectTokenFromHttpRequest(request);
        interceptor.validateConnectToken(token);
        const params = request.params as { dbName?: string };
        const dbName = decodeURIComponent(String(params.dbName ?? '').trim());
        assertFlatGraphSegment(dbName, 'database name');
        assertLogicalDatabaseExists(dataRoot, dbName);
        try {
          const engine = await authoring.getEngine(dbName);
          await engine.flushAll();
        } catch (e) {
          EngineLogger.instance.warn(
            'Backup proceeding without engine flush',
            { database: dbName, message: e instanceof Error ? e.message : String(e) },
            'ManagementBackup',
          );
        }
        const raw = request.body as { reason?: string } | undefined;
        const reason = String(raw?.reason ?? 'manual').replace(/[^A-Za-z0-9_-]/g, '_');
        const backup = createDatabaseBackup(dataRoot, dbName, reason || 'manual');
        const body: ManagementBackupCreateResponse = { ok: true, backup };
        return reply.send(body);
      } catch (e) {
        if (e instanceof TransportAuthError) {
          return reply.code(401).send({ error: e.message });
        }
        const message = e instanceof Error ? e.message : String(e);
        return reply.code(500).send({ error: message });
      }
    },
  );

  app.post(
    '/api/v1/management/databases/:dbName/restore',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const interceptor = new BinaryInterceptor(cfg.connectToken);
      try {
        const token = readConnectTokenFromHttpRequest(request);
        interceptor.validateConnectToken(token);
        const params = request.params as { dbName?: string };
        const dbName = decodeURIComponent(String(params.dbName ?? '').trim());
        assertFlatGraphSegment(dbName, 'database name');
        const raw = request.body as { backupFile?: string };
        const backupFile = String(raw?.backupFile ?? '').trim();
        if (!backupFile) {
          return reply.code(400).send({ error: 'Missing backupFile.' });
        }
        let safetyBackup: ReturnType<typeof createDatabaseBackup> | undefined;
        try {
          safetyBackup = createDatabaseBackup(dataRoot, dbName, 'pre-restore');
        } catch {
          safetyBackup = undefined;
        }
        authoring.evict(dbName);
        atlasClients.delete(dbName);
        const restored = restoreDatabaseBackup(dataRoot, dbName, backupFile);
        authoring.evict(dbName);
        atlasClients.delete(dbName);
        await authoring.getEngine(dbName);
        const body: ManagementBackupRestoreResponse = {
          ok: true,
          restored,
          ...(safetyBackup ? { safetyBackup } : {}),
        };
        return reply.send(body);
      } catch (e) {
        if (e instanceof TransportAuthError) {
          return reply.code(401).send({ error: e.message });
        }
        const message = e instanceof Error ? e.message : String(e);
        return reply.code(500).send({ error: message });
      }
    },
  );

  app.post(
    '/api/v1/management/databases/:dbName/clear',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const interceptor = new BinaryInterceptor(cfg.connectToken);
      try {
        const token = readConnectTokenFromHttpRequest(request);
        interceptor.validateConnectToken(token);
        const params = request.params as { dbName?: string };
        const dbName = decodeURIComponent(String(params.dbName ?? '').trim());
        assertFlatGraphSegment(dbName, 'database name');
        const raw = request.body as { forceReset?: boolean } | undefined;
        const forceReset = raw?.forceReset === true;
        if (!forceReset) {
          assertLogicalDatabaseExists(dataRoot, dbName);
        }
        let safetyBackup: ReturnType<typeof createDatabaseBackup> | undefined;
        try {
          safetyBackup = createDatabaseBackup(
            dataRoot,
            dbName,
            forceReset ? 'pre-reset' : 'pre-clear',
          );
        } catch {
          safetyBackup = undefined;
        }
        if (forceReset) {
          authoring.evict(dbName);
          atlasClients.delete(dbName);
          forceResetDatabase(dataRoot, dbName);
          await authoring.getEngine(dbName);
          const body: ManagementClearDatabaseResponse = {
            ok: true,
            database: dbName,
            mode: 'forceReset',
            ...(safetyBackup ? { safetyBackup } : {}),
          };
          return reply.send(body);
        }
        const engine = await authoring.getEngine(dbName);
        const result = await engine.clearAllData({ sync: true });
        atlasClients.delete(dbName);
        const body: ManagementClearDatabaseResponse = {
          ok: true,
          database: dbName,
          mode: 'clearAllData',
          deletedCount: result.totalDeleted,
          perModel: result.perModel,
          ...(safetyBackup ? { safetyBackup } : {}),
        };
        return reply.send(body);
      } catch (e) {
        if (e instanceof TransportAuthError) {
          return reply.code(401).send({ error: e.message });
        }
        const message = e instanceof Error ? e.message : String(e);
        return reply.code(500).send({ error: message });
      }
    },
  );

  app.post('/api/v1/management/databases', async (request: FastifyRequest, reply: FastifyReply) => {
    const interceptor = new BinaryInterceptor(cfg.connectToken);
    try {
      const token = readConnectTokenFromHttpRequest(request);
      interceptor.validateConnectToken(token);
      const raw = request.body as { name?: string };
      const name = String(raw?.name ?? '').trim();
      assertFlatGraphSegment(name, 'database name');
      const nestedVault = join(dataRoot, name, 'atlas.mld');
      const flatVault = join(dataRoot, `${name}.mld`);
      if (existsSync(nestedVault) || existsSync(flatVault)) {
        return reply.code(409).send({ error: `Database "${name}" already exists.` });
      }
      mkdirSync(join(dataRoot, name), { recursive: true });
      await authoring.getEngine(name);
      return reply.code(201).send({ ok: true as const, name });
    } catch (e) {
      if (e instanceof TransportAuthError) {
        return reply.code(401).send({ error: e.message });
      }
      const message = e instanceof Error ? e.message : String(e);
      return reply.code(400).send({ error: message });
    }
  });

  app.delete(
    '/api/v1/management/databases/:dbName',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const interceptor = new BinaryInterceptor(cfg.connectToken);
      try {
        const token = readConnectTokenFromHttpRequest(request);
        interceptor.validateConnectToken(token);
        const delParams = request.params as { dbName?: string };
        const dbName = decodeURIComponent(String(delParams.dbName ?? '').trim());
        assertFlatGraphSegment(dbName, 'database name');
        const nestedDir = join(dataRoot, dbName);
        const flatVault = join(dataRoot, `${dbName}.mld`);
        let removed = false;
        if (existsSync(nestedDir)) {
          rmSync(nestedDir, { recursive: true, force: true });
          removed = true;
        } else if (existsSync(flatVault)) {
          rmSync(flatVault);
          removed = true;
        }
        if (!removed) {
          return reply.code(404).send({ error: `Database "${dbName}" not found.` });
        }
        authoring.evict(dbName);
        atlasClients.delete(dbName);
        return reply.send({ ok: true as const, name: dbName });
      } catch (e) {
        if (e instanceof TransportAuthError) {
          return reply.code(401).send({ error: e.message });
        }
        const message = e instanceof Error ? e.message : String(e);
        return reply.code(500).send({ error: message });
      }
    },
  );

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

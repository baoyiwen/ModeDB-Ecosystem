import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { configureModelDBStorageRoot } from '../common/storage-root-config.js';
import {
  deriveWireSessionKey,
  decodeWirePayload,
  encodeWirePayload,
} from '../common/wire-codec.js';
import { ModelDBClient } from '../src/runtime/ModelDBClient.js';
import {
  QueryChain,
  queryPlanHasSerializedCallback,
  type RemoteExecuteSnapshot,
} from '../src/runtime/query.js';
import type { QueryExecuteOptions } from '../src/runtime/HydratedEntity.js';
import { serializeExecuteResultForWire } from '../src/network/execute-result-wire.js';
import type {
  WireClientMessage,
  WireExecuteBody,
  WireHandshakeRequest,
  WireRpcEnvelope,
  WireServerMessage,
} from '../src/network/wire-protocol.js';
import type { ResolvedModelDBServerConfig } from './modeldb-config.js';

type SocketState =
  | { readonly phase: 'guest' }
  | { readonly phase: 'ready'; readonly sessionKey: string; readonly atlas: string };

function sendJson(ws: WebSocket, msg: WireServerMessage): void {
  ws.send(JSON.stringify(msg));
}

function assertHandshake(msg: WireClientMessage): asserts msg is WireHandshakeRequest {
  if (msg.type !== 'handshake') {
    throw new Error('Expected handshake first.');
  }
}

/** 在 **`listening`** 之后读取实际端口（**`port: 0`** 时由系统分配）。 */
export function getWebSocketServerListeningPort(wss: WebSocketServer): number {
  const addr = wss.address();
  if (typeof addr === 'object' && addr !== null) {
    return addr.port;
  }
  throw new Error('WebSocketServer is not listening or address is not a TCP endpoint.');
}

export async function startModelDBWebSocketServer(
  cfg: ResolvedModelDBServerConfig,
): Promise<WebSocketServer> {
  configureModelDBStorageRoot({ storageRoot: cfg.storageRoot });
  if (cfg.vaultSecret) {
    process.env.MODEL_DB_VAULT_SECRET = cfg.vaultSecret;
  }

  const atlasClients = new Map<string, Promise<ModelDBClient>>();

  function getClient(atlas: string): Promise<ModelDBClient> {
    const hit = atlasClients.get(atlas);
    if (hit) {
      return hit;
    }
    const p = ModelDBClient.connect(atlas);
    atlasClients.set(atlas, p);
    return p;
  }

  const wss = new WebSocketServer({ port: cfg.port });
  await new Promise<void>((resolve, reject) => {
    wss.once('listening', () => resolve());
    wss.once('error', reject);
  });

  // eslint-disable-next-line no-console
  console.log(
    `ModelDB WebSocket server listening on ws://127.0.0.1:${getWebSocketServerListeningPort(wss)}`,
  );

  wss.on('connection', (ws: WebSocket) => {
    let state: SocketState = { phase: 'guest' };

    ws.on('message', async (data: RawData) => {
      let parsed: WireClientMessage | undefined;
      try {
        parsed = JSON.parse(String(data)) as WireClientMessage;
      } catch {
        sendJson(ws, { type: 'error', message: 'Invalid JSON message.' });
        ws.close();
        return;
      }

      try {
        if (state.phase === 'guest') {
          assertHandshake(parsed);
          if (parsed.connectToken !== cfg.connectToken) {
            sendJson(ws, { type: 'error', message: 'Unauthorized: invalid connect token.' });
            ws.close();
            return;
          }
          const atlas = parsed.atlas;
          await getClient(atlas);
          const sessionKey = deriveWireSessionKey(parsed.connectToken, atlas);
          state = { phase: 'ready', sessionKey, atlas };
          sendJson(ws, { type: 'handshake.ok', atlas });
          return;
        }

        if (parsed.type === 'handshake') {
          sendJson(ws, { type: 'error', message: 'Already handshaken.' });
          return;
        }

        if (parsed.type !== 'rpc') {
          sendJson(ws, { type: 'error', message: 'Unknown message type.' });
          return;
        }

        const env = parsed as WireRpcEnvelope;
        const plain = decodeWirePayload(env.cipher, state.sessionKey);
        const body = JSON.parse(plain) as WireExecuteBody;
        if (body.op !== 'executeQuery') {
          throw new Error(`Unknown RPC op: ${String((body as { op?: unknown }).op)}`);
        }
        await handleExecuteQuery(ws, state, body.snapshot, env.id, getClient);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const id =
          parsed && typeof parsed === 'object' && 'type' in parsed && parsed.type === 'rpc'
            ? (parsed as WireRpcEnvelope).id
            : '';
        if (id) {
          sendJson(ws, { type: 'rpc.err', id, error: message });
        } else {
          sendJson(ws, { type: 'error', message });
        }
      }
    });
  });

  return wss;
}

async function handleExecuteQuery(
  ws: WebSocket,
  state: Extract<SocketState, { phase: 'ready' }>,
  snapshot: RemoteExecuteSnapshot,
  id: string,
  getClient: (atlas: string) => Promise<ModelDBClient>,
): Promise<void> {
  if (queryPlanHasSerializedCallback(snapshot.plan)) {
    throw new Error('Plan contains filter callbacks.');
  }
  const client = await getClient(state.atlas);
  const ctx = client.getRuntimeContext();
  const chain = QueryChain.fromWirePlan(
    ctx.registry,
    ctx.indexReader,
    ctx.dataReader,
    snapshot.plan,
  );
  QueryChain.applyRemoteAnalysisSnapshot(chain, snapshot.analysis, snapshot.execute);
  const execOpts: QueryExecuteOptions = {
    ...(snapshot.execute.limit !== undefined ? { limit: snapshot.execute.limit } : {}),
    ...(snapshot.execute.page !== undefined ? { page: snapshot.execute.page } : {}),
    ...(snapshot.execute.includeRelates !== undefined
      ? { includeRelates: snapshot.execute.includeRelates }
      : {}),
    ...(snapshot.execute.wrapGroups !== undefined
      ? { wrapGroups: snapshot.execute.wrapGroups }
      : {}),
  };
  const raw = await chain.execute(execOpts);
  const wireJson = serializeExecuteResultForWire(raw);
  const cipher = encodeWirePayload(JSON.stringify(wireJson), state.sessionKey);
  const msg: WireServerMessage = { type: 'rpc.ok', id, cipher };
  sendJson(ws, msg);
}

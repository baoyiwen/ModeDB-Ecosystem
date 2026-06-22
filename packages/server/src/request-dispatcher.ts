import type { WebSocket } from 'ws';
import {
  decodeWirePayload,
  encodeWirePayload,
  isMutatingDatabaseOperation,
  type WireExecuteBody,
  type WireExecuteResultJson,
  type WireServerMessage,
} from '@mode-db/shared';
import {
  executeDatabaseOperation,
  EngineLogger,
  type AuthoringEngine,
  type ModelDBClient,
} from '@mode-db/core';
import type { WriteSerializationGate } from './write-serialization-gate.js';

function sendJson(ws: WebSocket, msg: WireServerMessage): void {
  ws.send(JSON.stringify(msg));
}

export type RpcCipherReply =
  | { readonly type: 'rpc.ok'; readonly id: string; readonly cipher: string }
  | { readonly type: 'rpc.err'; readonly id: string; readonly error: string };

/**
 * Dual-protocol dispatcher: every RPC body is a database-scope engine operation executed by the
 * shared {@link executeDatabaseOperation}. This layer owns only transport concerns:
 * - **read** ops (`executeQuery` via {@link ModelDBClient}; `previewBind` / `relationStats`) run directly,
 * - **write** ops are serialized through {@link WriteSerializationGate} and flushed by the executor,
 * - the JSON result is encoded with the session cipher.
 */
export class WireRequestDispatcher {
  constructor(
    private readonly opts: {
      readonly dev: boolean;
      readonly getClient: (atlas: string) => Promise<ModelDBClient>;
      readonly getEngine: (atlas: string) => Promise<AuthoringEngine>;
      readonly writeGate: WriteSerializationGate;
    },
  ) {}

  async dispatchRpc(
    ws: WebSocket,
    sessionKey: string,
    atlas: string,
    body: WireExecuteBody,
    id: string,
  ): Promise<void> {
    const out = await this.runRpcCipherReply(atlas, sessionKey, body, id);
    if (out.type === 'rpc.ok') {
      sendJson(ws, { type: 'rpc.ok', id: out.id, cipher: out.cipher });
    } else {
      sendJson(ws, { type: 'rpc.err', id: out.id, error: out.error });
    }
  }

  async runRpcCipherReply(
    atlas: string,
    sessionKey: string,
    body: WireExecuteBody,
    id: string,
  ): Promise<RpcCipherReply> {
    const t0 = performance.now();
    try {
      const result = await this.executeBody(atlas, body);
      const cipher = encodeWirePayload(JSON.stringify(result), sessionKey);
      return { type: 'rpc.ok', id, cipher };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { type: 'rpc.err', id, error: message };
    } finally {
      EngineLogger.instance.recordHandledRequest(performance.now() - t0);
    }
  }

  /** Map one wire op to a JSON result via the shared executor; owns gating + the read/write runtime choice. */
  private async executeBody(atlas: string, body: WireExecuteBody): Promise<WireExecuteResultJson> {
    if (body.op === 'executeQuery') {
      if (this.opts.dev) {
        console.error(
          '[modeldb-server][dev] executeQuery snapshot',
          JSON.stringify(body.snapshot).slice(0, 2000),
        );
      }
      const client = await this.opts.getClient(atlas);
      const result = await executeDatabaseOperation(
        { runtime: client.getRuntimeContext(), atlas, dev: this.opts.dev },
        body,
      );
      if (this.opts.dev) {
        console.error(
          '[modeldb-server][dev] executeQuery result',
          JSON.stringify(result).slice(0, 2000),
        );
      }
      return result;
    }

    if (isMutatingDatabaseOperation(body)) {
      return this.opts.writeGate.runExclusive(atlas, async () => {
        const engine = await this.opts.getEngine(atlas);
        return executeDatabaseOperation({ engine, atlas, flush: () => engine.flushAll() }, body);
      });
    }

    // Read-only engine ops: previewBind / relationStats.
    const engine = await this.opts.getEngine(atlas);
    return executeDatabaseOperation({ engine, atlas }, body);
  }
}

export function decodeExecuteBody(cipher: string, sessionKey: string): WireExecuteBody {
  const plain = decodeWirePayload(cipher, sessionKey);
  return JSON.parse(plain) as WireExecuteBody;
}

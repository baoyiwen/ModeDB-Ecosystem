import type { WebSocket } from 'ws';
import {
  decodeWirePayload,
  encodeWirePayload,
  queryPlanHasSerializedCallback,
  type RemoteExecuteSnapshot,
  type WireExecuteResultJson,
  type QueryExecuteOptions,
  type WireExecuteBody,
  type WireServerMessage,
} from '@mode-db/shared';
import {
  QueryChain,
  serializeExecuteResultForWire,
  EngineLogger,
  type AuthoringEngine,
  type ModelDBClient,
} from '@mode-db/core';
import type { WriteSerializationGate } from './write-serialization-gate.js';
import type { FieldDefsRecord } from '@mode-db/common';

const MAX_INSERT_MANY_ROWS = 20_000;
const MAX_BATCH_UPDATE_OPS = 20_000;

function sendJson(ws: WebSocket, msg: WireServerMessage): void {
  ws.send(JSON.stringify(msg));
}

export type RpcCipherReply =
  | { readonly type: 'rpc.ok'; readonly id: string; readonly cipher: string }
  | { readonly type: 'rpc.err'; readonly id: string; readonly error: string };

/**
 * Dual-protocol dispatcher: **read** path via {@link ModelDBClient} / {@link QueryChain};
 * **write** path via {@link AuthoringEngine} serialized with {@link WriteSerializationGate}.
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
      if (body.op === 'executeQuery') {
        const cipher = await this.executeQueryCipherOnly(
          atlas,
          sessionKey,
          body.snapshot as RemoteExecuteSnapshot,
        );
        return { type: 'rpc.ok', id, cipher };
      }
      if (body.op === 'insert') {
        const cipher = await this.opts.writeGate.runExclusive(atlas, async () => {
          const engine = await this.opts.getEngine(atlas);
          const rec = await engine.insert(body.model, body.data, { sync: body.sync ?? true });
          await engine.flushAll();
          const wireJson: WireExecuteResultJson = {
            kind: 'mutation',
            op: 'insert',
            model: body.model,
            record: rec as Record<string, unknown>,
          };
          return encodeWirePayload(JSON.stringify(wireJson), sessionKey);
        });
        return { type: 'rpc.ok', id, cipher };
      }
      if (body.op === 'update') {
        const cipher = await this.opts.writeGate.runExclusive(atlas, async () => {
          const engine = await this.opts.getEngine(atlas);
          const rec = await engine.update(body.model, body.id, body.partial, {
            sync: body.sync ?? true,
          });
          await engine.flushAll();
          const wireJson: WireExecuteResultJson = {
            kind: 'mutation',
            op: 'update',
            model: body.model,
            record: rec ? (rec as Record<string, unknown>) : null,
          };
          return encodeWirePayload(JSON.stringify(wireJson), sessionKey);
        });
        return { type: 'rpc.ok', id, cipher };
      }
      if (body.op === 'insertMany') {
        if (body.rows.length > MAX_INSERT_MANY_ROWS) {
          throw new Error(`insertMany: at most ${MAX_INSERT_MANY_ROWS} rows per RPC.`);
        }
        const cipher = await this.opts.writeGate.runExclusive(atlas, async () => {
          const engine = await this.opts.getEngine(atlas);
          const report = await engine.model(body.model).insertMany(body.rows);
          await engine.flushAll();
          const wireJson: WireExecuteResultJson = {
            kind: 'mutation',
            op: 'insertMany',
            model: body.model,
            record: null,
            successCount: report.successCount,
            failureCount: report.failureCount,
          };
          return encodeWirePayload(JSON.stringify(wireJson), sessionKey);
        });
        return { type: 'rpc.ok', id, cipher };
      }
      if (body.op === 'batchUpdate') {
        if (body.updates.length > MAX_BATCH_UPDATE_OPS) {
          throw new Error(`batchUpdate: at most ${MAX_BATCH_UPDATE_OPS} updates per RPC.`);
        }
        const cipher = await this.opts.writeGate.runExclusive(atlas, async () => {
          const engine = await this.opts.getEngine(atlas);
          let successCount = 0;
          let failureCount = 0;
          for (const u of body.updates) {
            try {
              const rec = await engine.update(u.model, u.id, u.partial, { sync: false });
              if (rec) {
                successCount++;
              } else {
                failureCount++;
              }
            } catch {
              failureCount++;
            }
          }
          await engine.flushAll();
          const wireJson: WireExecuteResultJson = {
            kind: 'mutation',
            op: 'batchUpdate',
            model: '',
            record: null,
            successCount,
            failureCount,
          };
          return encodeWirePayload(JSON.stringify(wireJson), sessionKey);
        });
        return { type: 'rpc.ok', id, cipher };
      }
      if (body.op === 'dropModel') {
        const cipher = await this.opts.writeGate.runExclusive(atlas, async () => {
          const engine = await this.opts.getEngine(atlas);
          await engine.dropModel(body.model);
          EngineLogger.instance.info(
            `[REMOTE][META] dropModel atlas=${atlas} model=${body.model}`,
            undefined,
            'Server',
          );
          const wireJson: WireExecuteResultJson = {
            kind: 'mutation',
            op: 'dropModel',
            model: body.model,
            record: null,
            ok: true,
          };
          return encodeWirePayload(JSON.stringify(wireJson), sessionKey);
        });
        return { type: 'rpc.ok', id, cipher };
      }
      if (body.op === 'dropRelation') {
        const cipher = await this.opts.writeGate.runExclusive(atlas, async () => {
          const engine = await this.opts.getEngine(atlas);
          await engine.dropRelation(body.relation);
          EngineLogger.instance.info(
            `[REMOTE][META] dropRelation atlas=${atlas} relation=${body.relation}`,
            undefined,
            'Server',
          );
          const wireJson: WireExecuteResultJson = {
            kind: 'mutation',
            op: 'dropRelation',
            model: '',
            relation: body.relation,
            record: null,
            ok: true,
          };
          return encodeWirePayload(JSON.stringify(wireJson), sessionKey);
        });
        return { type: 'rpc.ok', id, cipher };
      }
      if (body.op === 'alterModel') {
        const cipher = await this.opts.writeGate.runExclusive(atlas, async () => {
          const engine = await this.opts.getEngine(atlas);
          if (body.patch === true) {
            engine.alterModelPatch(body.model, body.schema as FieldDefsRecord);
          } else {
            engine.alterModel(body.model, body.schema as FieldDefsRecord);
          }
          await engine.flushAll();
          EngineLogger.instance.info(
            `[REMOTE][META] alterModel atlas=${atlas} model=${body.model} patch=${body.patch === true}`,
            undefined,
            'Server',
          );
          const wireJson: WireExecuteResultJson = {
            kind: 'mutation',
            op: 'alterModel',
            model: body.model,
            record: null,
            ok: true,
          };
          return encodeWirePayload(JSON.stringify(wireJson), sessionKey);
        });
        return { type: 'rpc.ok', id, cipher };
      }
      if (body.op === 'registerModel') {
        const cipher = await this.opts.writeGate.runExclusive(atlas, async () => {
          const engine = await this.opts.getEngine(atlas);
          if (!engine.registry.getModel(body.model)) {
            engine.registerModel(body.model, body.schema as FieldDefsRecord);
          }
          await engine.flushAll();
          EngineLogger.instance.info(
            `[REMOTE][META] registerModel atlas=${atlas} model=${body.model}`,
            undefined,
            'Server',
          );
          const wireJson: WireExecuteResultJson = {
            kind: 'mutation',
            op: 'registerModel',
            model: body.model,
            record: null,
            ok: true,
          };
          return encodeWirePayload(JSON.stringify(wireJson), sessionKey);
        });
        return { type: 'rpc.ok', id, cipher };
      }
      if (body.op === 'registerRelation') {
        const cipher = await this.opts.writeGate.runExclusive(atlas, async () => {
          const engine = await this.opts.getEngine(atlas);
          const exists = engine.registry.getRelations().some((r) => r.forward === body.forward);
          if (!exists) {
            engine.registerRelation(
              body.source,
              body.target,
              body.forward,
              body.reverse,
              body.logic,
            );
          }
          await engine.flushAll();
          EngineLogger.instance.info(
            `[REMOTE][META] registerRelation atlas=${atlas} forward=${body.forward}`,
            undefined,
            'Server',
          );
          const wireJson: WireExecuteResultJson = {
            kind: 'mutation',
            op: 'registerRelation',
            model: body.forward,
            record: null,
            ok: true,
            relation: body.forward,
          };
          return encodeWirePayload(JSON.stringify(wireJson), sessionKey);
        });
        return { type: 'rpc.ok', id, cipher };
      }
      throw new Error(`Unknown RPC op: ${String((body as { op?: string }).op)}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { type: 'rpc.err', id, error: message };
    } finally {
      EngineLogger.instance.recordHandledRequest(performance.now() - t0);
    }
  }

  private async executeQueryCipherOnly(
    atlas: string,
    sessionKey: string,
    snapshot: RemoteExecuteSnapshot,
  ): Promise<string> {
    if (this.opts.dev) {
      console.error(
        '[modeldb-server][dev] executeQuery snapshot',
        JSON.stringify(snapshot).slice(0, 2000),
      );
    }
    if (queryPlanHasSerializedCallback(snapshot.plan)) {
      throw new Error('Plan contains filter callbacks.');
    }
    const client = await this.opts.getClient(atlas);
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
    const plain = JSON.stringify(wireJson);
    if (this.opts.dev) {
      console.error('[modeldb-server][dev] executeQuery result', plain.slice(0, 2000));
    }
    return encodeWirePayload(plain, sessionKey);
  }
}

export function decodeExecuteBody(cipher: string, sessionKey: string): WireExecuteBody {
  const plain = decodeWirePayload(cipher, sessionKey);
  return JSON.parse(plain) as WireExecuteBody;
}

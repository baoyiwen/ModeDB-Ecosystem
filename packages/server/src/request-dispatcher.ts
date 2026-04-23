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
import type {
  FieldDefsRecord,
  MatchPredicate,
  ModelRecord,
  RelationDefinition,
  RelationLogic,
} from '@mode-db/common';

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
          const records =
            body.returning === true
              ? report.succeeded
                  .map((r) => r.data)
                  .filter((d): d is ModelRecord => d !== undefined)
                  .map((d) => d as unknown as Record<string, unknown>)
              : undefined;
          const wireJson: WireExecuteResultJson = {
            kind: 'mutation',
            op: 'insertMany',
            model: body.model,
            record: null,
            ...(records ? { records } : {}),
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
      if (body.op === 'batchRegister') {
        const cipher = await this.opts.writeGate.runExclusive(atlas, async () => {
          const engine = await this.opts.getEngine(atlas);
          const createdModels: string[] = [];
          const skippedModels: string[] = [];
          const createdRelations: string[] = [];
          const skippedRelations: string[] = [];
          for (const m of body.models ?? []) {
            if (engine.registry.getModel(m.name)) {
              skippedModels.push(m.name);
              continue;
            }
            engine.registerModel(
              m.name,
              m.schema as FieldDefsRecord | undefined,
              m.parentId ?? null,
            );
            createdModels.push(m.name);
          }
          for (const r of body.relations ?? []) {
            if (body.quickLink) {
              if (!engine.registry.getModel(r.source)) {
                engine.registerModel(r.source);
                createdModels.push(r.source);
              }
              if (!engine.registry.getModel(r.target)) {
                engine.registerModel(r.target);
                createdModels.push(r.target);
              }
            }
            const exists = engine.registry.getRelations().some((x) => x.forward === r.forward);
            if (exists) {
              skippedRelations.push(r.forward);
              continue;
            }
            engine.registerRelation(
              r.source,
              r.target,
              r.forward,
              r.reverse,
              r.logic ?? null,
              r.matchOn ? (r.matchOn as MatchPredicate) : null,
            );
            createdRelations.push(r.forward);
          }
          await engine.flushAll();
          EngineLogger.instance.info(
            `[REMOTE][META] batchRegister atlas=${atlas} newModels=${createdModels.length} newRelations=${createdRelations.length}`,
            undefined,
            'Server',
          );
          const wireJson: WireExecuteResultJson = {
            kind: 'mutation',
            op: 'batchRegister',
            model: '',
            record: null,
            ok: true,
            created: { models: createdModels, relations: createdRelations },
            skipped: { models: skippedModels, relations: skippedRelations },
          };
          return encodeWirePayload(JSON.stringify(wireJson), sessionKey);
        });
        return { type: 'rpc.ok', id, cipher };
      }
      if (body.op === 'bindPair') {
        const cipher = await this.opts.writeGate.runExclusive(atlas, async () => {
          const engine = await this.opts.getEngine(atlas);
          const rel = findRelationByLabels(engine, body.forward, body.reverse);
          assertRegistrationOrder(rel, body.source.model, body.target.model, 'bindPair');
          await engine.bind(body.forward, 'MANUAL', {
            pairs: [[body.source.id, body.target.id]],
          });
          await engine.flushAll();
          const wireJson: WireExecuteResultJson = {
            kind: 'mutation',
            op: 'bindPair',
            model: body.source.model,
            relation: body.forward,
            record: null,
            ok: true,
            pairsCount: 1,
          };
          return encodeWirePayload(JSON.stringify(wireJson), sessionKey);
        });
        return { type: 'rpc.ok', id, cipher };
      }
      if (body.op === 'unlinkPair') {
        const cipher = await this.opts.writeGate.runExclusive(atlas, async () => {
          const engine = await this.opts.getEngine(atlas);
          const rel = findRelationByLabels(engine, body.forward, body.reverse);
          assertRegistrationOrder(rel, body.source.model, body.target.model, 'unlinkPair');
          await engine.unlink(body.forward, [[body.source.id, body.target.id]]);
          await engine.flushAll();
          const wireJson: WireExecuteResultJson = {
            kind: 'mutation',
            op: 'unlinkPair',
            model: body.source.model,
            relation: body.forward,
            record: null,
            ok: true,
            pairsCount: 1,
          };
          return encodeWirePayload(JSON.stringify(wireJson), sessionKey);
        });
        return { type: 'rpc.ok', id, cipher };
      }
      if (body.op === 'bind') {
        const cipher = await this.opts.writeGate.runExclusive(atlas, async () => {
          const engine = await this.opts.getEngine(atlas);
          const rel = findRelationByForward(engine, body.forward);
          if (body.matchOn) {
            engine.updateRelationLogic(
              body.forward,
              (rel.logic ?? 'one-to-many') as RelationLogic,
              body.matchOn as MatchPredicate,
            );
          }
          const before = await engine.indexer.getStats(rel);
          const pairs =
            body.strategy === 'MANUAL' && body.pairs
              ? (body.pairs.map(([s, t]) => [s, t] as const) as readonly (readonly [
                  string,
                  string,
                ])[])
              : undefined;
          await engine.bind(body.forward, body.strategy, pairs ? { pairs } : {});
          await engine.flushAll();
          const after = await engine.indexer.getStats(rel);
          const pairsCount = Math.max(0, after.totalLinks - before.totalLinks);
          const wireJson: WireExecuteResultJson = {
            kind: 'mutation',
            op: 'bind',
            model: '',
            relation: body.forward,
            record: null,
            ok: true,
            pairsCount,
            stats: {
              forwardKeys: after.forwardKeys,
              reverseKeys: after.reverseKeys,
              totalLinks: after.totalLinks,
            },
          };
          return encodeWirePayload(JSON.stringify(wireJson), sessionKey);
        });
        return { type: 'rpc.ok', id, cipher };
      }
      if (body.op === 'previewBind') {
        const engine = await this.opts.getEngine(atlas);
        const rel = findRelationByForward(engine, body.forward);
        const cap = Math.max(0, body.sample ?? 20);
        const effectiveMatch = (body.matchOn ?? rel.matchOn) as MatchPredicate | undefined | null;
        if (body.strategy === 'PROTOCOL' && !effectiveMatch) {
          throw new Error(`previewBind: PROTOCOL requires matchOn on relation "${body.forward}".`);
        }
        await engine.persistence.flushPendingToDisk();
        const merged = engine.persistence.getMergedReader();
        const srcModels = engine.registry.getDescendantsInclusive(rel.source);
        const tgtModels = engine.registry.getDescendantsInclusive(rel.target);
        const srcAll: ModelRecord[] = [];
        for (const m of srcModels) {
          srcAll.push(...(await merged.getAll(m)));
        }
        const tgtAll: ModelRecord[] = [];
        for (const m of tgtModels) {
          tgtAll.push(...(await merged.getAll(m)));
        }
        let pairsCount = 0;
        const sample: [string, string][] = [];
        const push = (s: string, t: string): void => {
          pairsCount++;
          if (sample.length < cap) {
            sample.push([s, t]);
          }
        };
        if (body.strategy === 'GLOBAL') {
          pairsCount = srcAll.length * tgtAll.length;
          outer: for (const s of srcAll) {
            for (const t of tgtAll) {
              if (sample.length >= cap) {
                break outer;
              }
              sample.push([s._id, t._id]);
            }
          }
        } else if (body.strategy === 'PROTOCOL') {
          const pred = effectiveMatch as MatchPredicate;
          for (const s of srcAll) {
            const sv = (s as Record<string, unknown>)[pred.sourceField];
            if (sv === undefined || sv === null) {
              continue;
            }
            for (const t of tgtAll) {
              const tv = (t as Record<string, unknown>)[pred.targetField];
              if (sv === tv) {
                push(s._id, t._id);
              }
            }
          }
        } else {
          for (const [s, t] of body.pairs ?? []) {
            push(s, t);
          }
        }
        const wireJson: WireExecuteResultJson = {
          kind: 'previewBind',
          forward: body.forward,
          pairsCount,
          sample,
        };
        return {
          type: 'rpc.ok',
          id,
          cipher: encodeWirePayload(JSON.stringify(wireJson), sessionKey),
        };
      }
      if (body.op === 'relationStats') {
        const engine = await this.opts.getEngine(atlas);
        const rel = findRelationByForward(engine, body.forward);
        const stats = await engine.indexer.getStats(rel);
        const wireJson: WireExecuteResultJson = {
          kind: 'relationStats',
          forward: body.forward,
          forwardKeys: stats.forwardKeys,
          reverseKeys: stats.reverseKeys,
          totalLinks: stats.totalLinks,
        };
        return {
          type: 'rpc.ok',
          id,
          cipher: encodeWirePayload(JSON.stringify(wireJson), sessionKey),
        };
      }
      if (body.op === 'updateRelationLogic') {
        const cipher = await this.opts.writeGate.runExclusive(atlas, async () => {
          const engine = await this.opts.getEngine(atlas);
          engine.updateRelationLogic(
            body.forward,
            body.logic as RelationLogic,
            body.matchOn ? (body.matchOn as MatchPredicate) : undefined,
          );
          await engine.flushAll();
          EngineLogger.instance.info(
            `[REMOTE][META] updateRelationLogic atlas=${atlas} forward=${body.forward} logic=${body.logic}`,
            undefined,
            'Server',
          );
          const wireJson: WireExecuteResultJson = {
            kind: 'mutation',
            op: 'updateRelationLogic',
            model: '',
            relation: body.forward,
            record: null,
            ok: true,
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

function findRelationByForward(engine: AuthoringEngine, forward: string): RelationDefinition {
  const rel = engine.registry.getRelations().find((r) => r.forward === forward);
  if (!rel) {
    throw new Error(`Relation with forward label "${forward}" not found.`);
  }
  return rel;
}

function findRelationByLabels(
  engine: AuthoringEngine,
  forward: string,
  reverse: string,
): RelationDefinition {
  const rel = engine.registry
    .getRelations()
    .find((r) => r.forward === forward && r.reverse === reverse);
  if (!rel) {
    throw new Error(
      `Relation { forward: "${forward}", reverse: "${reverse}" } not found (labels must match registration).`,
    );
  }
  return rel;
}

function assertRegistrationOrder(
  rel: RelationDefinition,
  srcModel: string,
  tgtModel: string,
  op: string,
): void {
  if (rel.source !== srcModel || rel.target !== tgtModel) {
    throw new Error(
      `${op}: argument order must match registration ${rel.source} → ${rel.target} ` +
        `(got ${srcModel} → ${tgtModel}).`,
    );
  }
}

import type { WebSocket } from 'ws';
import {
  decodeWirePayload,
  encodeWirePayload,
  isMutatingDatabaseOperation,
  queryInterfaceErrorDetailFromMessage,
  type QueryInterfaceErrorDetail,
  type WireExecuteBody,
  type WireExecuteResultJson,
  type WireServerMessage,
} from '@mode-db/shared';
import { executeDatabaseOperation, EngineLogger, type AuthoringEngine } from '@mode-db/core';
import type { WriteSerializationGate } from './write-serialization-gate.js';
import { executePublishedQueryInterface } from './published-interface-runtime.js';
import { executePublishedOperationInterface } from './published-operation-interface-runtime.js';
import { executePublishedBindingSurface } from './published-binding-surface-runtime.js';
import type { AuthorizationService } from './security/authorization-service.js';

function sendJson(ws: WebSocket, msg: WireServerMessage): void {
  ws.send(JSON.stringify(msg));
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

export type RpcCipherReply =
  | { readonly type: 'rpc.ok'; readonly id: string; readonly cipher: string }
  | {
      readonly type: 'rpc.err';
      readonly id: string;
      readonly error: string;
      readonly errorDetail?: QueryInterfaceErrorDetail;
    };

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
      readonly getEngine: (atlas: string) => Promise<AuthoringEngine>;
      readonly writeGate: WriteSerializationGate;
      readonly designerWorkspace: string;
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
      sendJson(ws, {
        type: 'rpc.err',
        id: out.id,
        error: out.error,
        ...(out.errorDetail ? { errorDetail: out.errorDetail } : {}),
      });
    }
  }

  async runRpcCipherReply(
    atlas: string,
    sessionKey: string,
    body: WireExecuteBody,
    id: string,
  ): Promise<RpcCipherReply> {
    const t0 = performance.now();
    const requestSummary = summarizeWireBody(body);
    EngineLogger.instance.info('RPC request received', { atlas, id, ...requestSummary }, 'WireRPC');
    // eslint-disable-next-line no-console
    console.info(`[modeldb-server][rpc] START ${body.op} db=${atlas} id=${id}`, requestSummary);
    try {
      const result = await this.executeBody(atlas, body);
      const cipher = encodeWirePayload(JSON.stringify(result), sessionKey);
      const ms = Number((performance.now() - t0).toFixed(2));
      const resultSummary = summarizeWireResult(result);
      EngineLogger.instance.info(
        'RPC request completed',
        { atlas, id, ms, ...requestSummary, result: resultSummary },
        'WireRPC',
      );
      // eslint-disable-next-line no-console
      console.info(
        `[modeldb-server][rpc] OK ${body.op} db=${atlas} id=${id} ${ms}ms`,
        resultSummary,
      );
      return { type: 'rpc.ok', id, cipher };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const ms = Number((performance.now() - t0).toFixed(2));
      EngineLogger.instance.error(
        'RPC request failed',
        { atlas, id, ms, ...requestSummary, message },
        'WireRPC',
      );

      console.error(`[modeldb-server][rpc] ERROR ${body.op} db=${atlas} id=${id} ${ms}ms`, {
        ...requestSummary,
        message,
      });
      const errorDetail =
        body.op === 'executeInterface' ||
        body.op === 'executeOperationInterface' ||
        body.op === 'executeBindingSurface'
          ? queryInterfaceErrorDetailFromMessage(message)
          : undefined;
      return {
        type: 'rpc.err',
        id,
        error: message,
        ...(errorDetail ? { errorDetail } : {}),
      };
    } finally {
      EngineLogger.instance.recordHandledRequest(performance.now() - t0);
    }
  }

  /** Map one wire op to a JSON result via the shared executor; owns gating + the read/write runtime choice. */
  async executeAuthorized(
    atlas: string,
    body: WireExecuteBody,
    authorization: AuthorizationService,
  ): Promise<WireExecuteResultJson> {
    authorization.preflight(atlas, body);
    return this.executeBody(atlas, body, authorization);
  }

  private async executeBody(
    atlas: string,
    body: WireExecuteBody,
    authorization?: AuthorizationService,
  ): Promise<WireExecuteResultJson> {
    if (body.op === 'executeInterface') {
      return executePublishedQueryInterface({
        authorization,
        atlas,
        designerWorkspace: this.opts.designerWorkspace,
        body,
        getEngine: this.opts.getEngine,
      });
    }
    if (body.op === 'executeOperationInterface') {
      return this.opts.writeGate.runExclusive(atlas, () =>
        executePublishedOperationInterface({
          authorization,
          atlas,
          designerWorkspace: this.opts.designerWorkspace,
          body,
          getEngine: this.opts.getEngine,
        }),
      );
    }
    if (body.op === 'executeBindingSurface') {
      const execute = () =>
        executePublishedBindingSurface({
          authorization,
          atlas,
          designerWorkspace: this.opts.designerWorkspace,
          body,
          getEngine: this.opts.getEngine,
        });
      return body.action.kind === 'mutate'
        ? this.opts.writeGate.runExclusive(atlas, execute)
        : execute();
    }
    if (body.op === 'executeQuery') {
      if (this.opts.dev) {
        console.error(
          '[modeldb-server][dev] executeQuery snapshot',
          JSON.stringify(body.snapshot).slice(0, 2000),
        );
      }
      const engine = await this.opts.getEngine(atlas);
      await authorization?.operation(atlas, body, engine);
      const result = await executeDatabaseOperation(
        { runtime: engine.createRuntime(), atlas, dev: this.opts.dev },
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
        await authorization?.operation(atlas, body, engine);
        return executeDatabaseOperation({ engine, atlas, flush: () => engine.flushAll() }, body);
      });
    }

    // Read-only engine ops: previewBind / relationStats.
    const engine = await this.opts.getEngine(atlas);
    await authorization?.operation(atlas, body, engine);
    return executeDatabaseOperation({ engine, atlas }, body);
  }
}

export function decodeExecuteBody(cipher: string, sessionKey: string): WireExecuteBody {
  const plain = decodeWirePayload(cipher, sessionKey);
  return JSON.parse(plain) as WireExecuteBody;
}

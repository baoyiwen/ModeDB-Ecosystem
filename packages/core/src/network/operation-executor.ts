/**
 * Runtime-agnostic executor for database-scope {@link EngineDatabaseOperation}s.
 *
 * This is the single place that maps a JSON engine operation onto {@link AuthoringEngine} /
 * {@link QueryChain} calls. Both the WebSocket host ({@link WireRequestDispatcher}) and the
 * in-process `AuthoringEngine.apply()` delegate here, guaranteeing identical semantics across
 * remote and local runtimes. It performs no transport / cipher work — it returns a JSON-safe
 * {@link WireExecuteResultJson}; callers own gating (write-serialization) and encoding.
 */

import { EngineLogger } from '@mode-db/common';
import type {
  FieldDefsRecord,
  MatchPredicate,
  ModelRecord,
  RelationDefinition,
  RelationLogic,
} from '@mode-db/common';
import {
  queryPlanHasSerializedCallback,
  type EngineDatabaseOperation,
  type QueryExecuteOptions,
  type RemoteExecuteSnapshot,
  type WireExecuteResultJson,
} from '@mode-db/shared';
import type { AuthoringEngine } from '../../authoring/engine.js';
import { QueryChain } from '../runtime/query.js';
import type { RuntimeContext } from '../runtime/context.js';
import { serializeExecuteResultForWire } from './execute-result-wire.js';

const MAX_INSERT_MANY_ROWS = 20_000;
const MAX_BATCH_UPDATE_OPS = 20_000;

/** Dependencies for {@link executeDatabaseOperation}. */
export interface DatabaseOperationContext {
  /** Authoring engine bound to the target logical library (required for all ops except `executeQuery`). */
  readonly engine?: AuthoringEngine;
  /** Read-only runtime context for `executeQuery`; defaults to `engine.createRuntime()`. */
  readonly runtime?: RuntimeContext;
  /** Persist mutations; defaults to `engine.flushAll()`. */
  readonly flush?: () => Promise<void>;
  /** Logical library / atlas name (logging only). */
  readonly atlas?: string;
  /** Verbose query logging. */
  readonly dev?: boolean;
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
      `${op}: argument order must match registration ${rel.source} -> ${rel.target} ` +
        `(got ${srcModel} -> ${tgtModel}).`,
    );
  }
}

async function executeQueryOperation(
  ctx: DatabaseOperationContext,
  snapshot: RemoteExecuteSnapshot,
): Promise<WireExecuteResultJson> {
  if (queryPlanHasSerializedCallback(snapshot.plan)) {
    throw new Error('Plan contains filter callbacks.');
  }
  const runtime = ctx.runtime ?? ctx.engine?.createRuntime();
  if (!runtime) {
    throw new Error('executeQuery: a runtime context or engine is required.');
  }
  const chain = QueryChain.fromWirePlan(
    runtime.registry,
    runtime.indexReader,
    runtime.dataReader,
    snapshot.plan,
    runtime.fieldContext ? { fieldCtx: runtime.fieldContext } : undefined,
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
  return serializeExecuteResultForWire(raw);
}

/**
 * Execute a single database-scope operation, returning a JSON-safe result.
 * Mutating ops flush via `ctx.flush` (default `engine.flushAll()`); read ops do not.
 */
export async function executeDatabaseOperation(
  ctx: DatabaseOperationContext,
  op: EngineDatabaseOperation,
): Promise<WireExecuteResultJson> {
  if (op.op === 'executeQuery') {
    return executeQueryOperation(ctx, op.snapshot as RemoteExecuteSnapshot);
  }

  const engine = ctx.engine;
  if (!engine) {
    throw new Error(`Operation "${op.op}" requires an AuthoringEngine.`);
  }
  const flush = ctx.flush ?? ((): Promise<void> => engine.flushAll());
  const atlas = ctx.atlas ?? '';

  if (op.op === 'insert') {
    const rec = await engine.insert(op.model, op.data, { sync: op.sync ?? true });
    await flush();
    return {
      kind: 'mutation',
      op: 'insert',
      model: op.model,
      record: rec as Record<string, unknown>,
    };
  }

  if (op.op === 'update') {
    const rec = await engine.update(op.model, op.id, op.partial, { sync: op.sync ?? true });
    await flush();
    return {
      kind: 'mutation',
      op: 'update',
      model: op.model,
      record: rec ? (rec as Record<string, unknown>) : null,
    };
  }

  if (op.op === 'insertMany') {
    if (op.rows.length > MAX_INSERT_MANY_ROWS) {
      throw new Error(`insertMany: at most ${MAX_INSERT_MANY_ROWS} rows per operation.`);
    }
    const report = await engine.model(op.model).insertMany(op.rows);
    await flush();
    const records =
      op.returning === true
        ? report.succeeded
            .map((r) => r.data)
            .filter((d): d is ModelRecord => d !== undefined)
            .map((d) => d as unknown as Record<string, unknown>)
        : undefined;
    return {
      kind: 'mutation',
      op: 'insertMany',
      model: op.model,
      record: null,
      ...(records ? { records } : {}),
      successCount: report.successCount,
      failureCount: report.failureCount,
    };
  }

  if (op.op === 'batchUpdate') {
    if (op.updates.length > MAX_BATCH_UPDATE_OPS) {
      throw new Error(`batchUpdate: at most ${MAX_BATCH_UPDATE_OPS} updates per operation.`);
    }
    let successCount = 0;
    let failureCount = 0;
    for (const u of op.updates) {
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
    await flush();
    return {
      kind: 'mutation',
      op: 'batchUpdate',
      model: '',
      record: null,
      successCount,
      failureCount,
    };
  }

  if (op.op === 'delete') {
    const ok = await engine.delete(op.model, op.id, { sync: op.sync ?? true });
    await flush();
    return {
      kind: 'mutation',
      op: 'delete',
      model: op.model,
      record: null,
      ok,
    };
  }

  if (op.op === 'batchDelete') {
    if (op.deletes.length > MAX_BATCH_UPDATE_OPS) {
      throw new Error(`batchDelete: at most ${MAX_BATCH_UPDATE_OPS} deletes per operation.`);
    }
    let successCount = 0;
    let failureCount = 0;
    for (const d of op.deletes) {
      try {
        const ok = await engine.delete(d.model, d.id, { sync: false });
        if (ok) {
          successCount++;
        } else {
          failureCount++;
        }
      } catch {
        failureCount++;
      }
    }
    await flush();
    return {
      kind: 'mutation',
      op: 'batchDelete',
      model: '',
      record: null,
      successCount,
      failureCount,
      ok: failureCount === 0,
    };
  }

  if (op.op === 'dropModel') {
    await engine.dropModel(op.model);
    EngineLogger.instance.info(
      `[OP][META] dropModel atlas=${atlas} model=${op.model}`,
      undefined,
      'Engine',
    );
    return { kind: 'mutation', op: 'dropModel', model: op.model, record: null, ok: true };
  }

  if (op.op === 'dropRelation') {
    await engine.dropRelation(op.relation);
    EngineLogger.instance.info(
      `[OP][META] dropRelation atlas=${atlas} relation=${op.relation}`,
      undefined,
      'Engine',
    );
    return {
      kind: 'mutation',
      op: 'dropRelation',
      model: '',
      relation: op.relation,
      record: null,
      ok: true,
    };
  }

  if (op.op === 'alterModel') {
    if (op.patch === true) {
      engine.alterModelPatch(op.model, op.schema as FieldDefsRecord);
    } else {
      engine.alterModel(op.model, op.schema as FieldDefsRecord);
    }
    await flush();
    EngineLogger.instance.info(
      `[OP][META] alterModel atlas=${atlas} model=${op.model} patch=${op.patch === true}`,
      undefined,
      'Engine',
    );
    return { kind: 'mutation', op: 'alterModel', model: op.model, record: null, ok: true };
  }

  if (op.op === 'registerModel') {
    if (!engine.registry.getModel(op.model)) {
      engine.registerModel(op.model, op.schema as FieldDefsRecord);
    }
    await flush();
    EngineLogger.instance.info(
      `[OP][META] registerModel atlas=${atlas} model=${op.model}`,
      undefined,
      'Engine',
    );
    return { kind: 'mutation', op: 'registerModel', model: op.model, record: null, ok: true };
  }

  if (op.op === 'registerRelation') {
    const exists = engine.registry.getRelations().some((r) => r.forward === op.forward);
    if (!exists) {
      engine.registerRelation(op.source, op.target, op.forward, op.reverse, op.logic);
    }
    await flush();
    EngineLogger.instance.info(
      `[OP][META] registerRelation atlas=${atlas} forward=${op.forward}`,
      undefined,
      'Engine',
    );
    return {
      kind: 'mutation',
      op: 'registerRelation',
      model: op.forward,
      record: null,
      ok: true,
      relation: op.forward,
    };
  }

  if (op.op === 'batchRegister') {
    const createdModels: string[] = [];
    const skippedModels: string[] = [];
    const createdRelations: string[] = [];
    const skippedRelations: string[] = [];
    for (const m of op.models ?? []) {
      if (engine.registry.getModel(m.name)) {
        skippedModels.push(m.name);
        continue;
      }
      engine.registerModel(m.name, m.schema as FieldDefsRecord | undefined, m.parentId ?? null);
      createdModels.push(m.name);
    }
    for (const r of op.relations ?? []) {
      if (op.quickLink) {
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
    await flush();
    EngineLogger.instance.info(
      `[OP][META] batchRegister atlas=${atlas} newModels=${createdModels.length} newRelations=${createdRelations.length}`,
      undefined,
      'Engine',
    );
    return {
      kind: 'mutation',
      op: 'batchRegister',
      model: '',
      record: null,
      ok: true,
      created: { models: createdModels, relations: createdRelations },
      skipped: { models: skippedModels, relations: skippedRelations },
    };
  }

  if (op.op === 'bindPair') {
    const rel = findRelationByLabels(engine, op.forward, op.reverse);
    assertRegistrationOrder(rel, op.source.model, op.target.model, 'bindPair');
    await engine.bind(op.forward, 'MANUAL', { pairs: [[op.source.id, op.target.id]] });
    await flush();
    return {
      kind: 'mutation',
      op: 'bindPair',
      model: op.source.model,
      relation: op.forward,
      record: null,
      ok: true,
      pairsCount: 1,
    };
  }

  if (op.op === 'unlinkPair') {
    const rel = findRelationByLabels(engine, op.forward, op.reverse);
    assertRegistrationOrder(rel, op.source.model, op.target.model, 'unlinkPair');
    await engine.unlink(op.forward, [[op.source.id, op.target.id]]);
    await flush();
    return {
      kind: 'mutation',
      op: 'unlinkPair',
      model: op.source.model,
      relation: op.forward,
      record: null,
      ok: true,
      pairsCount: 1,
    };
  }

  if (op.op === 'bind') {
    const rel = findRelationByForward(engine, op.forward);
    if (op.matchOn) {
      engine.updateRelationLogic(
        op.forward,
        (rel.logic ?? 'one-to-many') as RelationLogic,
        op.matchOn as MatchPredicate,
      );
    }
    const before = await engine.indexer.getStats(rel);
    const pairs =
      op.strategy === 'MANUAL' && op.pairs
        ? (op.pairs.map(([s, t]) => [s, t] as const) as readonly (readonly [string, string])[])
        : undefined;
    await engine.bind(op.forward, op.strategy, pairs ? { pairs } : {});
    await flush();
    const after = await engine.indexer.getStats(rel);
    const pairsCount = Math.max(0, after.totalLinks - before.totalLinks);
    return {
      kind: 'mutation',
      op: 'bind',
      model: '',
      relation: op.forward,
      record: null,
      ok: true,
      pairsCount,
      stats: {
        forwardKeys: after.forwardKeys,
        reverseKeys: after.reverseKeys,
        totalLinks: after.totalLinks,
      },
    };
  }

  if (op.op === 'previewBind') {
    const rel = findRelationByForward(engine, op.forward);
    const cap = Math.max(0, op.sample ?? 20);
    const effectiveMatch = (op.matchOn ?? rel.matchOn) as MatchPredicate | undefined | null;
    if (op.strategy === 'PROTOCOL' && !effectiveMatch) {
      throw new Error(`previewBind: PROTOCOL requires matchOn on relation "${op.forward}".`);
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
    if (op.strategy === 'GLOBAL') {
      pairsCount = srcAll.length * tgtAll.length;
      outer: for (const s of srcAll) {
        for (const t of tgtAll) {
          if (sample.length >= cap) {
            break outer;
          }
          sample.push([s._id, t._id]);
        }
      }
    } else if (op.strategy === 'PROTOCOL') {
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
      for (const [s, t] of op.pairs ?? []) {
        push(s, t);
      }
    }
    return { kind: 'previewBind', forward: op.forward, pairsCount, sample };
  }

  if (op.op === 'relationStats') {
    const rel = findRelationByForward(engine, op.forward);
    const stats = await engine.indexer.getStats(rel);
    return {
      kind: 'relationStats',
      forward: op.forward,
      forwardKeys: stats.forwardKeys,
      reverseKeys: stats.reverseKeys,
      totalLinks: stats.totalLinks,
    };
  }

  if (op.op === 'updateRelationLogic') {
    engine.updateRelationLogic(
      op.forward,
      op.logic as RelationLogic,
      op.matchOn ? (op.matchOn as MatchPredicate) : undefined,
    );
    await flush();
    EngineLogger.instance.info(
      `[OP][META] updateRelationLogic atlas=${atlas} forward=${op.forward} logic=${op.logic}`,
      undefined,
      'Engine',
    );
    return {
      kind: 'mutation',
      op: 'updateRelationLogic',
      model: '',
      relation: op.forward,
      record: null,
      ok: true,
    };
  }

  if (op.op === 'clearModelData') {
    const deletedCount = await engine.clearModelData(op.model);
    await flush();
    EngineLogger.instance.info(
      `[OP][META] clearModelData atlas=${atlas} model=${op.model} deleted=${deletedCount}`,
      undefined,
      'Engine',
    );
    return {
      kind: 'mutation',
      op: 'clearModelData',
      model: op.model,
      record: null,
      ok: true,
      deletedCount,
    };
  }

  if (op.op === 'clearAllData') {
    const { totalDeleted, perModel } = await engine.clearAllData();
    await flush();
    EngineLogger.instance.info(
      `[OP][META] clearAllData atlas=${atlas} deleted=${totalDeleted}`,
      undefined,
      'Engine',
    );
    return {
      kind: 'mutation',
      op: 'clearAllData',
      model: '',
      record: null,
      ok: true,
      deletedCount: totalDeleted,
      perModel,
    };
  }

  throw new Error(`Unknown database operation: ${String((op as { op?: string }).op)}`);
}

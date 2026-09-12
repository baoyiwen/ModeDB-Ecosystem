/**
 * Runtime-agnostic executor for database-scope {@link EngineDatabaseOperation}s.
 *
 * This is the single place that maps a JSON engine operation onto {@link AuthoringEngine} /
 * {@link QueryChain} calls. Both the WebSocket host ({@link WireRequestDispatcher}) and the
 * in-process `AuthoringEngine.apply()` delegate here, guaranteeing identical semantics across
 * remote and local runtimes. It performs no transport / cipher work — it returns a JSON-safe
 * {@link WireExecuteResultJson}; callers own gating (write-serialization) and encoding.
 */

import { EngineLogger, importLookupCanonicalKey } from '@mode-db/common';
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

function resolvePeerMatchFieldType(
  engine: AuthoringEngine,
  peerModel: string,
  peerMatchField: string,
  opFieldType: string | undefined,
): string {
  if (opFieldType !== undefined && opFieldType.length > 0) {
    return opFieldType;
  }
  const def = engine.registry.getModel(peerModel);
  const ft = def?.fieldTypes.get(peerMatchField);
  return ft?.type ?? 'String';
}

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

function findRelationByLabelsAndEndpoints(
  engine: AuthoringEngine,
  forward: string,
  reverse: string,
  modelA: string,
  modelB: string,
): RelationDefinition {
  const rel = engine.registry
    .getRelations()
    .find(
      (r) =>
        r.forward === forward &&
        r.reverse === reverse &&
        (r.source === modelA || r.target === modelA) &&
        (r.source === modelB || r.target === modelB),
    );
  if (!rel) {
    throw new Error(
      `Relation { forward: "${forward}", reverse: "${reverse}" } for endpoints "${modelA}" and "${modelB}" not found.`,
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

function relationAllowsPair(rel: RelationDefinition, sourceId: string, targetId: string): boolean {
  return sourceId !== targetId || rel.selfLoopPolicy === 'allow';
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
    if (op.upsert?.matchFields?.length) {
      const result = await engine.upsertMany(op.model, op.rows, op.upsert.matchFields, {
        sync: op.sync ?? true,
        updateExisting: op.upsert.updateExisting ?? true,
      });
      await flush();
      const report = result.report;
      const records =
        op.returning === true
          ? report.succeeded
              .map((r) => r.data)
              .filter((d): d is ModelRecord => d !== undefined)
              .map((d) => d as unknown as Record<string, unknown>)
          : undefined;
      const rowFailures =
        report.failureCount > 0
          ? report.failed.map((r) => ({
              index: r.index,
              diagnostics: r.diagnostics.map((d) => ({
                code: d.code,
                severity: d.severity,
                message: d.message,
              })),
            }))
          : undefined;
      return {
        kind: 'mutation',
        op: 'insertMany',
        model: op.model,
        record: null,
        ...(records ? { records } : {}),
        successCount: report.successCount,
        failureCount: report.failureCount,
        insertedCount: result.insertedCount,
        updatedCount: result.updatedCount,
        ...(rowFailures ? { rowFailures } : {}),
      };
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
    const rowFailures =
      report.failureCount > 0
        ? report.failed.map((r) => ({
            index: r.index,
            diagnostics: r.diagnostics.map((d) => ({
              code: d.code,
              severity: d.severity,
              message: d.message,
            })),
          }))
        : undefined;
    return {
      kind: 'mutation',
      op: 'insertMany',
      model: op.model,
      record: null,
      ...(records ? { records } : {}),
      successCount: report.successCount,
      failureCount: report.failureCount,
      ...(rowFailures ? { rowFailures } : {}),
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
    const rel =
      op.source && op.target && op.reverse
        ? findRelationByLabelsAndEndpoints(engine, op.relation, op.reverse, op.source, op.target)
        : undefined;
    if (rel) {
      assertRegistrationOrder(rel, op.source!, op.target!, 'dropRelation');
      await engine.dropRelationDefinition(rel);
    } else {
      const matches = engine.registry
        .getRelations()
        .filter((r) => r.forward === op.relation || r.reverse === op.relation);
      if (matches.length > 1) {
        throw new Error(
          `dropRelation: relation label "${op.relation}" is ambiguous; provide source, target and reverse.`,
        );
      }
      await engine.dropRelation(op.relation);
    }
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
    const exists = engine.registry
      .getRelations()
      .some(
        (r) =>
          r.source === op.source &&
          r.target === op.target &&
          r.forward === op.forward &&
          r.reverse === op.reverse,
      );
    if (!exists) {
      engine.registerRelation(
        op.source,
        op.target,
        op.forward,
        op.reverse,
        op.logic,
        null,
        op.selfLoopPolicy ?? 'deny',
      );
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
      const exists = engine.registry
        .getRelations()
        .some(
          (x) =>
            x.source === r.source &&
            x.target === r.target &&
            x.forward === r.forward &&
            x.reverse === r.reverse,
        );
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
        r.selfLoopPolicy ?? 'deny',
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
    const before = await engine.indexer.getForward(rel, op.source.id);
    await engine.bind(op.forward, 'MANUAL', { pairs: [[op.source.id, op.target.id]] });
    const after = await engine.indexer.getForward(rel, op.source.id);
    await flush();
    return {
      kind: 'mutation',
      op: 'bindPair',
      model: op.source.model,
      relation: op.forward,
      record: null,
      ok: true,
      pairsCount: !before.includes(op.target.id) && after.includes(op.target.id) ? 1 : 0,
    };
  }

  if (op.op === 'bindImportLookup') {
    const rel = findRelationByLabelsAndEndpoints(
      engine,
      op.forward,
      op.reverse,
      op.importModel,
      op.peerModel,
    );
    if (op.importModel !== rel.source && op.importModel !== rel.target) {
      throw new Error(
        `bindImportLookup: importModel "${op.importModel}" is not an endpoint of relation "${op.forward}".`,
      );
    }
    if (op.peerModel !== rel.source && op.peerModel !== rel.target) {
      throw new Error(
        `bindImportLookup: peerModel "${op.peerModel}" is not an endpoint of relation "${op.forward}".`,
      );
    }
    const isSelfRelation = rel.source === rel.target;
    const importSide = op.importSide ?? 'target';
    if (isSelfRelation && importSide !== 'source' && importSide !== 'target') {
      throw new Error('bindImportLookup: importSide must be "source" or "target".');
    }

    const peerMatchFieldType = resolvePeerMatchFieldType(
      engine,
      op.peerModel,
      op.peerMatchField,
      op.peerMatchFieldType,
    );

    const peerRows = await engine.persistence.getMergedReader().getAll(op.peerModel);
    const peerIndex = new Map<string, string>();
    for (const row of peerRows) {
      const rec = row as Record<string, unknown>;
      const id = rec._id;
      if (typeof id !== 'string' || id.length === 0) {
        continue;
      }
      const key = importLookupCanonicalKey(rec[op.peerMatchField], peerMatchFieldType);
      if (key !== null && !peerIndex.has(key)) {
        peerIndex.set(key, id);
      }
    }

    const manualPairs: Array<[string, string]> = [];
    let skippedCount = 0;
    for (const pair of op.pairs) {
      const key = importLookupCanonicalKey(pair.lookupValue, peerMatchFieldType);
      if (key === null) {
        skippedCount += 1;
        continue;
      }
      const peerId = peerIndex.get(key);
      if (peerId === undefined) {
        skippedCount += 1;
        continue;
      }
      if (isSelfRelation && peerId === pair.importedId && rel.selfLoopPolicy !== 'allow') {
        skippedCount += 1;
        continue;
      }
      const importedAsSource = isSelfRelation
        ? importSide === 'source'
        : op.importModel === rel.source;
      if (importedAsSource) {
        manualPairs.push([pair.importedId, peerId]);
      } else {
        manualPairs.push([peerId, pair.importedId]);
      }
    }

    let pairsCount = 0;
    if (manualPairs.length > 0) {
      const before = await engine.indexer.getStats(rel);
      await engine.indexer.bind(rel, 'MANUAL', [], [], { pairs: manualPairs });
      await flush();
      const after = await engine.indexer.getStats(rel);
      pairsCount = Math.max(0, after.totalLinks - before.totalLinks);
    }

    return {
      kind: 'mutation',
      op: 'bindImportLookup',
      model: op.importModel,
      relation: op.forward,
      record: null,
      ok: true,
      pairsCount,
      skippedCount,
    };
  }

  if (op.op === 'unlinkPair') {
    const rel = findRelationByLabels(engine, op.forward, op.reverse);
    assertRegistrationOrder(rel, op.source.model, op.target.model, 'unlinkPair');
    const before = await engine.indexer.getForward(rel, op.source.id);
    await engine.unlink(op.forward, [[op.source.id, op.target.id]]);
    const after = await engine.indexer.getForward(rel, op.source.id);
    await flush();
    return {
      kind: 'mutation',
      op: 'unlinkPair',
      model: op.source.model,
      relation: op.forward,
      record: null,
      ok: true,
      pairsCount: before.includes(op.target.id) && !after.includes(op.target.id) ? 1 : 0,
    };
  }

  if (op.op === 'rebindPair') {
    const rel = findRelationByLabels(engine, op.forward, op.reverse);
    assertRegistrationOrder(rel, op.source.model, op.previousTarget.model, 'rebindPair');
    assertRegistrationOrder(rel, op.source.model, op.nextTarget.model, 'rebindPair');
    const currentTargets = await engine.indexer.getForward(rel, op.source.id);
    if (!currentTargets.includes(op.previousTarget.id)) {
      throw new Error('rebindPair: the previous relation pair does not exist.');
    }
    if (op.previousTarget.id === op.nextTarget.id) {
      return {
        kind: 'mutation',
        op: 'rebindPair',
        model: op.source.model,
        relation: op.forward,
        record: null,
        ok: true,
        pairsCount: 0,
      };
    }
    await engine.unlink(op.forward, [[op.source.id, op.previousTarget.id]]);
    try {
      await engine.bind(op.forward, 'MANUAL', {
        pairs: [[op.source.id, op.nextTarget.id]],
      });
      const reboundTargets = await engine.indexer.getForward(rel, op.source.id);
      if (!reboundTargets.includes(op.nextTarget.id)) {
        throw new Error('rebindPair: the replacement relation pair was rejected.');
      }
    } catch (error) {
      await engine.bind(op.forward, 'MANUAL', {
        pairs: [[op.source.id, op.previousTarget.id]],
      });
      throw error;
    }
    await flush();
    return {
      kind: 'mutation',
      op: 'rebindPair',
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
          if (!relationAllowsPair(rel, s._id, t._id)) {
            continue;
          }
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
            if (!relationAllowsPair(rel, s._id, t._id)) {
              continue;
            }
            push(s._id, t._id);
          }
        }
      }
    } else {
      for (const [s, t] of op.pairs ?? []) {
        if (!relationAllowsPair(rel, s, t)) {
          continue;
        }
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
    if (op.source && op.target && op.reverse) {
      const rel = findRelationByLabelsAndEndpoints(
        engine,
        op.forward,
        op.reverse,
        op.source,
        op.target,
      );
      assertRegistrationOrder(rel, op.source, op.target, 'updateRelationLogic');
      rel.logic = op.logic as RelationLogic;
      if (op.matchOn !== undefined) {
        rel.matchOn = op.matchOn as MatchPredicate;
      }
      if (op.selfLoopPolicy !== undefined) {
        rel.selfLoopPolicy = op.selfLoopPolicy;
      }
    } else {
      engine.updateRelationLogic(
        op.forward,
        op.logic as RelationLogic,
        op.matchOn ? (op.matchOn as MatchPredicate) : undefined,
        op.selfLoopPolicy,
      );
    }
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

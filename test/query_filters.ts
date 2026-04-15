/**
 * 查询与谓词系统集成测试（对应当前 README §6 与 `src/runtime/predicate-tree.ts`、`filter-builder.ts`、`query.ts`）。
 *
 * 覆盖：
 * - 链式 where / is / greaterThan / **gt**、段内 AND、`.or()` 段间 OR
 * - **matchAll**（FilterBuilder 闭包）、**matchAllNodes**（嵌套 PredicateComposer.and/or）
 * - **matchAny** + **getQueryPlan**（QueryPlanASTv2 / trailing OR 结构）
 * - **filter**（CallbackNode）、**relate** 目标过滤、**includeRelates** + **FILTERED_OUT_WHERE** 与 **failedPredicate**、**getRelationStatus** / **toSnapshot().relationStatus**
 * - **evaluatePredicate**：**AND 短路**（首假不执行后续 callback）、**OR 短路**（首真不执行后续 callback）
 * - **FilterBuilder.compose** + **QueryEngine.matches**、**QueryEngine.evaluateInto** + **PredicateEvaluateContext**
 *
 * Run: `npm run query-filters` 或 `npx tsx test/query_filters.ts`
 *       `npm run test:integration`（第二项）
 *
 * 全部测试脚本说明见同目录 README.md
 */

import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { configureModelDBStorageRoot } from '@mode-db/common';
import { AuthoringEngine } from '../packages/core/src/authoring/AuthoringEngine.js';
import { integrationVaultAuthoringOptions, useIntegrationVaultEnv } from './integration-vault.js';
import type { ModelRecord } from '@mode-db/common';
import type { HydratedEntity } from '../packages/core/src/runtime/HydratedEntity.js';
import { FilterBuilder } from '../packages/core/src/runtime/filter-builder.js';
import { ModelDBClient } from '../packages/core/src/runtime/ModelDBClient.js';
import { QueryEngine } from '../packages/core/src/runtime/query-engine.js';
import {
  atomNode,
  callbackNode,
  evaluatePredicate,
  groupNode,
  type PredicateEvaluateContext,
} from '../packages/core/src/runtime/predicate-tree.js';

const DATA_ROOT = join(process.cwd(), 'data');
const ATLAS = 'query_filter_demo';

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

/** 打印本批 HydratedEntity 的全部行数据（含模型名）；可选打印 toNested（含 relates） */
function printAllResults(
  label: string,
  entities: HydratedEntity[],
  options?: { nested?: boolean },
): void {
  const flat = entities.map((h) => ({
    model: h.getModelName(),
    data: h.getData(),
  }));
  console.log(`  [${label}] count=${entities.length}`);
  console.log(JSON.stringify(flat, null, 2));
  if (options?.nested && entities.length > 0) {
    console.log(`  [${label}] toNested():`);
    console.log(
      JSON.stringify(
        entities.map((h) => h.toNested()),
        null,
        2,
      ),
    );
  }
}

async function main(): Promise<void> {
  configureModelDBStorageRoot({ storageRoot: DATA_ROOT });
  useIntegrationVaultEnv();
  await rm(join(DATA_ROOT, ATLAS), { recursive: true, force: true });

  const eng = new AuthoringEngine({
    atlas: ATLAS,
    storageRoot: DATA_ROOT,
    ...integrationVaultAuthoringOptions,
  });
  eng.quickLink('Zone', 'Pump', 'has_pump', 'in_zone');

  const Zone = eng.model('Zone');
  const Pump = eng.model('Pump');
  Zone.updateFields(['id', 'name', 'level']);
  Pump.updateFields(['id', 'zoneId', 'status', 'power']);

  await Zone.insert({ id: 'Z-A', name: '区A', level: 1 });
  await Zone.insert({ id: 'Z-B', name: '区B', level: 2 });
  await Pump.insert({ id: 'P1', zoneId: 'Z-A', status: 'active', power: 80 });
  await Pump.insert({ id: 'P2', zoneId: 'Z-A', status: 'idle', power: 30 });
  await Pump.insert({ id: 'P3', zoneId: 'Z-B', status: 'active', power: 90 });

  const rel = eng.relation('has_pump');
  rel.updateLogic('many-to-one', { sourceField: 'id', targetField: 'zoneId' });
  await rel.bind({ strategy: 'PROTOCOL' });
  await eng.flushAll();

  const client = await ModelDBClient.connect(ATLAS);

  console.log('[query_filters] 示例: query().where(level,eq,1).relate(has_pump, 目标过滤)');
  const rows = await client
    .model('Zone')
    .query()
    .where('level', 'eq', 1)
    .relate('has_pump', (p) => p.where('status', 'eq', 'active').where('power', '>', 50))
    .execute();

  assert(rows.length === 1, `应只剩 1 台泵，实际 ${rows.length}`);
  const d = rows[0]!.getData() as Record<string, unknown>;
  assert(d['id'] === 'P1', '应为 P1');

  printAllResults('where+relate 目标过滤', rows);

  console.log('[query_filters] AND: 同一 OR 组内 status∧power∧zoneId（链式 is / greaterThan）');
  const andChain = await client
    .model('Pump')
    .query()
    .is('status', 'active')
    .greaterThan('power', 40)
    .is('zoneId', 'Z-A')
    .execute();
  assert(andChain.length === 1, `AND 应唯一命中 P1，实际 ${andChain.length}`);
  assert((andChain[0]!.getData() as Record<string, unknown>)['id'] === 'P1', 'AND 链式应为 P1');

  printAllResults('AND 链式 is/greaterThan', andChain);

  console.log('[query_filters] QueryChain.gt 与 greaterThan 语义等价');
  const viaGt = await client
    .model('Pump')
    .query()
    .is('status', 'active')
    .gt('power', 40)
    .is('zoneId', 'Z-A')
    .execute();
  assert(viaGt.length === 1, `gt 链应同 andChain，实际 ${viaGt.length}`);
  assert((viaGt[0]!.getData() as Record<string, unknown>)['id'] === 'P1', 'gt 链应命中 P1');
  printAllResults('AND 链式 is/gt', viaGt);

  console.log('[query_filters] AND: matchAll 与追加条件在同一组内 AND');
  const andMatchAll = await client
    .model('Pump')
    .query()
    .matchAll((b) => {
      b.is('status', 'active');
      b.greaterThan('power', 40);
    })
    .is('zoneId', 'Z-A')
    .execute();
  assert(
    andMatchAll.length === 1 &&
      (andMatchAll[0]!.getData() as Record<string, unknown>)['id'] === 'P1',
    'matchAll + is 应与上一段 AND 等价',
  );

  printAllResults('AND matchAll + is(zoneId)', andMatchAll);

  console.log('[query_filters] OR: level=1 OR level=2 的 Zone 下全部泵（无目标过滤）');
  const many = await client
    .model('Zone')
    .query()
    .where('level', 'eq', 1)
    .or()
    .where('level', 'eq', 2)
    .relate('has_pump')
    .execute();
  assert(many.length === 3, `应 3 台泵，实际 ${many.length}`);

  printAllResults('OR level 1|2 → has_pump 扁平结果', many);

  console.log('[query_filters] filter() 回调');
  const one = await client
    .model('Pump')
    .query()
    .filter((r) => (r as Record<string, unknown>)['power'] === 90)
    .execute();
  assert(
    one.length === 1 && (one[0]!.getData() as Record<string, unknown>)['id'] === 'P3',
    'filter P3',
  );

  printAllResults('filter(power===90)', one);

  console.log('[query_filters] Fluent API: is / greaterThan / matchAny / relate + getQueryPlan');
  const fluentChain = client
    .model('Pump')
    .query()
    .is('status', 'active')
    .greaterThan('power', 50)
    .matchAny((p) => [p.contains('id', 'P1'), p.inside('id', ['P3'])]);
  const plan = fluentChain.getQueryPlan();
  assert(plan.version === 2, 'AST version');
  const trailing = plan.trailing as { type?: string; logic?: string; children?: unknown[] };
  assert(trailing.type === 'group' && trailing.logic === 'OR', 'matchAny 应产生顶层 OR 组');
  assert(
    Array.isArray(trailing.children) && trailing.children.length === 2,
    'matchAny 应 2 个 OR 分支',
  );
  console.log('  getQueryPlan():', JSON.stringify(plan, null, 2));
  const fluentRows = await fluentChain.execute();
  assert(
    fluentRows.length === 2,
    `active 且 power>50 且 (id 含 P1 或 id∈P3) 应 2 条，实际 ${fluentRows.length}`,
  );

  printAllResults('Fluent matchAny 扁平结果', fluentRows);

  console.log(
    '[query_filters] 嵌套谓词: AND( status, OR(typeA, typeB) ) — 用 matchAllNodes + PredicateComposer',
  );
  type PumpRow = { id: string; zoneId: string; status: string; power: number; type?: string };
  const nested = await client
    .model('Pump')
    .query<PumpRow>()
    .matchAllNodes((p) => [
      p.and(p.is('status', 'active'), p.or(p.inside('id', ['P1']), p.inside('id', ['P3']))),
    ])
    .execute();
  assert(nested.length === 2, `嵌套 OR 应命中 P1+P3，实际 ${nested.length}`);

  printAllResults('嵌套 AND( status, OR(id∈P1, id∈P3) )', nested);

  const zoneRow = await client
    .model('Pump')
    .query()
    .is('id', 'P1')
    .relate('in_zone', (zone) => zone.is('level', 1))
    .execute();
  assert(zoneRow.length === 1, 'P1 → in_zone → level=1');
  assert((zoneRow[0]!.getData() as Record<string, unknown>)['id'] === 'Z-A', '应为分区 Z-A');

  printAllResults('relate in_zone + is(level)', zoneRow);

  console.log('[query_filters] includeRelates + 目标过滤导致 FILTERED_OUT_WHERE（有边但全被筛掉）');
  const tree = await client
    .model('Zone')
    .query()
    .where('id', 'eq', 'Z-A')
    .relate('has_pump', (p) => p.where('status', 'eq', 'nonexistent'))
    .execute({ includeRelates: true });
  const root = tree[0]!;
  assert(root.getRelate('has_pump').length === 0, '子节点应空');
  assert(
    root.getRelateDiagnostic('has_pump')?.reason === 'FILTERED_OUT_WHERE',
    '应为 FILTERED_OUT_WHERE',
  );
  assert(
    root.getRelateDiagnostic('has_pump')?.failedPredicate !== undefined,
    'FILTERED_OUT_WHERE 应带 failedPredicate 溯源',
  );
  assert(
    root.getRelationStatus('has_pump') === 'FILTERED_OUT',
    'getRelationStatus 应与 FILTERED_OUT_WHERE 溯源一致',
  );
  const snap = root.toSnapshot();
  assert(
    snap.relationStatus?.['has_pump'] === 'FILTERED_OUT',
    'toSnapshot().relationStatus 应含 has_pump: FILTERED_OUT',
  );
  printAllResults('includeRelates 根节点 getData', tree, { nested: true });
  console.log('  getRelate("has_pump") 条数:', root.getRelate('has_pump').length);
  console.log(
    '  getRelateDiagnostic("has_pump"):',
    JSON.stringify(root.getRelateDiagnostic('has_pump'), null, 2),
  );

  console.log('[query_filters] AND 短路：首子节点为假时不应执行后续 callback');
  let andAfter = 0;
  const probeRow = {
    _id: 'probe',
    _createdAt: new Date().toISOString(),
    status: 'active',
  } as ModelRecord;
  const andShort = groupNode('AND', [
    atomNode('status', 'eq', 'never-matches'),
    callbackNode(() => {
      andAfter++;
      return true;
    }, 'after-false'),
  ]);
  const shortEv = evaluatePredicate(probeRow, andShort);
  assert(!shortEv.ok, 'AND 整体应为假');
  assert(andAfter === 0, 'AND 短路：后续 callback 不得执行');

  console.log('[query_filters] OR 短路：首子节点为真时不应执行后续 callback');
  let orAfter = 0;
  const orShort = groupNode('OR', [
    atomNode('status', 'eq', 'active'),
    callbackNode(() => {
      orAfter++;
      return false;
    }, 'after-true'),
  ]);
  const orEv = evaluatePredicate(probeRow, orShort);
  assert(orEv.ok, 'OR 整体应为真');
  assert(orAfter === 0, 'OR 短路：首真后 callback 不得执行');

  console.log('[query_filters] FilterBuilder.compose + QueryEngine.matches（独立谓词树）');
  type LevelRow = Record<string, unknown> & { level: number };
  const pc = FilterBuilder.compose<LevelRow>();
  const levelNode = pc.and(pc.is('level', 1), pc.lt('level', 10));
  const levelRow = {
    _id: 'lvl',
    _createdAt: new Date().toISOString(),
    level: 1,
  } as ModelRecord;
  assert(QueryEngine.matches(levelRow, levelNode), 'compose 树应匹配 level=1');
  assert(
    !QueryEngine.matches({ ...levelRow, level: 99 } as ModelRecord, levelNode),
    'level=99 应不匹配',
  );

  console.log('[query_filters] QueryEngine.evaluateInto + PredicateEvaluateContext');
  const evalCtx: PredicateEvaluateContext = {};
  const badAtom = atomNode('status', 'eq', 'nope');
  const evAttr = QueryEngine.evaluateInto(probeRow, badAtom, evalCtx);
  assert(!evAttr.ok, 'evaluateInto 应对不匹配行返回 false');
  assert(evalCtx.failureKind === 'ATTRIBUTE_MISMATCH', 'ctx.failureKind 应为 ATTRIBUTE_MISMATCH');
  assert(evalCtx.failedAt === badAtom, 'ctx.failedAt 应指向失败 atom');

  const evalCtx2: PredicateEvaluateContext = {};
  const orAllFalse = groupNode('OR', [
    atomNode('status', 'eq', 'x'),
    atomNode('status', 'eq', 'y'),
  ]);
  const evOr = QueryEngine.evaluateInto(probeRow, orAllFalse, evalCtx2);
  assert(!evOr.ok, 'OR 全假');
  assert(evalCtx2.failureKind === 'OR_UNSATISFIED', 'OR 全假应为 OR_UNSATISFIED');
  assert(evalCtx2.failedAt?.type === 'group', 'failedAt 应为 OR 组');

  console.log('\nquery_filters: 全部通过');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

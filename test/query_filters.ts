/**
 * QueryChain：全表起步、where / OR、relate 目标过滤、eq 流式优化、FILTERED_OUT_WHERE
 *
 * Run:  npx tsx test/query_filters.ts
 */

import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { configureModelDBStorageRoot } from '../common/storage-root-config.js';
import { AuthoringEngine } from '../src/authoring/AuthoringEngine.js';
import { ModelDBClient } from '../src/runtime/ModelDBClient.js';

const DATA_ROOT = join(process.cwd(), 'data');
const ATLAS = 'query_filter_demo';

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

async function main(): Promise<void> {
  configureModelDBStorageRoot({ storageRoot: DATA_ROOT });
  await rm(join(DATA_ROOT, ATLAS), { recursive: true, force: true });

  const eng = new AuthoringEngine({ atlas: ATLAS, storageRoot: DATA_ROOT });
  eng.quickLink('Zone', 'Pump', 'has_pump', 'in_zone');

  const Zone = eng.model('Zone');
  const Pump = eng.model('Pump');
  Zone.updateFields(new Set(['id', 'name', 'level']));
  Pump.updateFields(new Set(['id', 'zoneId', 'status', 'power']));

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
    .relate('has_pump', (p) => p.where('status', 'eq', 'active').and('power', '>', 50))
    .execute();

  assert(rows.length === 1, `应只剩 1 台泵，实际 ${rows.length}`);
  const d = rows[0]!.getData() as Record<string, unknown>;
  assert(d['id'] === 'P1', '应为 P1');

  console.log('  结果:', JSON.stringify(rows[0]!.getData()));
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
  console.log('  diagnostic:', root.getRelateDiagnostic('has_pump'));

  console.log('\nquery_filters: 全部通过');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * 管廊资产图谱「点火」脚本 — 治理态（Authoring）→ 落盘 → 查询态（Runtime）闭环。
 *
 * Run:  npx tsx test/first_run.ts
 *       npm run first-run
 */

import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { configureModelDBStorageRoot } from '../common/storage-root-config.js';
import { AuthoringEngine } from '../src/authoring/AuthoringEngine.js';
import { ModelDBClient } from '../src/runtime/ModelDBClient.js';

const DATA_ROOT = join(process.cwd(), 'data');
const PIPE_ATLAS = join(DATA_ROOT, 'pipe');

async function main(): Promise<void> {
  configureModelDBStorageRoot({ storageRoot: DATA_ROOT });
  await rm(PIPE_ATLAS, { recursive: true, force: true });

  console.log('--- 第一阶段：治理态 (Authoring) ---\n');

  const admin = new AuthoringEngine({ atlas: 'pipe', storageRoot: DATA_ROOT });

  admin.quickLink('Pump', 'Zone', 'located_in', 'contains_pump');

  const Pump = admin.model('Pump');
  const Zone = admin.model('Zone');
  const Rel = admin.relation('located_in');

  Pump.updateFields(new Set(['id', 'name', 'zoneCode']));
  Zone.updateFields(new Set(['id', 'label']));
  Rel.updateLogic('many-to-one', { sourceField: 'zoneCode', targetField: 'id' });

  console.log('正在写入物理数据 (.mld)...');
  await Zone.insert({ id: 'Z-001', label: '一号管廊区' });
  await Pump.insert({ id: 'P-101', name: '循环水泵A', zoneCode: 'Z-001' });

  console.log('正在构建拓扑关系索引 (PROTOCOL → .rid)...');
  await Rel.bind({ strategy: 'PROTOCOL' });
  await admin.flushAll();

  console.log('\n--- 第二阶段：查询态 (Runtime) ---\n');

  const client = await ModelDBClient.connect('pipe');
  const RuntimePump = client.model('Pump');

  const pumps = await RuntimePump.all();
  const pumpIds = pumps.map((r) => r._id);

  console.log(`执行链式跳转查询 [Pump(${pumpIds.length} 条) -> located_in -> Zone]...`);
  const result = await RuntimePump.query(pumpIds).relate('located_in').execute();

  console.log('\n--- 查询结果 ---');
  console.table(
    result.map((row) => {
      const d = row.getData() as Record<string, unknown>;
      return { _id: d['_id'], ...d };
    }),
  );

  console.log('\n--- [关键信息] HydratedEntity 明细 ---');
  for (let i = 0; i < result.length; i++) {
    const h = result[i]!;
    console.log(`  [${i}] getModelName: ${h.getModelName()}`);
    console.log(`      getData: ${JSON.stringify(h.getData())}`);
  }
  const dBad = await result[0]!.explainRelate('no_such_edge');
  console.log(`  explainRelate("no_such_edge"): ${JSON.stringify(dBad)}`);
  const tree = await RuntimePump.query(pumpIds)
    .relate('located_in')
    .execute({ includeRelates: true });
  console.log('  includeRelates → 根节点 toNested():');
  console.log(JSON.stringify(tree[0]?.toNested(), null, 2));

  if (result.length !== 1) {
    throw new Error(`期望 1 条 Zone 结果，实际 ${result.length}`);
  }
  const z = result[0].getData() as Record<string, unknown>;
  if (z['id'] !== 'Z-001' || z['label'] !== '一号管廊区') {
    throw new Error('链式查询未命中预期分区');
  }

  console.log('\n--- 闭环校验通过 ---');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

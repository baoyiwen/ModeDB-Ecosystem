/**
 * HydratedEntity / QueryChain 空关联溯源与 includeRelates 行为校验；
 * 并断言：AtlasRegistry 缓存 ModelEntity；合并读；`insert(..., { sync: true })` 后单文件 Vault 已落盘。
 *
 * Run:  npx tsx test/logic_integrity.ts
 *       npm run integrity
 *       npm run test:integration（第三项）
 *
 * 全部测试脚本说明见同目录 README.md
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { configureModelDBStorageRoot } from '@mode-db/common';
import { AuthoringEngine } from '../packages/core/src/authoring/AuthoringEngine.js';
import { ModelDBClient } from '../packages/core/src/runtime/ModelDBClient.js';
import {
  atlasVaultPath,
  integrationVaultAuthoringOptions,
  mutateVaultRelationData,
  useIntegrationVaultEnv,
} from './integration-vault.js';
import type { HydratedEntity } from '../packages/core/src/runtime/HydratedEntity.js';

const DATA_ROOT = join(process.cwd(), 'data');
const ATLAS = 'integrity_pipe';

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

function logDiag(label: string, d: { reason: string; message: string } | undefined): void {
  console.log(`\n  [关键信息] ${label}`);
  if (!d) {
    console.log('    (无空关联诊断 / 关联非空)');
    return;
  }
  console.log(`    reason: ${d.reason}`);
  console.log(`    message: ${d.message}`);
}

function logEntityBrief(tag: string, row: HydratedEntity): void {
  console.log(`\n  [关键信息] ${tag}`);
  console.log(`    模型: ${row.getModelName()}`);
  console.log(`    getData(): ${JSON.stringify(row.getData())}`);
  const relKeys = [...row.getRelates().keys()];
  console.log(`    getRelates 键: [${relKeys.join(', ') || '—'}]`);
}

async function main(): Promise<void> {
  configureModelDBStorageRoot({ storageRoot: DATA_ROOT });
  useIntegrationVaultEnv();
  await rm(join(DATA_ROOT, ATLAS), { recursive: true, force: true });

  console.log('[关键信息] 存储根与图谱');
  console.log(`  STORAGE_ROOT (effective): ${DATA_ROOT}`);
  console.log(`  本用例 atlas: ${ATLAS}`);

  const engine = new AuthoringEngine({
    atlas: ATLAS,
    storageRoot: DATA_ROOT,
    ...integrationVaultAuthoringOptions,
  });
  engine.quickLink('Pump', 'Zone', 'located_in', 'contains_pump');

  const Pump = engine.model('Pump');
  const Zone = engine.model('Zone');
  assert(
    engine.model('Pump') === Pump && engine.model('Zone') === Zone,
    'AtlasRegistry.model() 应缓存同一 ModelEntity 句柄（共享写缓冲）',
  );
  Pump.updateFields(['id', 'name', 'zoneCode']);
  Zone.updateFields(['id', 'label']);

  const zone = await Zone.insert({ id: 'Z-99', label: '隔离区' });
  const pump = await Pump.insert({ id: 'P-99', name: '审计泵', zoneCode: 'Z-99' });

  const zMerged = await engine.query('Zone', [zone._id]).execute();
  assert(zMerged.length === 1, '合并读：insert 后未 flushAll 应能 query 到 Zone');
  assert(zMerged[0]!.getData().id === 'Z-99', '合并读 Zone 业务 id');
  const pMerged = await engine.query('Pump', [pump._id]).execute();
  assert(pMerged.length === 1, '合并读：insert 后未 flushAll 应能 query 到 Pump');

  await Pump.insert({ id: 'P-sync', name: '强同步泵', zoneCode: 'Z-99' }, { sync: true });
  assert(
    existsSync(atlasVaultPath(DATA_ROOT, ATLAS)),
    'insert(..., { sync: true }) 后 atlas.mld 应已落盘',
  );

  const loc = engine.relation('located_in');
  loc.updateLogic('many-to-one', { sourceField: 'zoneCode', targetField: 'id' });
  await loc.bind({ strategy: 'PROTOCOL' });
  await engine.flushAll();

  // --- NOT_REGISTERED ---
  const client1 = await ModelDBClient.connect(ATLAS);
  const hPump = await client1.model('Pump').query([pump._id]).execute();
  assert(hPump.length === 1, 'flat execute 应返回 1 条 Pump');
  const root = hPump[0]!;
  const dUnknown = await root.explainRelate('does_not_exist');
  assert(dUnknown?.reason === 'NOT_REGISTERED', `NOT_REGISTERED: ${dUnknown?.message}`);
  logDiag('explainRelate("does_not_exist") → NOT_REGISTERED', dUnknown);
  logEntityBrief('扁平 execute 根实体 (Pump)', root);

  // --- NO_LINK_IN_INDEX：有定义、未写入索引的泵 ---
  const pumpBare = await Pump.insert({ id: 'P-bare', name: '无索引泵', zoneCode: 'Z-99' });
  await engine.flushAll();
  const client2 = await ModelDBClient.connect(ATLAS);
  const bareRow = await client2.model('Pump').query([pumpBare._id]).execute();
  const dNoLink = await bareRow[0]!.explainRelate('located_in');
  assert(dNoLink?.reason === 'NO_LINK_IN_INDEX', `NO_LINK_IN_INDEX: ${dNoLink?.message}`);
  logDiag('explainRelate("located_in") → NO_LINK_IN_INDEX（未 bind 的泵）', dNoLink);

  // --- FILTERED_OUT_ORPHAN：索引含幽灵 id，目标行不存在 ---
  const ghost = '00000000-0000-4000-8000-00000000dead';
  const srcKey = pump._id;
  mutateVaultRelationData(DATA_ROOT, ATLAS, 'Pump-Zone-located_in', (rid) => {
    const arr = rid.fwd[srcKey] ?? [];
    rid.fwd[srcKey] = [...arr, ghost];
  });
  console.log(
    '\n  [关键信息] 已向 Vault 内 r:Pump-Zone-located_in 注入幽灵 target id（用于 FILTERED_OUT_ORPHAN）',
  );
  console.log(`    pump._id: ${srcKey} → fwd 追加: ${ghost}`);

  const client3 = await ModelDBClient.connect(ATLAS);

  const [pumpEntity] = await client3.model('Pump').query([pump._id]).execute();
  assert(pumpEntity !== undefined, '应能加载 Pump');
  const dGhost = await pumpEntity.explainRelate('located_in');
  assert(dGhost?.reason === 'FILTERED_OUT_ORPHAN', `FILTERED_OUT_ORPHAN: ${dGhost?.message}`);
  assert(pumpEntity.getRelate('located_in').length === 1, '应保留可解析到的 Zone');
  logDiag('explainRelate("located_in") → FILTERED_OUT_ORPHAN', dGhost);
  console.log(
    `    getRelate("located_in") 条数: ${pumpEntity.getRelate('located_in').length}（仅可解析的 Zone）`,
  );

  const chainZones = await client3.model('Pump').query([pump._id]).relate('located_in').execute();
  assert(chainZones.length === 1, '链式末端仍只返回真实 Zone');
  assert(chainZones[0]!.getData()._id === zone._id, '末端 Zone _id 一致');
  console.log('\n  [关键信息] 链式 execute 末端 Zone');
  console.log(`    getModelName: ${chainZones[0]!.getModelName()}`);
  console.log(`    getData: ${JSON.stringify(chainZones[0]!.getData())}`);

  // --- includeRelates 级联 ---
  const tree = await client3
    .model('Pump')
    .query([pump._id])
    .relate('located_in')
    .execute({ includeRelates: true });
  assert(tree.length === 1, 'includeRelates 根为 Pump');
  const pumpRoot = tree[0]!;
  assert(pumpRoot.getModelName() === 'Pump', '根模型名');
  assert(
    pumpRoot.getRelateDiagnostic('located_in')?.reason === 'FILTERED_OUT_ORPHAN',
    'includeRelates 路径应记录 FILTERED_OUT_ORPHAN（索引含幽灵 id）',
  );
  const nested = pumpRoot.getRelate('located_in');
  assert(nested.length === 1, '嵌套 located_in 一条 Zone');
  assert(nested[0]!.getData()._id === zone._id, '嵌套实体为同一分区');
  const shape = pumpRoot.toNested();
  assert(shape['relates'] !== undefined, 'toNested 含 relates');
  const relObj = shape['relates'] as Record<string, unknown[]>;
  assert(Array.isArray(relObj['located_in']), 'relates.located_in 为数组');

  console.log('\n  [关键信息] includeRelates + toNested() 级联结构');
  console.log(JSON.stringify(pumpRoot.toNested(), null, 2));
  console.log(
    `    getRelateDiagnostic("located_in"): ${JSON.stringify(pumpRoot.getRelateDiagnostic('located_in'))}`,
  );

  console.log('\nlogic_integrity: 全部断言通过');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

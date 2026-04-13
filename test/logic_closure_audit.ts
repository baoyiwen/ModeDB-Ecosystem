/**
 * 逻辑闭环审计 — Atlas 隔离、双向索引、多级链式查询、Runtime 只读
 *
 * Run:  npx tsx test/logic_closure_audit.ts
 *       npm run audit
 *       npm run test:integration（末项）
 *
 * 全部测试脚本说明见同目录 README.md
 */

import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { configureModelDBStorageRoot } from '../common/storage-root-config.js';
import type { RelationIndexData } from '../common/types.js';
import { AuthoringEngine } from '../src/authoring/AuthoringEngine.js';
import { ModelDBClient } from '../src/runtime/ModelDBClient.js';
import {
  atlasVaultPath,
  INTEGRATION_VAULT_SECRET,
  integrationVaultAuthoringOptions,
  loadVaultModelBlob,
  loadVaultRelationData,
  useIntegrationVaultEnv,
} from './integration-vault.js';

function dataRoot(): string {
  const env = process.env.STORAGE_ROOT?.trim() || process.env.MODEL_DB_STORAGE_ROOT?.trim();
  return env && env.length > 0 ? resolve(env) : join(process.cwd(), 'data');
}

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

/** 校验 .rid JSON 中 fwd / rev 边一一成对 */
function assertBidirectionalRid(data: RelationIndexData, label: string): void {
  for (const [srcId, targets] of Object.entries(data.fwd)) {
    for (const tgtId of targets) {
      const rev = data.rev[tgtId];
      assert(
        rev !== undefined && rev.includes(srcId),
        `${label}: rev["${tgtId}"] 应包含 "${srcId}"`,
      );
    }
  }
  for (const [tgtId, sources] of Object.entries(data.rev)) {
    for (const srcId of sources) {
      const fwd = data.fwd[srcId];
      assert(
        fwd !== undefined && fwd.includes(tgtId),
        `${label}: fwd["${srcId}"] 应包含 "${tgtId}"`,
      );
    }
  }
}

async function runAudit(): Promise<void> {
  const root = dataRoot();
  configureModelDBStorageRoot({ storageRoot: root });
  useIntegrationVaultEnv();

  const pipeAtlas = join(root, 'pipe_system');
  const tranAtlas = join(root, 'tran_system');
  await rm(pipeAtlas, { recursive: true, force: true });
  await rm(tranAtlas, { recursive: true, force: true });

  console.log('--- Model DB 2.0 逻辑闭环审计开始 ---\n');
  console.log('[关键信息] 数据目录');
  console.log(`  STORAGE_ROOT: ${root}`);
  console.log('  图谱: pipe_system, tran_system\n');

  // --- 审计 1: 物理 / 图谱隔离 ---
  console.log('[审计 1/4] 验证 Atlas 物理隔离...');

  const pipeAdmin = new AuthoringEngine({
    atlas: 'pipe_system',
    storageRoot: root,
    ...integrationVaultAuthoringOptions,
  });
  const tranAdmin = new AuthoringEngine({
    atlas: 'tran_system',
    storageRoot: root,
    ...integrationVaultAuthoringOptions,
  });

  pipeAdmin.registerModel('Pump');
  tranAdmin.registerModel('Train');

  await pipeAdmin.model('Pump').insert({});
  await tranAdmin.model('Train').insert({});
  await Promise.all([pipeAdmin.flushAll(), tranAdmin.flushAll()]);

  const pipeVaultFile = atlasVaultPath(root, 'pipe_system');
  const tranVaultFile = atlasVaultPath(root, 'tran_system');
  assert(existsSync(pipeVaultFile), 'pipe_system 应存在 atlas.mld');
  assert(existsSync(tranVaultFile), 'tran_system 应存在 atlas.mld');
  assert(
    loadVaultModelBlob(root, 'pipe_system', 'Train', INTEGRATION_VAULT_SECRET).trim().length === 0,
    'pipe vault 不应含 Train 模型 blob（跨库污染）',
  );
  assert(
    loadVaultModelBlob(root, 'tran_system', 'Pump', INTEGRATION_VAULT_SECRET).trim().length === 0,
    'tran vault 不应含 Pump 模型 blob（跨库污染）',
  );

  let crossLeak = false;
  try {
    tranAdmin.model('Pump');
    crossLeak = true;
  } catch {
    /* expected */
  }
  assert(!crossLeak, 'tran 侧不应能 model("Pump")');

  console.log('  通过：目录与注册表隔离正常。');
  console.log('  [关键信息] Vault 路径');
  console.log(`    pipe atlas.mld: ${pipeVaultFile} exists=${existsSync(pipeVaultFile)}`);
  console.log(`    tran atlas.mld: ${tranVaultFile} exists=${existsSync(tranVaultFile)}`);
  console.log('');

  // --- 审计 2: OO + 双向索引（真实 .rid 格式）---
  console.log('[审计 2/4] 验证实体自治与双向守恒...');

  pipeAdmin.quickLink('Zone', 'Pump', 'has_pump', 'in_zone');
  const Zone = pipeAdmin.model('Zone');
  const Pump = pipeAdmin.model('Pump');

  Zone.updateFields(['id', 'name']);
  Pump.updateFields(['id', 'name', 'zoneId']);

  const zoneRow = await Zone.insert({ id: 'Z1', name: '核心区' });
  await Pump.insert({ id: 'P1', name: '1号泵', zoneId: 'Z1' });

  const Rel = pipeAdmin.relation('has_pump');
  Rel.updateLogic('many-to-one', { sourceField: 'id', targetField: 'zoneId' });
  await Rel.bind({ strategy: 'PROTOCOL' });
  await pipeAdmin.flushAll();

  const ridKey = 'Zone-Pump-has_pump';
  assert(existsSync(pipeVaultFile), 'flush 后 pipe atlas.mld 仍存在');

  const ridJson = loadVaultRelationData(root, 'pipe_system', ridKey, INTEGRATION_VAULT_SECRET);
  const fwdEdges = Object.values(ridJson.fwd).reduce((n, a) => n + a.length, 0);
  const revEdges = Object.values(ridJson.rev).reduce((n, a) => n + a.length, 0);
  assert(fwdEdges === revEdges && fwdEdges > 0, '正向与逆向边条数应相等且大于 0');
  assertBidirectionalRid(ridJson, 'has_pump');

  console.log(`  通过：双向守恒（fwd 边=${fwdEdges}, rev 边=${revEdges}）。`);
  console.log('  [关键信息] Vault 内关系索引');
  console.log(`    key: r:${ridKey}`);
  console.log(
    `    fwd keys: ${Object.keys(ridJson.fwd).length}, rev keys: ${Object.keys(ridJson.rev).length}`,
  );
  console.log('');

  // --- 审计 3: 三级链式查询（Runtime）---
  console.log('[审计 3/4] 验证三级跳转 Zone -> has_pump -> Pump -> has_sensor -> Sensor...');

  pipeAdmin.quickLink('Pump', 'Sensor', 'has_sensor', 'of_pump');
  const Sensor = pipeAdmin.model('Sensor');
  Sensor.updateFields(['id', 'name', 'pumpId']);

  await Sensor.insert({ id: 'S1', name: '压力传感器', pumpId: 'P1' });

  const SensorRel = pipeAdmin.relation('has_sensor');
  SensorRel.updateLogic('many-to-one', { sourceField: 'id', targetField: 'pumpId' });
  await SensorRel.bind({ strategy: 'PROTOCOL' });
  await pipeAdmin.flushAll();

  const client = await ModelDBClient.connect('pipe_system');
  const zoneId = zoneRow._id;

  const result = await client
    .model('Zone')
    .query([zoneId])
    .relate('has_pump')
    .relate('has_sensor')
    .execute();

  assert(result.length === 1, `期望 1 条 Sensor，实际 ${result.length}`);
  const s0 = result[0].getData() as Record<string, unknown>;
  assert(s0['id'] === 'S1', '应解析到 id=S1 的传感器');

  console.log('  通过：Runtime 三级链式查询闭环。');
  console.log('  [关键信息] 三级链末端 HydratedEntity');
  console.log(`    getModelName: ${result[0]!.getModelName()}`);
  console.log(`    getData: ${JSON.stringify(result[0]!.getData())}`);

  const nested = await client
    .model('Zone')
    .query([zoneId])
    .relate('has_pump')
    .relate('has_sensor')
    .execute({ includeRelates: true });
  console.log('  [关键信息] includeRelates（Zone 为根） toNested():');
  console.log(JSON.stringify(nested[0]?.toNested(), null, 2));
  console.log('');

  // --- 审计 4: Runtime 只读 ---
  console.log('[审计 4/4] 验证 Runtime 只读安全性...');

  const runtimePump = client.model('Pump') as unknown as Record<string, unknown>;
  assert(typeof runtimePump['insert'] === 'undefined', 'Runtime 不应暴露 insert');
  assert(typeof runtimePump['bind'] === 'undefined', 'Runtime 不应暴露 bind');
  assert(typeof runtimePump['updateFields'] === 'undefined', 'Runtime 不应暴露 updateFields');

  console.log('  通过：Runtime 无写入型 API。');
  console.log('  [关键信息] Runtime Pump 句柄上缺失的方法（应为 undefined）');
  console.log(
    `    insert=${String(runtimePump['insert'])}, bind=${String(runtimePump['bind'])}, updateFields=${String(runtimePump['updateFields'])}`,
  );
  console.log('');

  console.log('--- 所有逻辑闭环审计完成 ---');
}

runAudit().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error('\n审计中断:', msg);
  process.exit(1);
});

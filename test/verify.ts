/**
 * 端到端集成验证 — 管廊 (pipe) / 轨道 (tran) 双图谱隔离 + 滞后字段 + PROTOCOL 绑定 + Runtime 只读
 *
 * Run:  npx tsx test/verify.ts
 *       npm run test:integration（首步，会清空整个默认 data/）
 *
 * 全部测试脚本说明见同目录 README.md
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { configureModelDBStorageRoot } from '@mode-db/common';
import type { RelationIndexData } from '@mode-db/common';
import { AuthoringEngine } from '../authoring/engine.js';
import { ModelDBClient } from '../runtime/client.js';
import {
  atlasVaultPath,
  integrationVaultAuthoringOptions,
  loadVaultRelationData,
  useIntegrationVaultEnv,
} from './integration-vault.js';

const DATA_ROOT = join(process.cwd(), 'data');

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${label}`);
    failed++;
  }
}

function section(title: string): void {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
}

/**
 * 校验 .rid 中每条正向边在逆向表中成对出现，反之亦然。
 */
function assertRidForwardReversePaired(data: RelationIndexData, label: string): void {
  for (const [srcId, targets] of Object.entries(data.fwd)) {
    for (const tgtId of targets) {
      const revList = data.rev[tgtId];
      assert(
        revList !== undefined && revList.includes(srcId),
        `${label}: rev["${tgtId}"] ∋ "${srcId}"（对应 fwd["${srcId}"] → "${tgtId}"）`,
      );
    }
  }
  for (const [tgtId, sources] of Object.entries(data.rev)) {
    for (const srcId of sources) {
      const fwdList = data.fwd[srcId];
      assert(
        fwdList !== undefined && fwdList.includes(tgtId),
        `${label}: fwd["${srcId}"] ∋ "${tgtId}"（对应 rev["${tgtId}"] ← "${srcId}"）`,
      );
    }
  }
}

function assertThrows(fn: () => void, label: string): void {
  try {
    fn();
    console.error(`  ✗ FAIL: ${label} (expected throw)`);
    failed++;
  } catch {
    console.log(`  ✓ ${label}`);
    passed++;
  }
}

async function main(): Promise<void> {
  configureModelDBStorageRoot({ storageRoot: DATA_ROOT });
  useIntegrationVaultEnv();
  await rm(DATA_ROOT, { recursive: true, force: true });

  // ═══════════════════════════════════════════════════════════════════════
  // 1. 双图谱：pipe（管廊）与 tran（轨道）独立目录
  // ═══════════════════════════════════════════════════════════════════════

  section('1. 多图谱隔离 — pipe / tran 独立目录与注册');

  const pipe = new AuthoringEngine({
    atlas: 'pipe',
    storageRoot: DATA_ROOT,
    ...integrationVaultAuthoringOptions,
  });
  const tran = new AuthoringEngine({
    atlas: 'tran',
    storageRoot: DATA_ROOT,
    ...integrationVaultAuthoringOptions,
  });

  const pipeRoot = join(DATA_ROOT, 'pipe');
  const tranRoot = join(DATA_ROOT, 'tran');
  assert(existsSync(pipeRoot), '物理目录存在 data/pipe');
  assert(existsSync(tranRoot), '物理目录存在 data/tran');
  assert(existsSync(atlasVaultPath(DATA_ROOT, 'pipe')), 'pipe/atlas.mld（单文件 Vault）已创建');
  assert(existsSync(atlasVaultPath(DATA_ROOT, 'tran')), 'tran/atlas.mld（单文件 Vault）已创建');
  assert(!existsSync(join(pipeRoot, 'models')), 'pipe 下无 models/ 分文件目录');
  assert(!existsSync(join(pipeRoot, 'relations')), 'pipe 下无 relations/ 分文件目录');

  // pipe：管廊 — Pump + Zone；tran：轨道 — 仅 Train
  pipe.quickLink('Pump', 'Zone', 'located_in', 'contains_pump');
  tran.registerModel('Train');

  assertThrows(() => {
    tran.model('Pump');
  }, 'tran 图谱无法获取 pipe 的 Pump 句柄（应抛错）');
  assertThrows(() => {
    pipe.model('Train');
  }, 'pipe 图谱无法获取 tran 的 Train 句柄（应抛错）');

  assert(
    !existsSync(join(tranRoot, 'models', 'Pump.mld')),
    'tran 下不存在分文件 Pump.mld（Vault 模式无 models/）',
  );
  assert(
    !existsSync(join(pipeRoot, 'models', 'Train.mld')),
    'pipe 下不存在分文件 Train.mld（Vault 模式无 models/）',
  );

  console.log('  ✔ pipe / tran 目录与模型命名空间互不干扰');

  // ═══════════════════════════════════════════════════════════════════════
  // 2. 滞后定义：骨架 quickLink → 先插入 → updateFields 补全字段
  // ═══════════════════════════════════════════════════════════════════════

  section('2. 滞后定义 — 骨架插入后 updateFields 补全（pipe: Pump/Zone）');

  const Pump = pipe.model('Pump');
  const Zone = pipe.model('Zone');

  const skeletonPump = await Pump.insert({ name: '预留泵位', zoneCode: 'Z-A' });
  assert(
    (skeletonPump as Record<string, unknown>)['name'] === undefined,
    '补全前：未声明字段被过滤（name / zoneCode 均不落盘）',
  );

  Pump.updateFields(['name', 'zoneCode']);
  Zone.updateFields(['code', 'label']);

  const pump1 = await Pump.insert({ name: '主循环泵-1', zoneCode: 'Z-A' });
  const zoneA = await Zone.insert({ code: 'Z-A', label: '管廊分区 A' });
  assert((pump1 as Record<string, unknown>)['name'] === '主循环泵-1', '补全后：name 正确写入');

  const TrainModel = tran.model('Train');
  const skTrain = await TrainModel.insert({ lineNo: 'L1' });
  assert(
    (skTrain as Record<string, unknown>)['lineNo'] === undefined,
    'tran：补全前 lineNo 被过滤',
  );
  TrainModel.updateFields(['lineNo']);
  const train1 = await TrainModel.insert({ lineNo: '轨道一号线' });
  assert(
    (train1 as Record<string, unknown>)['lineNo'] === '轨道一号线',
    'tran：补全后 lineNo 写入',
  );

  await tran.flushAll();
  assert(existsSync(atlasVaultPath(DATA_ROOT, 'tran')), 'tran 单文件 atlas.mld 已落盘');

  console.log(`  Pump1: ${pump1._id}  ZoneA: ${zoneA._id}  Train1: ${train1._id}`);

  // ═══════════════════════════════════════════════════════════════════════
  // 3. PROTOCOL：水泵与分区按协议字段匹配绑定 + .rid 正逆向成对
  // ═══════════════════════════════════════════════════════════════════════

  section('3. PROTOCOL 绑定 — located_in（zoneCode ↔ code）与 Vault 内 r:* 成对校验');

  const locRel = pipe.relation('located_in');
  locRel.updateLogic('many-to-one', { sourceField: 'zoneCode', targetField: 'code' });
  await locRel.bind({ strategy: 'PROTOCOL' });
  await pipe.flushAll();

  assert(existsSync(atlasVaultPath(DATA_ROOT, 'pipe')), 'pipe atlas.mld 存在（含关系索引）');

  const ridData = loadVaultRelationData(DATA_ROOT, 'pipe', 'Pump-Zone-located_in');
  assert(
    Object.keys(ridData.fwd).length > 0 && Object.keys(ridData.rev).length > 0,
    '.rid 中 fwd / rev 均非空',
  );
  assertRidForwardReversePaired(ridData, 'located_in');

  const stats = await locRel.getStats();
  assert(stats.totalLinks >= 1, 'PROTOCOL：至少 1 条成对链接');
  console.log(`  located_in stats: ${JSON.stringify(stats)}`);

  const authoredFwd = await Pump.find([pump1._id]).relate('located_in').execute();
  assert(authoredFwd.length === 1, 'Authoring：Pump → Zone 查询为 1 条');
  assert(authoredFwd[0].getData()._id === zoneA._id, 'Authoring：绑定目标为分区 Z-A');

  // ═══════════════════════════════════════════════════════════════════════
  // 4. Runtime：第三方 connect('pipe') + 链式查询 + 无 insert
  // ═══════════════════════════════════════════════════════════════════════

  section('4. Runtime 安全 — ModelDBClient.connect("pipe") 只读');

  const client = await ModelDBClient.connect('pipe');
  assert(client.atlas === 'pipe', 'client.atlas === "pipe"');

  const rtPump = client.model('Pump');
  const chainRows = await rtPump.query([pump1._id]).relate('located_in').execute();
  assert(chainRows.length === 1, 'Runtime：query([id]).relate("located_in").execute() 返回 1 行');
  assert(chainRows[0].getData()._id === zoneA._id, 'Runtime：链式查询命中同一 Zone');

  console.log('\n  [关键信息] HydratedEntity（Runtime 链式查询末端）');
  const hz = chainRows[0]!;
  console.log(`    模型名: ${hz.getModelName()}`);
  console.log(`    getData(): ${JSON.stringify(hz.getData())}`);
  console.log(
    `    getRelates 键: [${[...hz.getRelates().keys()].join(', ') || '—'}]（扁平 execute 通常为空）`,
  );
  const dFake = await hz.explainRelate('nonexistent_relation');
  console.log(`    explainRelate("nonexistent_relation"): ${JSON.stringify(dFake)}`);

  const withTree = await rtPump
    .query([pump1._id])
    .relate('located_in')
    .execute({ includeRelates: true });
  console.log('  [关键信息] includeRelates: 根实体 toNested()');
  console.log(JSON.stringify(withTree[0]?.toNested(), null, 2));

  const rtAsRecord = rtPump as unknown as Record<string, unknown>;
  assert(typeof rtAsRecord['insert'] === 'undefined', 'Runtime：ModelEntity 无 insert');
  assert(typeof rtAsRecord['updateFields'] === 'undefined', 'Runtime：无 updateFields');
  assert(typeof rtAsRecord['bind'] === 'undefined', 'Runtime：无 bind');

  assertThrows(() => {
    tran.model('Pump');
  }, '隔离：Runtime 会话不改变 tran 仍无法访问 Pump');

  console.log('  ✔ Runtime 链式查询与只读约束通过');

  // ═══════════════════════════════════════════════════════════════════════
  // 汇总
  // ═══════════════════════════════════════════════════════════════════════

  section('测试结果汇总');
  console.log(`  通过: ${passed}`);
  console.log(`  失败: ${failed}`);
  console.log();

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

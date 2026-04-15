/**
 * 多维分析管道：pivot / groupBy、aggregate / compute、customReduce、execute() → AnalysisResult
 *
 * Run: `npm run transform` 或 `npx tsx test/transform_aggregate.ts`
 *
 * 全部测试说明见 test/README.md
 */

import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { configureModelDBStorageRoot } from '@mode-db/common';
import { AuthoringEngine } from '../packages/core/src/authoring/AuthoringEngine.js';
import { integrationVaultAuthoringOptions, useIntegrationVaultEnv } from './integration-vault.js';
import { ModelDBClient } from '../packages/core/src/runtime/ModelDBClient.js';
import type { HydratedEntity } from '../packages/core/src/runtime/HydratedEntity.js';
import {
  Aggregator,
  AggregationProtocol,
  BucketAggregator,
  PIVOT_UNLINKED_KEY,
  PivotTable,
  StatAccumulator,
  isAnalysisResult,
  isMetricsLeafShape,
  isTraceableNull,
  pivotSegmentKey,
  TRACEABLE_REASON_ALL_MISSING,
  type AnalysisBucketMetadataRow,
} from '../packages/core/src/runtime/transform-engine.js';

const DATA_ROOT = join(process.cwd(), 'data');
const ATLAS = 'transform_agg_demo';
/** 审计项 8–10 专用图谱（与 demo 数据隔离） */
const ATLAS_AUDIT = 'transform_audit_pipeline';

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

/** 流式 StatAccumulator / BucketAggregator：missingCount 与 Welford 样本量 */
function assertStreamingAccumulatorContract(): void {
  const s = new StatAccumulator();
  s.add(null);
  s.add(undefined);
  s.add(Number.NaN);
  s.add(10);
  s.add(20);
  assert(s.missingCount === 3 && s.validCount === 2, 'missing 不计入 n');
  assert(Math.abs((s.arithmeticMean ?? 0) - 15) < 1e-12, 'avg 仅用有效样本');

  const b = new BucketAggregator({ x: AggregationProtocol.AVG, n: AggregationProtocol.COUNT });
  b.ingest({ x: null, n: 0 });
  b.ingest({ x: 4, n: 0 });
  assert(b.missingCountsByField().x === 1, 'BucketAggregator 透传 missingCount');
  const f = b.finalize();
  assert((f.x as number) === 4 && f.n === 2, '单桶流式 AVG/COUNT');
}

/** 透视树中间层：子节点为指标叶子（扁平聚合键）的键，即下一维分组值 */
function leafKeysUnder(node: Record<string, unknown>): string[] {
  return Object.keys(node).filter((k) => {
    const v = node[k];
    return v !== null && typeof v === 'object' && !Array.isArray(v) && isMetricsLeafShape(v);
  });
}

/**
 * 审计项 8：多级分组结构（3 年 × 2 国 → 第一层 3 键、第二层各 2 键）
 * 审计项 9：总体方差 σ² = Σ(x−μ)²/n，与 [10,20,30] 手算一致
 * 审计项 10：级联字段 `in_zone.label` 跨模型取键并聚合
 */
async function runTransformAudits(storageRoot: string): Promise<void> {
  await rm(join(storageRoot, ATLAS_AUDIT), { recursive: true, force: true });

  const eng = new AuthoringEngine({
    atlas: ATLAS_AUDIT,
    storageRoot,
    ...integrationVaultAuthoringOptions,
  });
  eng.quickLink('Zone', 'Pump', 'has_pump', 'in_zone');

  const Zone = eng.model('Zone');
  const Pump = eng.model('Pump');
  Zone.updateFields(['id', 'label', 'tier']);
  Pump.updateFields(['id', 'zoneId', 'year', 'country', 'population', 'metricV', 'varBucket']);

  await Zone.insert({ id: 'ZN', label: '华北', tier: 1 });
  await Zone.insert({ id: 'ZS', label: '华南', tier: 2 });

  const pivotRows: Array<{
    id: string;
    zoneId: string;
    year: number;
    country: string;
    population: number;
  }> = [
    { id: 'A8_2018_CN', zoneId: 'ZN', year: 2018, country: 'CN', population: 1 },
    { id: 'A8_2018_US', zoneId: 'ZN', year: 2018, country: 'US', population: 1 },
    { id: 'A8_2019_CN', zoneId: 'ZS', year: 2019, country: 'CN', population: 1 },
    { id: 'A8_2019_US', zoneId: 'ZS', year: 2019, country: 'US', population: 1 },
    { id: 'A8_2020_CN', zoneId: 'ZN', year: 2020, country: 'CN', population: 1 },
    { id: 'A8_2020_US', zoneId: 'ZN', year: 2020, country: 'US', population: 1 },
  ];
  for (const r of pivotRows) {
    await Pump.insert({ ...r });
  }

  await Pump.insert({
    id: 'ORPH',
    zoneId: 'NO_SUCH_ZONE',
    year: 2017,
    country: 'CN',
    population: 99,
  });

  await Pump.insert({
    id: 'A9_1',
    zoneId: 'ZN',
    year: 2099,
    country: 'VAR',
    population: 0,
    metricV: 10,
    varBucket: 'only',
  });
  await Pump.insert({
    id: 'A9_2',
    zoneId: 'ZN',
    year: 2099,
    country: 'VAR',
    population: 0,
    metricV: 20,
    varBucket: 'only',
  });
  await Pump.insert({
    id: 'A9_3',
    zoneId: 'ZN',
    year: 2099,
    country: 'VAR',
    population: 0,
    metricV: 30,
    varBucket: 'only',
  });

  const rel = eng.relation('in_zone');
  rel.updateLogic('many-to-one', { sourceField: 'id', targetField: 'zoneId' });
  await rel.bind({ strategy: 'PROTOCOL' });
  await eng.flushAll();

  const client = await ModelDBClient.connect(ATLAS_AUDIT);

  console.log('[审计项 8] pivot(year,country) 结构：第一层 3 键、第二层各 2 键');
  const audit8 = await client
    .model('Pump')
    .query()
    .between('year', 2018, 2020)
    .pivot(['year', 'country'])
    .compute({ population: 'sum' })
    .execute();
  assert(isAnalysisResult(audit8), '审计8: AnalysisResult');
  const tree8 = audit8.asTree() as Record<string, unknown>;
  const level1Keys = Object.keys(tree8).sort((a, b) => Number(a) - Number(b));
  assert(
    level1Keys.length === 3,
    `审计8: 第一层应为 3 个年份键，实际 ${level1Keys.length}: ${level1Keys.join(',')}`,
  );
  assert(level1Keys.join(',') === '2018,2019,2020', '审计8: 年份键集合');
  for (const yk of level1Keys) {
    const sub = tree8[yk] as Record<string, unknown>;
    const leaves = leafKeysUnder(sub);
    assert(leaves.length === 2, `审计8: ${yk} 下应有 2 个国标叶子，实际 ${leaves.length}`);
    const sorted = [...leaves].sort();
    assert(
      sorted[0] === 'CN' && sorted[1] === 'US',
      `审计8: ${yk} 下键应为 CN/US，实际 ${sorted.join(',')}`,
    );
  }

  console.log('[审计项 9] 方差 [10,20,30] 总体方差 σ² = 200/3');
  const audit9 = await client
    .model('Pump')
    .query()
    .where('varBucket', 'eq', 'only')
    .groupBy(['varBucket'])
    .compute({ metricV: 'variance' })
    .execute();
  assert(isAnalysisResult(audit9), '审计9: AnalysisResult');
  const row9 = audit9.asMatrix().find((r: Record<string, unknown>) => r.varBucket === 'only');
  assert(row9 !== undefined, '审计9: 应有 varBucket=only 行');
  const gotV = row9!.metricV as number;
  const mean = (10 + 20 + 30) / 3;
  const expectedVar = ((10 - mean) ** 2 + (20 - mean) ** 2 + (30 - mean) ** 2) / 3;
  assert(Math.abs(expectedVar - 200 / 3) < 1e-12, '审计9: 手算公式基准');
  assert(
    Math.abs(gotV - expectedVar) < 1e-9,
    `审计9: 引擎方差 ${gotV} 与公式 ${expectedVar} 不一致`,
  );

  console.log('[审计项 10] in_zone.label 跨模型分组键 + 聚合');
  const audit10 = await client
    .model('Pump')
    .query()
    .groupBy(['in_zone.label'])
    .compute({ population: 'sum' })
    .execute();
  assert(isAnalysisResult(audit10), '审计10: AnalysisResult');
  const rows10 = audit10.asMatrix();
  const north = rows10.find((r: Record<string, unknown>) => r['in_zone.label'] === '华北');
  const south = rows10.find((r: Record<string, unknown>) => r['in_zone.label'] === '华南');
  assert(north !== undefined && south !== undefined, '审计10: 应能解析 Zone.label 两个分区');
  assert(north!.population === 4, '审计10: 华北 4 行 population 和为 4');
  assert(south!.population === 2, '审计10: 华南 2 行 population 和为 2');

  console.log('[递归透视] in_zone 断链 → __unlinked__');
  const rtAudit = eng.createRuntime();
  const br = ModelDBClient.fromContext(rtAudit);
  const allHydrated = (await br.model('Pump').query().execute({
    includeRelates: true,
  })) as HydratedEntity[];
  const withUnl = await PivotTable.nestedTreeFromHydrated(
    allHydrated,
    ['year', 'in_zone.label'],
    'Pump',
    rtAudit.registry,
    { population: 'sum' },
  );
  const y2017 = withUnl['2017'] as Record<string, unknown>;
  const unl = y2017[PIVOT_UNLINKED_KEY] as Record<string, unknown>;
  assert(unl !== undefined && unl.population === 99, 'NO_LINK 归入 __unlinked__');
}

async function main(): Promise<void> {
  configureModelDBStorageRoot({ storageRoot: DATA_ROOT });
  useIntegrationVaultEnv();
  assertStreamingAccumulatorContract();
  await rm(join(DATA_ROOT, ATLAS), { recursive: true, force: true });

  const eng = new AuthoringEngine({
    atlas: ATLAS,
    storageRoot: DATA_ROOT,
    ...integrationVaultAuthoringOptions,
  });
  eng.quickLink('Zone', 'Pump', 'has_pump', 'in_zone');

  const Zone = eng.model('Zone');
  const Pump = eng.model('Pump');
  Zone.updateFields(['id', 'label', 'tier']);
  Pump.updateFields(['id', 'zoneId', 'year', 'country', 'population', 'growthRate']);

  await Zone.insert({ id: 'Z1', label: '东一区', tier: 1 });
  await Zone.insert({ id: 'Z2', label: '西二区', tier: 2 });

  await Pump.insert({
    id: 'R1',
    zoneId: 'Z1',
    year: 2020,
    country: 'CN',
    population: 1000,
    growthRate: 0.02,
  });
  await Pump.insert({
    id: 'R2',
    zoneId: 'Z1',
    year: 2020,
    country: 'CN',
    population: 500,
    growthRate: 0.03,
  });
  await Pump.insert({
    id: 'R3',
    zoneId: 'Z2',
    year: 2021,
    country: 'US',
    population: 800,
    growthRate: 0.01,
  });

  const rel = eng.relation('in_zone');
  rel.updateLogic('many-to-one', { sourceField: 'id', targetField: 'zoneId' });
  await rel.bind({ strategy: 'PROTOCOL' });
  await eng.flushAll();

  const client = await ModelDBClient.connect(ATLAS);

  console.log(
    '[transform_aggregate] PivotTable：HydratedEntity[] 递归 + 叶 StatAccumulator + in_zone 路径',
  );
  const rtCtx = eng.createRuntime();
  const bridge = ModelDBClient.fromContext(rtCtx);
  const hydratedRows = (await bridge.model('Pump').query().execute({
    includeRelates: true,
  })) as HydratedEntity[];
  const nestedH = await PivotTable.nestedTreeFromHydrated(
    hydratedRows,
    ['year', 'country'],
    'Pump',
    rtCtx.registry,
    { population: 'sum', n: 'count' },
  );
  const nh2020 = nestedH['2020'] as Record<string, unknown>;
  const nhCn = nh2020['CN'] as Record<string, unknown>;
  assert(nhCn.population === 1500 && nhCn.n === 2, '递归透视 year×country');

  const nested3 = await PivotTable.nestedTreeFromHydrated(
    hydratedRows,
    ['year', 'in_zone.label', 'country'],
    'Pump',
    rtCtx.registry,
    { population: 'sum' },
  );
  const z2020 = nested3['2020'] as Record<string, unknown>;
  const zEast = z2020['东一区'] as Record<string, unknown>;
  const zCn = zEast['CN'] as Record<string, unknown>;
  assert(zCn.population === 1500, '年 × in_zone.label × 国');

  const builder = PivotTable.createHydratedBuilder(['year', 'country'], 'Pump', rtCtx.registry, {
    population: 'sum',
  });
  await builder.ingestAll(hydratedRows);
  const leafAcc = builder.getLeafAggregatorAtPath([pivotSegmentKey(2020), pivotSegmentKey('CN')]);
  assert(leafAcc !== undefined, '叶 BucketAggregator');
  const accPop = leafAcc!.statAccumulatorsByField().population;
  assert(
    accPop !== null && accPop.validCount === 2 && accPop.sumTotal === 1500,
    '叶上 StatAccumulator 流式状态',
  );

  console.log('[transform_aggregate] 多级 groupBy + compute + execute → asTree()');
  const treeReport = await client
    .model('Pump')
    .query()
    .groupBy(['year', 'country'])
    .compute({ population: 'sum', growthRate: 'avg', n: 'count' })
    .execute();

  assert(isAnalysisResult(treeReport), '透视应返回 AnalysisResult');
  const t = treeReport.asTree() as Record<string, unknown>;
  const y2020 = t['2020'] as Record<string, unknown>;
  const cn = y2020['CN'] as Record<string, unknown>;
  assert(cn.population === 1500, 'CN 2020 population sum');
  assert(cn.n === 2, 'CN 2020 count');
  assert(Math.abs((cn.growthRate as number) - 0.025) < 1e-9, 'CN 2020 growth avg');

  console.log('[transform_aggregate] aggregate 多算子 + getMetadata + asFlatTable');
  const multi = await client
    .model('Pump')
    .query()
    .groupBy(['year', 'country'])
    .aggregate({ population: ['sum', 'avg'], n: 'count' })
    .execute();
  assert(isAnalysisResult(multi), 'AnalysisResult multi-op');
  const flatMulti = multi.asFlatTable();
  const cnAgg = flatMulti.find(
    (r: Record<string, unknown>) => r.year === 2020 && r.country === 'CN',
  );
  assert(cnAgg !== undefined, 'flat CN 2020');
  assert(cnAgg!.sum_population === 1500, 'sum_population');
  assert((cnAgg!.avg_population as number) === 750, 'avg_population');
  assert(cnAgg!.n === 2, 'count n');
  const metaMulti = multi.getMetadata();
  assert(metaMulti.pipeline === 'filter_then_group_then_aggregate', 'pipeline 闭环');
  const traceMulti = multi.getTraceability();
  assert(traceMulti.summary.bucketsWithUnlinkedPath >= 0, 'getTraceability 汇总');
  const bCN = metaMulti.buckets.find(
    (b: AnalysisBucketMetadataRow) =>
      b.dimensionValues[0] === 2020 && b.dimensionValues[1] === 'CN',
  );
  assert(
    bCN !== undefined && bCN.metrics['sum_population']!.validSampleCount === 2,
    'meta 有效样本',
  );
  assert(bCN!.metrics['sum_population']!.missingSampleCount === 0, 'meta 缺失样本');

  console.log(JSON.stringify(treeReport.asTree(), null, 2));

  console.log('[transform_aggregate] asMatrix() + stdDev');
  const flatReport = await client
    .model('Pump')
    .query()
    .groupBy(['country'])
    .compute({ population: 'sum', growthRate: 'stdDev' })
    .execute();

  assert(isAnalysisResult(flatReport), 'AnalysisResult');
  const rows = flatReport.asMatrix();
  assert(rows.length >= 2, 'flat 行数');
  const cnRow = rows.find((r: Record<string, unknown>) => r.country === 'CN');
  assert(cnRow !== undefined, '应有 CN 行');
  assert(cnRow!.population === 1500, 'CN sum');

  console.log('[transform_aggregate] 关系路径分组 in_zone.label');
  const byZone = await client
    .model('Pump')
    .query()
    .groupBy(['in_zone.label', 'country'])
    .compute({ population: 'sum' })
    .execute();

  assert(isAnalysisResult(byZone), 'AnalysisResult');
  const east = byZone
    .asMatrix()
    .find((r: Record<string, unknown>) => r['in_zone.label'] === '东一区' && r.country === 'CN');
  assert(east !== undefined && east.population === 1500, '东一区+CN');

  console.log('[transform_aggregate] pivot + aggregate(Aggregator) + between + execute()');
  const pipe = await client
    .model('Pump')
    .query()
    .between('year', 2019, 2026)
    .aggregate(new Aggregator().sum('population').avg('growthRate'))
    .pivot(['year', 'country'])
    .execute();
  assert(isAnalysisResult(pipe), '管道范例');
  const p2020 = (pipe.asTree() as Record<string, unknown>)['2020'] as Record<string, unknown>;
  const pCn = p2020['CN'] as Record<string, unknown>;
  assert(
    pCn.population === 1500 && Math.abs((pCn.growthRate as number) - 0.025) < 1e-9,
    'pivot+aggregate 管道 CN 2020',
  );

  console.log('[transform_aggregate] 全缺失数值 → traceable_null(all_missing)');
  const missingField = await client
    .model('Pump')
    .query()
    .groupBy(['country'])
    .compute({ ghostAvg: 'avg' })
    .execute();
  assert(isAnalysisResult(missingField), 'AnalysisResult');
  for (const r of missingField.asMatrix()) {
    const v = r.ghostAvg;
    assert(isTraceableNull(v) && v.reason === TRACEABLE_REASON_ALL_MISSING, '不存在的字段应全缺失');
  }
  const metaMiss = missingField.getMetadata();
  const cnMiss = metaMiss.buckets.find(
    (b: AnalysisBucketMetadataRow) => b.dimensionValues[0] === 'CN',
  );
  assert(
    cnMiss !== undefined &&
      cnMiss.metrics['ghostAvg']!.validSampleCount === 0 &&
      cnMiss.metrics['ghostAvg']!.missingSampleCount === 2 &&
      cnMiss.metrics['ghostAvg']!.resultHint === TRACEABLE_REASON_ALL_MISSING,
    'getMetadata 溯源 all_missing',
  );

  console.log('[transform_aggregate] customReduce + compute 混用');
  const alpha = 0.5;
  const mix = await client
    .model('Pump')
    .query()
    .groupBy(['country'])
    .compute({ population: 'sum' })
    .customReduce('emaGrowth', {
      reduce: (prev, cur) => {
        const x = Number(cur);
        if (Number.isNaN(x)) {
          return prev;
        }
        if (prev === undefined || prev === null) {
          return x;
        }
        return alpha * x + (1 - alpha) * (prev as number);
      },
      valueField: 'growthRate',
    })
    .execute();

  assert(isAnalysisResult(mix), 'AnalysisResult');
  const cnMix = mix.asMatrix().find((r: Record<string, unknown>) => r.country === 'CN');
  assert(cnMix !== undefined, 'CN 混用行');
  assert(cnMix!.population === 1500, '内置 sum 保留');
  assert(Math.abs((cnMix!.emaGrowth as number) - 0.025) < 1e-9, 'CN 两行 EMA: 0.02→0.025');

  console.log('[transform_aggregate] compute 与 customReduce 同输出键应抛错');
  let dupThrew = false;
  try {
    await client
      .model('Pump')
      .query()
      .groupBy(['year'])
      .compute({ population: 'sum' })
      .customReduce('population', { reduce: (_p, c) => c })
      .execute();
  } catch {
    dupThrew = true;
  }
  assert(dupThrew, '同键冲突');

  console.log('[transform_aggregate] analyze() 等价于 execute()（透视已配置）');
  const viaAnalyze = await client
    .model('Pump')
    .query()
    .groupBy(['year'])
    .compute({ n: 'count' })
    .analyze();
  assert(isAnalysisResult(viaAnalyze), 'analyze→AnalysisResult');

  await runTransformAudits(DATA_ROOT);

  console.log('\ntransform_aggregate: 全部通过（含审计项 8–10）');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

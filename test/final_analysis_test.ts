/**
 * 年份 × 国家 × 人口 / GDP 分析闭环验收（`global_atlas`）。
 *
 * Run: `npx tsx test/final_analysis_test.ts` 或 `npm run final-analysis`
 */

import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { configureModelDBStorageRoot } from '@mode-db/common';
import { AuthoringEngine } from '../packages/core/src/authoring/AuthoringEngine.js';
import { integrationVaultAuthoringOptions, useIntegrationVaultEnv } from './integration-vault.js';
import { ModelDBClient } from '../packages/core/src/runtime/ModelDBClient.js';
import { isAnalysisResult } from '../packages/core/src/runtime/transform-engine.js';

const DATA_ROOT = join(process.cwd(), 'data');
const ATLAS = 'global_atlas';

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

async function run(): Promise<void> {
  configureModelDBStorageRoot({ storageRoot: DATA_ROOT });
  useIntegrationVaultEnv();
  await rm(join(DATA_ROOT, ATLAS), { recursive: true, force: true });

  const eng = new AuthoringEngine({
    atlas: ATLAS,
    storageRoot: DATA_ROOT,
    ...integrationVaultAuthoringOptions,
  });
  eng.registerModel('Stats');
  const Stats = eng.model('Stats');
  Stats.updateFields(['id', 'year', 'country', 'population', 'gdp']);

  await Stats.insert({ id: 'S1', year: 2026, country: 'China', population: 10, gdp: 100 });
  await Stats.insert({ id: 'S2', year: 2026, country: 'China', population: 20, gdp: 120 });
  await Stats.insert({ id: 'S3', year: 2026, country: 'China', population: 30, gdp: 150 });

  await eng.flushAll();

  const client = await ModelDBClient.connect(ATLAS);

  const report = await client
    .model('Stats')
    .query()
    .matchAll((f) => {
      f.gt('year', 1990);
    })
    .aggregate({
      population: ['sum', 'avg', 'variance'],
      gdp: ['max'],
    })
    .pivot(['year', 'country'])
    .execute();

  assert(isAnalysisResult(report), 'execute → AnalysisResult');

  const tree = report.asTree() as Record<string, unknown>;
  const byYear = tree['2026'] as Record<string, unknown>;
  const china = byYear['China'] as Record<string, unknown>;

  assert(china !== undefined, '应有 2026 / China 叶节点');
  assert(china.sum_population === 60, 'sum_population');
  assert(Math.abs((china.avg_population as number) - 20) < 1e-9, 'avg_population');

  const mean = (10 + 20 + 30) / 3;
  const expectedVar = ((10 - mean) ** 2 + (20 - mean) ** 2 + (30 - mean) ** 2) / 3;
  assert(Math.abs(expectedVar - 200 / 3) < 1e-12, '手算方差基准');
  assert(
    Math.abs((china.variance_population as number) - expectedVar) < 1e-9,
    `方差: got ${String(china.variance_population)} expect ${String(expectedVar)}`,
  );
  assert(china.gdp === 150, '单算子 max 时输出键仍为源字段名 gdp');

  const trace = report.getTraceability();
  assert(trace.pipeline === 'filter_then_group_then_aggregate', 'trace pipeline');
  assert(trace.buckets.length >= 1, 'trace buckets');

  const flat = report.asFlatTable();
  assert(
    flat.some(
      (r: Record<string, unknown>) =>
        r.year === 2026 && r.country === 'China' && r.sum_population === 60 && r.gdp === 150,
    ),
    'asFlatTable 合并维度与指标列',
  );

  console.log('数据闭环验证成功，嵌套树分组维度深度为 2（年 → 国家）。');
  console.log('方差计算精度检查：', china.variance_population);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});

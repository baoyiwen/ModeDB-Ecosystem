/**
 * 高级功能综合审计：递归 relateRecursive、GroupInstance + compute、分页 Paginated、AnalysisResult + compute。
 *
 * Run: npx tsx test/advanced_feature_audit.ts
 */

import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { configureModelDBStorageRoot } from '@mode-db/common';
import { AuthoringEngine } from '../src/authoring/AuthoringEngine.js';
import { integrationVaultAuthoringOptions, useIntegrationVaultEnv } from './integration-vault.js';
import { ModelDBClient } from '../src/runtime/ModelDBClient.js';
import type { HydratedEntity } from '../src/runtime/HydratedEntity.js';
import {
  type GroupInstance,
  isAnalysisResult,
  isGroupInstance,
  isPaginatedExecuteResult,
} from '../src/runtime/query.js';
import type { AnalysisFlatRow } from '../src/runtime/transform-engine.js';

const DATA_ROOT = join(process.cwd(), 'data');
const ATLAS = 'geo_analytics';

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

async function runAdvancedAudit(): Promise<void> {
  console.log('--- Model DB 2.0 高级查询审计开始 ---');

  configureModelDBStorageRoot({ storageRoot: DATA_ROOT });
  useIntegrationVaultEnv();
  await rm(join(DATA_ROOT, ATLAS), { recursive: true, force: true });

  const admin = new AuthoringEngine({
    atlas: ATLAS,
    storageRoot: DATA_ROOT,
    ...integrationVaultAuthoringOptions,
  });

  admin.quickLink('Region', 'Region', 'sub_regions', 'parent_region');
  const Region = admin.model('Region');
  Region.updateFields(['id', 'name', 'type', 'population', 'parentId']);

  const treeRel = admin.relation('sub_regions');
  treeRel.updateLogic('many-to-one', { sourceField: 'id', targetField: 'parentId' });

  console.log('正在构建行政树数据...');
  const r1 = await Region.insert({
    id: 'R1',
    name: '国家中心',
    type: 'Level_1',
    population: 0,
  });
  await Region.insert({
    id: 'R1-1',
    name: '省份A',
    type: 'Level_2',
    population: 500,
    parentId: 'R1',
  });
  await Region.insert({
    id: 'R1-2',
    name: '省份B',
    type: 'Level_2',
    population: 700,
    parentId: 'R1',
  });
  await Region.insert({
    id: 'C1',
    name: '城市A-1',
    type: 'Level_3',
    population: 100,
    parentId: 'R1-1',
  });
  await Region.insert({
    id: 'C2',
    name: '城市A-2',
    type: 'Level_3',
    population: 150,
    parentId: 'R1-1',
  });

  await treeRel.bind({ strategy: 'PROTOCOL' });
  await admin.flushAll();

  const client = await ModelDBClient.connect(ATLAS);

  console.log('\n[审计 1/4] 自关联深度递归 (Region / sub_regions)...');
  const recursiveResult = (await client
    .model('Region')
    .query([r1._id])
    .relateRecursive('sub_regions', { depth: 2 })
    .execute()) as HydratedEntity[];
  const byBizId = new Set(recursiveResult.map((h) => String(h.getData().id)));
  assert(byBizId.has('R1'), '含种子 R1');
  assert(byBizId.has('R1-1') && byBizId.has('R1-2'), '第一层省份');
  assert(byBizId.has('C1') && byBizId.has('C2'), '第二层城市');
  assert(
    recursiveResult.length === 5,
    `预期 5 条（种子 + 2 省 + 2 城），实际 ${recursiveResult.length}`,
  );
  console.log('递归验证通过：depth=2 时 BFS 含种子共 5 个节点。');

  console.log('\n[审计 2/4] 语义化 compute 回调 + wrapGroups → GroupInstance...');
  const groupResult = (await client
    .model('Region')
    .query()
    .is('type', 'Level_2')
    .groupBy(['name'])
    .compute((f) => [f.sum('population'), f.avg('population')])
    .wrapGroups()
    .execute()) as GroupInstance[];
  assert(groupResult.length === 2, `省份分组应为 2 桶，实际 ${groupResult.length}`);
  const g0 = groupResult[0]!;
  assert(isGroupInstance(g0), 'GroupInstance 类型');
  const row = g0.getData();
  assert(
    typeof row.sum_population === 'number' && row.sum_population > 0,
    'sum_population 应为正数',
  );
  assert(g0.getEntities().length === 1, '每桶 Level_2 仅 1 条实体');
  console.log(
    `分组实例验证通过：组 [${String(row.name)}] sum_population=${String(row.sum_population)}，成员数=${String(g0.getEntities().length)}`,
  );

  console.log('\n[审计 3/4] 分页 Paginated（扁平路径）...');
  const pageResult = await client.model('Region').query().page(1).limit(2).execute();
  assert(isPaginatedExecuteResult(pageResult), 'execute 应返回 Paginated 外壳');
  assert(pageResult.total === 5, `total 应为 5，实际 ${pageResult.total}`);
  assert(pageResult.page === 1 && pageResult.limit === 2, 'page / limit');
  assert(
    pageResult.pageCount === 3,
    `5 条每页 2 条 → 3 页，实际 pageCount=${pageResult.pageCount}`,
  );
  const items = pageResult.items as HydratedEntity[];
  assert(items.length === 2, `第二页应为 2 条，实际 ${items.length}`);
  console.log('分页验证通过：Paginated.items 长度与 total/pageCount 一致。');

  console.log('\n[审计 4/4] 同链无 wrapGroups → AnalysisResult（compute 协议）...');
  const ar = await client
    .model('Region')
    .query()
    .is('type', 'Level_2')
    .groupBy(['name'])
    .compute((f) => [f.sum('population')])
    .execute();
  assert(isAnalysisResult(ar), '应为 AnalysisResult');
  assert(ar.bucketCount === 2, '两省份两桶');
  const flat = ar.asFlatTable();
  assert(flat.length === 2, '扁平行数');
  const sum500 = flat.find((r: AnalysisFlatRow) => r.name === '省份A');
  assert(
    sum500 !== undefined && sum500.population === 500,
    '省份A：单算子 sum 时输出键为源字段名 population',
  );
  console.log('AnalysisResult 验证通过：bucketCount / asFlatTable 与 compute 一致。');

  console.log('\n--- 所有高级逻辑回路审计完成 ---');
}

runAdvancedAudit().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error('\n审计失败:', msg);
  process.exit(1);
});

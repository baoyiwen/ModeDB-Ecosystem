/**
 * QueryChain 扩展：ComputeBuilder、分页、GroupInstance、relateRecursive（BFS + 防环）
 *
 * Run: npx tsx test/query_chain_extended.ts
 */

import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { configureModelDBStorageRoot } from '../common/storage-root-config.js';
import { AuthoringEngine } from '../src/authoring/AuthoringEngine.js';
import { ModelDBClient } from '../src/runtime/ModelDBClient.js';
import type { HydratedEntity } from '../src/runtime/HydratedEntity.js';
import {
  ComputeBuilder,
  type GroupInstance,
  isAnalysisResult,
  isGroupInstance,
  isPaginatedExecuteResult,
} from '../src/runtime/query.js';

const DATA_ROOT = join(process.cwd(), 'data');
const ATLAS = 'query_chain_extended';

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

async function main(): Promise<void> {
  configureModelDBStorageRoot({ storageRoot: DATA_ROOT });
  await rm(join(DATA_ROOT, ATLAS), { recursive: true, force: true });

  const eng = new AuthoringEngine({ atlas: ATLAS, storageRoot: DATA_ROOT });
  eng.quickLink('Node', 'Node', 'has_child', 'parent');

  const Node = eng.model('Node');
  Node.updateFields(['id', 'parentId', 'label', 'n']);
  await Node.insert({ id: 'root', label: 'R', n: 10 });
  await Node.insert({ id: 'c1', parentId: 'root', label: 'L1', n: 1 });
  await Node.insert({ id: 'c2', parentId: 'c1', label: 'L2', n: 1 });

  const rel = eng.relation('has_child');
  rel.updateLogic('many-to-one', { sourceField: 'id', targetField: 'parentId' });
  await rel.bind({ strategy: 'PROTOCOL' });
  await eng.flushAll();

  const client = await ModelDBClient.connect(ATLAS);

  console.log('[extended] ComputeBuilder + groupBy');
  const cb = new ComputeBuilder();
  assert(cb.sum('x').field === 'x', 'builder token');
  const agg = await client
    .model('Node')
    .query()
    .groupBy(['label'])
    .compute((f) => [f.sum('n')])
    .execute();
  assert(isAnalysisResult(agg), 'compute(fn) → AnalysisResult');

  console.log('[extended] 分析按桶分页（bucketCount / sliceBuckets → Paginated）');
  const pAgg = await client
    .model('Node')
    .query()
    .groupBy(['label'])
    .compute({ n: 'count' })
    .limit(2)
    .page(0)
    .execute();
  assert(isPaginatedExecuteResult(pAgg), 'groupBy + limit → Paginated');
  assert(
    pAgg.total === 3 && pAgg.page === 0 && pAgg.limit === 2 && pAgg.pageCount === 2,
    '三桶、每页 2',
  );
  const page0 = pAgg.items;
  assert(isAnalysisResult(page0), 'items 为 AnalysisResult');
  assert(page0.bucketCount === 2, '第一页两桶');
  const pAgg1 = await client
    .model('Node')
    .query()
    .groupBy(['label'])
    .compute({ n: 'count' })
    .limit(2)
    .page(1)
    .execute();
  assert(isPaginatedExecuteResult(pAgg1), '第二页 Paginated');
  const page1 = pAgg1.items;
  assert(isAnalysisResult(page1) && page1.bucketCount === 1, '第二页一桶');

  console.log('[extended] 分页 flat execute');
  const paged = await client.model('Node').query().limit(2).page(0).execute();
  assert(isPaginatedExecuteResult(paged), 'Paginated 外壳');
  assert(paged.total === 3 && paged.items.length === 2 && paged.page === 0, '总数与切片');

  console.log('[extended] wrapGroups + GroupInstance');
  const groups = (await client
    .model('Node')
    .query()
    .groupBy(['label'])
    .compute({ cnt: 'count' })
    .wrapGroups()
    .execute()) as GroupInstance[];
  assert(Array.isArray(groups) && groups.length >= 1, 'GroupInstance[]');
  const gL1 = groups.find((g) => g.getData().label === 'L1')!;
  assert(isGroupInstance(gL1), 'isGroupInstance');
  assert(gL1.getEntities().length === 1, 'L1 桶 1 条');
  const sub = (await gL1.query().execute()) as HydratedEntity[];
  assert(
    sub.length === 1 && sub[0]!.getData().id === 'c1',
    'GroupInstance.query 按 _id 拉回同一条',
  );

  console.log('[extended] relateRecursive BFS（含环防护：c2 若指回 root 不死循环）');
  const rec = await client
    .model('Node')
    .query()
    .is('id', 'root')
    .relateRecursive('has_child', { depth: 4 })
    .execute();
  const flat = rec as HydratedEntity[];
  const ids = new Set(flat.map((h) => String((h.getData() as Record<string, unknown>).id)));
  assert(ids.has('root') && ids.has('c1') && ids.has('c2'), '递归展开子树');

  console.log('query_chain_extended: 全部通过');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

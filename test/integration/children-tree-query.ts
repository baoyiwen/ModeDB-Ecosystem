/**
 * 自关联「树形查询」回归测试：`query().children(relation, { depth, strategy })` + 结果实例 `flatten()` / `toTree()`。
 *
 * 覆盖：
 *  1. children() 直接以嵌套子树返回（子节点挂在 `children` 字段下）。
 *  2. 数据守恒：被作为子节点出现的实体不再出现在顶层。
 *  3. toTree() 输出纯 JSON 嵌套树。
 *  4. flatten() 展平；一对一链为「上下游」强顺序。
 *  5. depth 限制展开层数。
 *
 * 数据（children: 父 → 子）：
 *   上游链（强顺序）：S0(src-0) → S1(src-1) → S2(src-2) → S3(src-3)
 *
 * Run: `pnpm run build:server && pnpm run build:sdk` 后 `npx tsx test/integration/children-tree-query.ts`。
 */

import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configureModelDBStorageRoot, DataType, type FieldDefsRecord } from '@mode-db/common';
import { AuthoringEngine } from '@mode-db/core';
import {
  getServerListeningPort,
  loadModelDBServerConfig,
  startModelDBWebSocketServer,
} from '@mode-db/server';
import { ModelDB, RemoteHydratedEntity } from '@mode-db/sdk';
import { INTEGRATION_CONNECT_TOKEN, useIntegrationVaultEnv } from './vault-env.js';

const WORKSPACE = join(process.cwd(), 'data', 'children_tree_workspace');
const ATLAS = 'children_tree_query';
const CONFIG_PATH = join(WORKSPACE, 'modeldb.config.json');

let passed = 0;
let failed = 0;

function ok(cond: boolean, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function section(title: string): void {
  console.log(`\n${'═'.repeat(60)}\n  ${title}\n${'═'.repeat(60)}`);
}

useIntegrationVaultEnv();
configureModelDBStorageRoot({ storageRoot: WORKSPACE });

section('0. Reset workspace + logical library directory');
mkdirSync(WORKSPACE, { recursive: true });
rmSync(join(WORKSPACE, ATLAS), { recursive: true, force: true });
writeFileSync(
  CONFIG_PATH,
  JSON.stringify({ connectToken: INTEGRATION_CONNECT_TOKEN, workspace: '.' }, null, 2),
  'utf-8',
);
ok(true, `workspace ${WORKSPACE} ready`);

section('1. AuthoringEngine: self-relation model + one-to-one upstream→downstream chain');
const ddl = new AuthoringEngine({
  atlas: ATLAS,
  storageRoot: WORKSPACE,
  connectToken: INTEGRATION_CONNECT_TOKEN,
});

const schema: FieldDefsRecord = {
  id: DataType.String,
  code: { type: DataType.String, required: true },
  name: { type: DataType.String, required: true },
};
ddl.registerModel('Stage', schema);
ddl.quickLink('Stage', 'Stage', 'children', 'parent');

const s0 = await ddl.insert('Stage', { id: 's0', code: 'src-0', name: 'Source' });
const s1 = await ddl.insert('Stage', { id: 's1', code: 'src-1', name: 'Pump' });
const s2 = await ddl.insert('Stage', { id: 's2', code: 'src-2', name: 'Valve' });
const s3 = await ddl.insert('Stage', { id: 's3', code: 'src-3', name: 'Sink' });

await ddl.bind('children', 'MANUAL', {
  pairs: [
    [s0._id, s1._id],
    [s1._id, s2._id],
    [s2._id, s3._id],
  ],
});
await ddl.flushAll();
ok(true, 'Stage(self children/parent) + 1:1 chain S0→S1→S2→S3');

section('2. Start ModelDB server');
const resolved = await loadModelDBServerConfig(CONFIG_PATH, {
  port: 0,
  host: '127.0.0.1',
  connectToken: INTEGRATION_CONNECT_TOKEN,
  dev: false,
});
const app = await startModelDBWebSocketServer(resolved);
const port = getServerListeningPort(app);
ok(port > 0, `listening on 127.0.0.1:${port}`);

try {
  const modeldb = new ModelDB({ host: '127.0.0.1', port, token: INTEGRATION_CONNECT_TOKEN });
  const remote = await modeldb.use(ATLAS);

  section('3. query().children("children") from the chain head → nested tree');
  const roots = (await remote
    .model('Stage')
    .query()
    .is('code', 'src-0')
    .children('children')
    .execute()) as RemoteHydratedEntity[];

  ok(roots.length === 1, `single root (chain head) at top level (got ${roots.length})`);
  const head = roots[0];
  assert(head, 'head present');

  const tree = head.toTree();
  const lvl1 = (tree.children as Record<string, unknown>[] | undefined) ?? [];
  const lvl2 = (lvl1[0]?.children as Record<string, unknown>[] | undefined) ?? [];
  const lvl3 = (lvl2[0]?.children as Record<string, unknown>[] | undefined) ?? [];
  ok(
    String(tree.code) === 'src-0' &&
      String(lvl1[0]?.code) === 'src-1' &&
      String(lvl2[0]?.code) === 'src-2' &&
      String(lvl3[0]?.code) === 'src-3',
    'toTree() nests children under `children`: src-0 → src-1 → src-2 → src-3',
  );

  section('4. flatten(): strong upstream→downstream order for 1:1 chain');
  const flatCodes = head.flatten().map((e) => String(e.getData().code));
  ok(
    flatCodes.length === 4 &&
      flatCodes[0] === 'src-0' &&
      flatCodes[1] === 'src-1' &&
      flatCodes[2] === 'src-2' &&
      flatCodes[3] === 'src-3',
    `flatten() yields ordered chain: [${flatCodes.join(' → ')}]`,
  );

  section('5. children() conservation: query all → only head at top level');
  const allRoots = (await remote
    .model('Stage')
    .query()
    .children('children')
    .execute()) as RemoteHydratedEntity[];
  const topCodes = allRoots.map((e) => String(e.getData().code)).sort();
  ok(
    topCodes.length === 1 && topCodes[0] === 'src-0',
    `entities with a parent demoted from top level: [${topCodes.join(', ')}] (expected src-0)`,
  );
  const distinct = new Set(allRoots[0] ? allRoots[0].flatten().map((e) => String(e.getData().code)) : []);
  ok(distinct.size === 4, `all 4 stages reachable from the single root (got ${distinct.size})`);

  section('6. depth limits expansion');
  const shallow = (await remote
    .model('Stage')
    .query()
    .is('code', 'src-0')
    .children('children', { depth: 1 })
    .execute()) as RemoteHydratedEntity[];
  const sTree = shallow[0]?.toTree() ?? {};
  const sLvl1 = (sTree.children as Record<string, unknown>[] | undefined) ?? [];
  const sLvl2 = (sLvl1[0]?.children as Record<string, unknown>[] | undefined) ?? [];
  ok(
    String(sLvl1[0]?.code) === 'src-1' && sLvl2.length === 0,
    'depth:1 expands exactly one level (src-0 → src-1, no deeper)',
  );

  remote.close();
} finally {
  await app.close();
}

console.log(`\nchildren-tree-query: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

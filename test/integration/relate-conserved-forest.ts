/**
 * 关系组装「数据守恒」回归测试：自关联 `children` + `execute({ includeRelates: true })`。
 *
 * 背景：以「全部记录」为起点对自关联做 `relate('children')` 时，子节点既会出现在顶层、又会嵌套在父节点之下，
 * 导致实体总数翻倍。修复后 `executeWithRelates` 会组装为守恒森林：被引用为子节点的实体从顶层移除，仅保留嵌套形态；
 * 多对多（同一子节点被多个父引用）仍允许在各父节点下重复嵌套。
 *
 * 数据（children: 父 → 子）：
 *   省 A(10) → 市 A1(1001) → 区 X(3001)
 *   省 B(20) → 市 B1(2001) → 区 X(3001)
 * 共 5 个实体；X 同时挂在 A1、B1 之下（多对多例外）。
 *
 * Run: `pnpm run build:server && pnpm run build:sdk` 后 `npx tsx test/integration/relate-conserved-forest.ts`。
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

const WORKSPACE = join(process.cwd(), 'data', 'relate_forest_workspace');
const ATLAS = 'relate_conserved_forest';
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

interface ForestRow {
  readonly code?: unknown;
  readonly relates?: Record<string, ForestRow[]>;
}

/** 深度遍历嵌套 `relates`，按出现顺序收集每个实体的 `code`（含重复）。 */
function collectCodes(row: ForestRow, out: string[]): void {
  out.push(String(row.code));
  const rel = row.relates;
  if (!rel) {
    return;
  }
  for (const children of Object.values(rel)) {
    for (const child of children) {
      collectCodes(child, out);
    }
  }
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

section('1. AuthoringEngine: self-relation model + seed hierarchy (with one shared child)');
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
ddl.registerModel('Division', schema);
ddl.quickLink('Division', 'Division', 'children', 'parent');

const provinceA = await ddl.insert('Division', { id: 'a', code: '10', name: 'Province A' });
const provinceB = await ddl.insert('Division', { id: 'b', code: '20', name: 'Province B' });
const cityA1 = await ddl.insert('Division', { id: 'a1', code: '1001', name: 'City A1' });
const cityB1 = await ddl.insert('Division', { id: 'b1', code: '2001', name: 'City B1' });
const districtX = await ddl.insert('Division', { id: 'x', code: '3001', name: 'District X' });

await ddl.bind('children', 'MANUAL', {
  pairs: [
    [provinceA._id, cityA1._id],
    [provinceB._id, cityB1._id],
    [cityA1._id, districtX._id],
    [cityB1._id, districtX._id],
  ],
});
await ddl.flushAll();
ok(true, 'registered Division(self children/parent) + 5 rows + 4 edges (X shared by A1 & B1)');

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
  section('3. Query all + relate(children) + includeRelates → conserved forest');
  const modeldb = new ModelDB({ host: '127.0.0.1', port, token: INTEGRATION_CONNECT_TOKEN });
  const remote = await modeldb.use(ATLAS);

  const top = (await remote
    .model('Division')
    .query()
    .relate('children')
    .execute({ includeRelates: true })) as RemoteHydratedEntity[];

  ok(Array.isArray(top), 'execute returned an array');

  const topCodes = top.map((e) => String((e.getData() as ForestRow).code)).sort();
  ok(
    topCodes.length === 2 && topCodes[0] === '10' && topCodes[1] === '20',
    `top-level only roots without a parent: [${topCodes.join(', ')}] (expected 10, 20)`,
  );

  const allCodes: string[] = [];
  for (const e of top) {
    collectCodes(e.getData() as ForestRow, allCodes);
  }
  const distinct = new Set(allCodes);
  ok(
    distinct.size === 5,
    `entity total conserved across forest: ${distinct.size} distinct (expected 5 seeded)`,
  );

  const childCodes = new Set(['1001', '2001', '3001']);
  const topAlsoNested = topCodes.some((c) => childCodes.has(c));
  ok(!topAlsoNested, 'no top-level entity also appears nested (a / b never demoted)');

  const a1Nested = allCodes.includes('1001');
  const b1Nested = allCodes.includes('2001');
  ok(a1Nested && b1Nested, 'demoted cities A1 / B1 still present as nested children');

  const xOccurrences = allCodes.filter((c) => c === '3001').length;
  ok(
    xOccurrences === 2,
    `m2m exception: shared District X nested under both parents (occurrences=${xOccurrences})`,
  );

  const provinceARow = top.find((e) => String((e.getData() as ForestRow).code) === '10');
  assert(provinceARow, 'province A present at top level');
  const aData = provinceARow.getData() as ForestRow;
  const aChildren = aData.relates?.children ?? [];
  const aGrandchildren = aChildren[0]?.relates?.children ?? [];
  ok(
    aChildren.length === 1 &&
      String(aChildren[0]?.code) === '1001' &&
      aGrandchildren.length === 1 &&
      String(aGrandchildren[0]?.code) === '3001',
    'depth preserved: A → A1 → X (single-hop relate assembled as nested tree)',
  );

  remote.close();
} finally {
  await app.close();
}

console.log(`\nrelate-conserved-forest: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

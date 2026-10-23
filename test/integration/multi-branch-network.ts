/**
 * 「同一起点的数据网」回归测试：从单个起点拉出**多条深层链**（分支），而非单一线性链。
 *
 * 能力：
 *  - `relate(name, target?, build)` / `group(name, target?, build)`：`build` 在**本跳目标**上继续构建子链。
 *  - 多次 `group`（保持主体）+ 各自的 `build` 子链 ⇒ 同一父实体下并存多条深层分支 = 数据网。
 *
 * 数据（H=Hub 起点）：
 *   分支一：Hub --depts--> Dept --members--> Member
 *   分支二：Hub --tags--> Tag --colors--> Color
 *   H1 → Dept D1,D2 ；D1 → Member M1,M2 ；D2 → Member M3
 *   H1 → Tag  T1,T2 ；T1 → Color  C1   ；T2 → Color  C2
 *
 * Run: `pnpm run build:server && pnpm run build:sdk` 后 `npx tsx test/integration/multi-branch-network.ts`。
 */

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
import { INTEGRATION_CONNECT_TOKEN, useIntegrationVaultEnv, integrationVaultKeys } from './vault-env.js';

const WORKSPACE = join(process.cwd(), 'data', 'multi_branch_workspace');
const ATLAS = 'multi_branch_network';
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

function rel(row: Record<string, unknown>, name: string): Record<string, unknown>[] {
  const r = row.relates as Record<string, unknown> | undefined;
  const slot = r?.[name];
  return Array.isArray(slot) ? (slot as Record<string, unknown>[]) : [];
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

section('1. AuthoringEngine: two independent 2-hop chains from Hub');
const ddl = new AuthoringEngine({
  atlas: ATLAS,
  storageRoot: WORKSPACE,
  keyProvider: integrationVaultKeys(WORKSPACE),
});

const named: FieldDefsRecord = { id: DataType.String, name: { type: DataType.String, required: true } };
ddl.registerModel('Hub', { id: DataType.String, code: { type: DataType.String, required: true } });
ddl.registerModel('Dept', named);
ddl.registerModel('Member', named);
ddl.registerModel('Tag', { id: DataType.String, label: { type: DataType.String, required: true } });
ddl.registerModel('Color', { id: DataType.String, hex: { type: DataType.String, required: true } });
ddl.quickLink('Hub', 'Dept', 'depts', 'hub');
ddl.quickLink('Dept', 'Member', 'members', 'dept');
ddl.quickLink('Hub', 'Tag', 'tags', 'hubs');
ddl.quickLink('Tag', 'Color', 'colors', 'tag');

const h1 = await ddl.insert('Hub', { id: 'h1', code: 'h-1' });
const d1 = await ddl.insert('Dept', { id: 'd1', name: 'Engineering' });
const d2 = await ddl.insert('Dept', { id: 'd2', name: 'Sales' });
const m1 = await ddl.insert('Member', { id: 'm1', name: 'Ann' });
const m2 = await ddl.insert('Member', { id: 'm2', name: 'Bob' });
const m3 = await ddl.insert('Member', { id: 'm3', name: 'Cara' });
const t1 = await ddl.insert('Tag', { id: 't1', label: 'urgent' });
const t2 = await ddl.insert('Tag', { id: 't2', label: 'backlog' });
const c1 = await ddl.insert('Color', { id: 'c1', hex: '#f00' });
const c2 = await ddl.insert('Color', { id: 'c2', hex: '#00f' });

await ddl.bind('depts', 'MANUAL', { pairs: [[h1._id, d1._id], [h1._id, d2._id]] });
await ddl.bind('members', 'MANUAL', { pairs: [[d1._id, m1._id], [d1._id, m2._id], [d2._id, m3._id]] });
await ddl.bind('tags', 'MANUAL', { pairs: [[h1._id, t1._id], [h1._id, t2._id]] });
await ddl.bind('colors', 'MANUAL', { pairs: [[t1._id, c1._id], [t2._id, c2._id]] });
await ddl.flushAll();
ok(true, 'Hub→Dept→Member and Hub→Tag→Color seeded');

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

  section('3. Data network: two deep branches from one Hub via group(...build)');
  const rows = (await remote
    .model('Hub')
    .query()
    .is('code', 'h-1')
    .group('depts', undefined, (sub) => sub.relate('members'))
    .group('tags', undefined, (sub) => sub.relate('colors'))
    .execute()) as RemoteHydratedEntity[];

  ok(rows.length === 1, `single Hub at top level (subject preserved by group), got ${rows.length}`);
  const hub = rows[0]!.getData();

  const depts = rel(hub, 'depts');
  const deptNames = depts.map((d) => String(d.name)).sort();
  ok(
    deptNames.length === 2 && deptNames[0] === 'Engineering' && deptNames[1] === 'Sales',
    `branch-1 level-1: depts = [${deptNames.join(', ')}]`,
  );
  const eng = depts.find((d) => d.name === 'Engineering')!;
  const engMembers = rel(eng, 'members').map((m) => String(m.name)).sort();
  ok(
    engMembers.length === 2 && engMembers[0] === 'Ann' && engMembers[1] === 'Bob',
    `branch-1 level-2: Engineering.members = [${engMembers.join(', ')}]`,
  );

  const tags = rel(hub, 'tags');
  const tagLabels = tags.map((t) => String(t.label)).sort();
  ok(
    tagLabels.length === 2 && tagLabels[0] === 'backlog' && tagLabels[1] === 'urgent',
    `branch-2 level-1: tags = [${tagLabels.join(', ')}]`,
  );
  const urgent = tags.find((t) => t.label === 'urgent')!;
  const urgentColors = rel(urgent, 'colors').map((c) => String(c.hex));
  ok(
    urgentColors.length === 1 && urgentColors[0] === '#f00',
    `branch-2 level-2: urgent.colors = [${urgentColors.join(', ')}]`,
  );

  ok(
    depts.length === 2 && tags.length === 2,
    'both branches coexist under the same Hub (a data network, not a single chain)',
  );

  section('4. relate(name, target, build): forward spine with a nested sub-chain');
  const spine = (await remote
    .model('Hub')
    .query()
    .is('code', 'h-1')
    .relate('depts', undefined, (sub) => sub.relate('members'))
    .execute()) as RemoteHydratedEntity[];
  const hub2 = spine[0]!.getData();
  const d2Members = rel(rel(hub2, 'depts').find((d) => d.name === 'Sales')!, 'members').map((m) =>
    String(m.name),
  );
  ok(
    rel(hub2, 'depts').length === 2 && d2Members.length === 1 && d2Members[0] === 'Cara',
    `relate build sub-chain: Sales.members = [${d2Members.join(', ')}]`,
  );

  remote.close();
} finally {
  await app.close();
}

console.log(`\nmulti-branch-network: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

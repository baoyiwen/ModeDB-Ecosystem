/**
 * `group()`（横向附加，保持主体）回归测试：`query().group(relation)` 与 `relate()` 同级，但**不改变查询主体**。
 *
 * 语义：
 *  - `relate(name)`：前进式跳转，主体游标推进到目标模型。
 *  - `group(name)`：横向附加，沿关系把目标挂到当前行下，主体游标**不变**；之后可继续 `group` 或再 `relate`。
 *
 * 覆盖：
 *  1. group() 后顶层结果仍是源模型行（主体守恒），关系数据挂在 `relates[name]` 下。
 *  2. N:N 附加：一个源行可挂多个目标（Item→多个 Tag），且不改变源行数量。
 *  3. group → relate 混用：group 不推进主体，故随后的 relate 仍从源模型跳转（若 group 误推进主体，relate 将无法在源模型上解析关系）。
 *  4. 行数守恒：顶层行数 == 源实体数，不因附加而膨胀。
 *
 * 数据：
 *   Item I1,I2,I3 ；Tag T1,T2（N:N）：I1→[T1,T2]，I2→[T1]，I3→[T2]
 *   Bin B1（Item→Bin 前进关系）：I1→B1，I2→B1
 *
 * Run: `pnpm run build:server && pnpm run build:sdk` 后 `npx tsx test/integration/group-lateral-attach.ts`。
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
import { INTEGRATION_CONNECT_TOKEN, useIntegrationVaultEnv } from './vault-env.js';

const WORKSPACE = join(process.cwd(), 'data', 'group_lateral_workspace');
const ATLAS = 'group_lateral_attach';
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

function relateRows(entity: RemoteHydratedEntity, name: string): Record<string, unknown>[] {
  const rel = entity.getData().relates as Record<string, unknown> | undefined;
  const slot = rel?.[name];
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

section('1. AuthoringEngine: Item↔Tag (N:N) + Item→Bin (forward)');
const ddl = new AuthoringEngine({
  atlas: ATLAS,
  storageRoot: WORKSPACE,
  connectToken: INTEGRATION_CONNECT_TOKEN,
});

const itemSchema: FieldDefsRecord = {
  id: DataType.String,
  code: { type: DataType.String, required: true },
  name: { type: DataType.String, required: true },
};
const tagSchema: FieldDefsRecord = {
  id: DataType.String,
  label: { type: DataType.String, required: true },
};
const binSchema: FieldDefsRecord = {
  id: DataType.String,
  label: { type: DataType.String, required: true },
};
ddl.registerModel('Item', itemSchema);
ddl.registerModel('Tag', tagSchema);
ddl.registerModel('Bin', binSchema);
ddl.quickLink('Item', 'Tag', 'tags', 'items');
ddl.quickLink('Item', 'Bin', 'bin', 'binItems');

const i1 = await ddl.insert('Item', { id: 'i1', code: 'item-1', name: 'Alpha' });
const i2 = await ddl.insert('Item', { id: 'i2', code: 'item-2', name: 'Beta' });
const i3 = await ddl.insert('Item', { id: 'i3', code: 'item-3', name: 'Gamma' });
const t1 = await ddl.insert('Tag', { id: 't1', label: 'red' });
const t2 = await ddl.insert('Tag', { id: 't2', label: 'blue' });
const b1 = await ddl.insert('Bin', { id: 'b1', label: 'box-1' });

await ddl.bind('tags', 'MANUAL', {
  pairs: [
    [i1._id, t1._id],
    [i1._id, t2._id],
    [i2._id, t1._id],
    [i3._id, t2._id],
  ],
});
await ddl.bind('bin', 'MANUAL', {
  pairs: [
    [i1._id, b1._id],
    [i2._id, b1._id],
  ],
});
await ddl.flushAll();
ok(true, 'Item↔Tag (N:N) + Item→Bin seeded');

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

  section('3. group("tags"): subject stays Item, tags attached laterally');
  const grouped = (await remote
    .model('Item')
    .query()
    .group('tags')
    .execute()) as RemoteHydratedEntity[];

  ok(
    grouped.length === 3 && grouped.every((e) => e.getModelName() === 'Item'),
    `top-level rows are the 3 source Items, not Tags (got ${grouped.length})`,
  );

  const byCode = new Map(grouped.map((e) => [String(e.getData().code), e]));
  const i1Tags = relateRows(byCode.get('item-1')!, 'tags')
    .map((r) => String(r.label))
    .sort();
  ok(
    i1Tags.length === 2 && i1Tags[0] === 'blue' && i1Tags[1] === 'red',
    `N:N attach: item-1 carries both tags [${i1Tags.join(', ')}]`,
  );
  ok(relateRows(byCode.get('item-2')!, 'tags').length === 1, 'item-2 carries 1 tag (red)');
  ok(relateRows(byCode.get('item-3')!, 'tags').length === 1, 'item-3 carries 1 tag (blue)');

  section('4. group → relate: group keeps subject, so relate still hops from Item');
  const mixed = (await remote
    .model('Item')
    .query()
    .group('tags')
    .relate('bin')
    .execute()) as RemoteHydratedEntity[];

  ok(
    mixed.length === 3 && mixed.every((e) => e.getModelName() === 'Item'),
    `top-level still the 3 Items after group().relate() (got ${mixed.length})`,
  );
  const mixedByCode = new Map(mixed.map((e) => [String(e.getData().code), e]));
  const i1Row = mixedByCode.get('item-1')!;
  ok(relateRows(i1Row, 'tags').length === 2, 'item-1 retains lateral tags after the forward relate');
  const i1Bin = relateRows(i1Row, 'bin').map((r) => String(r.label));
  ok(
    i1Bin.length === 1 && i1Bin[0] === 'box-1',
    `relate("bin") hopped from Item (subject preserved by group): [${i1Bin.join(', ')}]`,
  );
  ok(
    relateRows(mixedByCode.get('item-3')!, 'bin').length === 0,
    'item-3 has no bin (forward relate yields empty slot, still an Item row)',
  );

  section('5. row conservation: lateral attach does not inflate top-level count');
  ok(
    grouped.length === 3 && mixed.length === 3,
    'top-level count == source Item count (3) in both group-only and group+relate',
  );

  remote.close();
} finally {
  await app.close();
}

console.log(`\ngroup-lateral-attach: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

/**
 * CRUD 全链路审计：update / delete / updateWhere / deleteWhere，
 * 覆盖缓冲区协议（buffer 优先、`__deleted` 墓碑、flush 压缩、合并读即时生效）。
 *
 * Run:  npx tsx test/crud_audit.ts
 *       npm run crud-audit
 *       npm run test:integration（含本脚本）
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { configureModelDBStorageRoot } from '../common/storage-root-config.js';
import { AuthoringEngine } from '../src/authoring/AuthoringEngine.js';
import {
  atlasVaultPath,
  INTEGRATION_VAULT_SECRET,
  integrationVaultAuthoringOptions,
  loadVaultModelBlob,
  useIntegrationVaultEnv,
} from './integration-vault.js';
import { mergeDiskRowsWithAuthoringBuffer } from '../src/runtime/query-engine.js';
import { DELETED_SENTINEL, isDeletedRecord, type ModelRecord } from '../common/types.js';
import type { PredicateNode } from '../src/runtime/predicate-tree.js';

const DATA_ROOT = join(process.cwd(), 'data');
const ATLAS = 'crud_audit';

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// 1. mergeDiskRowsWithAuthoringBuffer — __deleted 过滤
// ---------------------------------------------------------------------------
function auditMergeDeletedFilter(): void {
  console.log('\n═══ 1. mergeDiskRowsWithAuthoringBuffer __deleted 过滤 ═══');

  const disk: ModelRecord[] = [
    { _id: 'u1', _createdAt: '2026-01-01T00:00:00.000Z', v: 1 },
    { _id: 'u2', _createdAt: '2026-01-01T00:00:00.000Z', v: 2 },
    { _id: 'u3', _createdAt: '2026-01-01T00:00:00.000Z', v: 3 },
  ];
  const pending = new Map<string, ModelRecord>([
    ['u1', { _id: 'u1', _createdAt: '2026-01-01T00:00:00.000Z', v: 99 }],
    [
      'u2',
      {
        _id: 'u2',
        _createdAt: '2026-01-01T00:00:00.000Z',
        [DELETED_SENTINEL]: true,
      } as ModelRecord,
    ],
    ['u4', { _id: 'u4', _createdAt: '2026-01-01T00:00:00.000Z', v: 4 }],
  ]);

  const merged = mergeDiskRowsWithAuthoringBuffer(disk, pending);
  const ids = merged.map((r) => r._id);

  assert(
    ids.includes('u1') && merged.find((r) => r._id === 'u1')!.v === 99,
    'merge：同 _id 缓冲行覆盖磁盘行',
  );
  assert(!ids.includes('u2'), 'merge：__deleted 行被过滤，不出现在结果中');
  assert(ids.includes('u3'), 'merge：仅磁盘有的行保留');
  assert(ids.includes('u4'), 'merge：仅缓冲有的新行追加');
  assert(merged.length === 3, `merge：结果长度 === 3（实际 ${merged.length}）`);
}

// ---------------------------------------------------------------------------
// 2. isDeletedRecord / DELETED_SENTINEL 工具函数
// ---------------------------------------------------------------------------
function auditDeletedHelpers(): void {
  console.log('\n═══ 2. isDeletedRecord / DELETED_SENTINEL ═══');

  const live: ModelRecord = { _id: 'x', _createdAt: '', v: 1 };
  const tomb: ModelRecord = { _id: 'y', _createdAt: '', [DELETED_SENTINEL]: true } as ModelRecord;

  assert(!isDeletedRecord(live), 'isDeletedRecord：活行 → false');
  assert(isDeletedRecord(tomb), 'isDeletedRecord：墓碑行 → true');
  assert(DELETED_SENTINEL === '__deleted', 'DELETED_SENTINEL === "__deleted"');
}

// ---------------------------------------------------------------------------
// 3–8. 引擎级 CRUD
// ---------------------------------------------------------------------------
function vaultItemDataRows(blob: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const line of blob.split('\n')) {
    const t = line.trim();
    if (!t || t.includes('"__schema__"')) {
      continue;
    }
    rows.push(JSON.parse(t) as Record<string, unknown>);
  }
  return rows;
}

async function auditEngineCrud(): Promise<void> {
  configureModelDBStorageRoot({ storageRoot: DATA_ROOT });
  useIntegrationVaultEnv();
  await rm(join(DATA_ROOT, ATLAS), { recursive: true, force: true });

  const engine = new AuthoringEngine({
    atlas: ATLAS,
    storageRoot: DATA_ROOT,
    ...integrationVaultAuthoringOptions,
  });
  engine.registerModel('Item', new Set(['name', 'status', 'score']));
  const Item = engine.model('Item');

  // --- 3. insert 基线 ---
  console.log('\n═══ 3. insert 基线 ═══');
  const r1 = await Item.insert({ name: 'A', status: 'active', score: 10 });
  const r2 = await Item.insert({ name: 'B', status: 'active', score: 20 });
  const r3 = await Item.insert({ name: 'C', status: 'idle', score: 30 });
  assert(r1._id.length > 0 && r2._id.length > 0 && r3._id.length > 0, 'insert 3 行成功');

  // --- 4. ModelEntity.update ---
  console.log('\n═══ 4. ModelEntity.update ═══');
  const u1 = await Item.update(r1._id, { score: 99 });
  assert(u1 !== undefined && u1.score === 99, 'update：score 合并为 99');
  assert(u1!.name === 'A', 'update：未修改字段保留');
  assert(u1!._id === r1._id && u1!._createdAt === r1._createdAt, 'update：_id / _createdAt 不变');

  const qAfterUpdate = await engine.query('Item', [r1._id]).execute();
  assert(
    qAfterUpdate.length === 1 && qAfterUpdate[0]!.getData().score === 99,
    '合并读：update 后 query 立即可见新值',
  );

  const uMissing = await Item.update('nonexistent-id', { score: 0 });
  assert(uMissing === undefined, 'update 不存在的 id → undefined');

  // --- 5. ModelEntity.delete ---
  console.log('\n═══ 5. ModelEntity.delete ═══');
  const delOk = await Item.delete(r2._id);
  assert(delOk === true, 'delete 已有行 → true');

  const qAfterDel = await engine.query('Item', [r2._id]).execute();
  assert(qAfterDel.length === 0, '合并读：delete 后 query 立即不可见');

  const allAfterDel = await Item.query().execute();
  assert(allAfterDel.length === 2, `全量查询：剩余 2 行（实际 ${allAfterDel.length}）`);

  const delAgain = await Item.delete(r2._id);
  assert(delAgain === false, '重复 delete 同一 id → false');

  const delMissing = await Item.delete('nonexistent-id');
  assert(delMissing === false, 'delete 不存在的 id → false');

  // update on deleted row should return undefined
  const uDeleted = await Item.update(r2._id, { score: 0 });
  assert(uDeleted === undefined, 'update 已删除行 → undefined');

  // --- 6. AuthoringEngine facade ---
  console.log('\n═══ 6. AuthoringEngine facade update / delete ═══');
  const r4 = await engine.insert('Item', { name: 'D', status: 'active', score: 40 });
  const eu = await engine.update('Item', r4._id, { score: 44 });
  assert(eu !== undefined && eu.score === 44, 'engine.update 合并成功');

  const ed = await engine.delete('Item', r4._id);
  assert(ed === true, 'engine.delete → true');
  const qd = await engine.query('Item', [r4._id]).execute();
  assert(qd.length === 0, 'engine.delete 后 query 不可见');

  // --- 7. updateWhere / deleteWhere ---
  console.log('\n═══ 7. updateWhere / deleteWhere ═══');
  await Item.insert({ name: 'E', status: 'active', score: 50 });
  await Item.insert({ name: 'F', status: 'active', score: 60 });
  await Item.insert({ name: 'G', status: 'idle', score: 70 });

  const pred: PredicateNode = { type: 'atom', field: 'status', op: 'eq', value: 'active' };
  const updated = await Item.updateWhere(pred, { status: 'archived' });
  assert(updated.length >= 2, `updateWhere(status=active)：命中 ≥2 行（实际 ${updated.length}）`);
  assert(
    updated.every((r) => r.status === 'archived'),
    'updateWhere：所有命中行 status → archived',
  );

  const qArchived = await Item.query().where('status', 'eq', 'archived').execute();
  assert(
    qArchived.length === updated.length,
    `合并读：updateWhere 后 query(status=archived) 行数一致 (${qArchived.length})`,
  );

  const delPred: PredicateNode = { type: 'atom', field: 'status', op: 'eq', value: 'idle' };
  const delCount = await Item.deleteWhere(delPred);
  assert(delCount >= 1, `deleteWhere(status=idle)：删除 ≥1 行（实际 ${delCount}）`);

  const qIdle = await Item.query().where('status', 'eq', 'idle').execute();
  assert(qIdle.length === 0, '合并读：deleteWhere 后 idle 行不可见');

  // engine-level batch
  await engine.insert('Item', { name: 'H', status: 'temp', score: 80 });
  await engine.insert('Item', { name: 'I', status: 'temp', score: 90 });
  const engUpdated = await engine.updateWhere(
    'Item',
    { type: 'atom', field: 'status', op: 'eq', value: 'temp' },
    { status: 'done' },
  );
  assert(engUpdated.length === 2, `engine.updateWhere(temp→done)：命中 2 行`);

  const engDelCount = await engine.deleteWhere('Item', {
    type: 'atom',
    field: 'status',
    op: 'eq',
    value: 'done',
  });
  assert(engDelCount === 2, `engine.deleteWhere(done)：删除 2 行`);

  // --- 8. 关系层：delete 清理 rid 边，模型独立性 ---
  console.log('\n═══ 8. delete 关系层清理（模型独立性） ═══');

  engine.registerModel('Pump', new Set(['name', 'zoneCode']));
  engine.registerModel('Zone', new Set(['code', 'label']));
  engine.registerRelation('Pump', 'Zone', 'located_in', 'has_pump', 'many-to-one', {
    sourceField: 'zoneCode',
    targetField: 'code',
  });

  const PumpM = engine.model('Pump');
  const ZoneM = engine.model('Zone');

  const z1 = await ZoneM.insert({ code: 'Z-A', label: '分区A' });
  const z2 = await ZoneM.insert({ code: 'Z-B', label: '分区B' });
  const p1 = await PumpM.insert({ name: '泵1', zoneCode: 'Z-A' });
  const p2 = await PumpM.insert({ name: '泵2', zoneCode: 'Z-A' });
  const p3 = await PumpM.insert({ name: '泵3', zoneCode: 'Z-B' });

  await engine.flushAll();
  await engine.bind('located_in', 'PROTOCOL');

  const fwdBefore = await engine.indexer.getForward(
    engine.registry.getRelations().find((r) => r.forward === 'located_in')!,
    p1._id,
  );
  assert(fwdBefore.length === 1 && fwdBefore[0] === z1._id, 'bind 后 p1 → z1 边存在');

  const revBefore = await engine.indexer.getReverse(
    engine.registry.getRelations().find((r) => r.forward === 'located_in')!,
    z1._id,
  );
  assert(revBefore.includes(p1._id) && revBefore.includes(p2._id), 'bind 后 z1 ← {p1,p2} 反向边');

  await PumpM.delete(p1._id);

  const fwdAfter = await engine.indexer.getForward(
    engine.registry.getRelations().find((r) => r.forward === 'located_in')!,
    p1._id,
  );
  assert(fwdAfter.length === 0, 'delete 后 p1 的正向边已清除');

  const revAfter = await engine.indexer.getReverse(
    engine.registry.getRelations().find((r) => r.forward === 'located_in')!,
    z1._id,
  );
  assert(!revAfter.includes(p1._id), 'delete 后 z1 的反向边不再含 p1');
  assert(revAfter.includes(p2._id), 'delete 后 z1 ← p2 边仍在（模型独立）');

  const zoneQuery = await ZoneM.query().execute();
  assert(zoneQuery.length === 2, `模型独立性：Zone 仍有 ${zoneQuery.length} 行（应为 2）`);

  const p3fwd = await engine.indexer.getForward(
    engine.registry.getRelations().find((r) => r.forward === 'located_in')!,
    p3._id,
  );
  assert(p3fwd.length === 1 && p3fwd[0] === z2._id, 'p3 → z2 边不受 p1 删除影响');

  // --- 9. deleteWhere 批量删除也清理关系 ---
  console.log('\n═══ 9. deleteWhere 批量关系清理 ═══');

  const delWhereCnt = await PumpM.deleteWhere({
    type: 'atom',
    field: 'zoneCode',
    op: 'eq',
    value: 'Z-A',
  });
  assert(delWhereCnt === 1, `deleteWhere(zoneCode=Z-A)：删除 p2（实际 ${delWhereCnt}）`);

  const revAfterBatch = await engine.indexer.getReverse(
    engine.registry.getRelations().find((r) => r.forward === 'located_in')!,
    z1._id,
  );
  assert(revAfterBatch.length === 0, 'deleteWhere 后 z1 反向边全部清空');
  assert(p3fwd[0] === z2._id, 'p3 → z2 边仍在');

  const pumpQuery = await PumpM.query().execute();
  assert(pumpQuery.length === 1, `Pump 仅剩 p3（实际 ${pumpQuery.length}）`);
  assert(pumpQuery[0]!.getData().name === '泵3', 'Pump 剩余行为 p3');

  // --- 10. sync + flush 压缩 ---
  console.log('\n═══ 10. sync + flush 压缩（__deleted 物理移除） ═══');
  const r5 = await Item.insert({ name: 'Z', status: 'live', score: 100 }, { sync: true });
  const vaultPath = atlasVaultPath(DATA_ROOT, ATLAS);
  assert(existsSync(vaultPath), 'insert sync 后 atlas.mld 存在');

  await Item.delete(r5._id, { sync: true });
  let itemBlob = loadVaultModelBlob(DATA_ROOT, ATLAS, 'Item', INTEGRATION_VAULT_SECRET);
  let itemRows = vaultItemDataRows(itemBlob);
  assert(
    !itemRows.some((r) => r._id === r5._id),
    'delete sync 后 Vault Item blob 中不含已删除行的 _id（压缩生效）',
  );
  assert(
    !itemRows.some((r) => r[DELETED_SENTINEL] === true),
    'Vault Item blob 中无 __deleted 墓碑残留',
  );

  // update + sync
  const remaining = await Item.query().execute();
  if (remaining.length > 0) {
    const target = remaining[0]!.getData() as ModelRecord;
    await Item.update(target._id, { score: 999 }, { sync: true });
    itemBlob = loadVaultModelBlob(DATA_ROOT, ATLAS, 'Item', INTEGRATION_VAULT_SECRET);
    itemRows = vaultItemDataRows(itemBlob);
    assert(
      itemRows.some((r) => r.score === 999),
      'update sync 后 Vault Item 数据行含 score 999',
    );
  }

  await engine.flushAll();
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  auditMergeDeletedFilter();
  auditDeletedHelpers();
  await auditEngineCrud();

  console.log('\n════════════════════════════════════════════════════════════');
  console.log(`  crud_audit 结果：通过 ${passed}，失败 ${failed}`);
  console.log('════════════════════════════════════════════════════════════');

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

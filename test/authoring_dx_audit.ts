/**
 * 治理端 DX 专项：`mergeDiskRowsWithAuthoringBuffer`、`QueryEngine.execute`、Model 句柄缓存、
 * `updateFields` 去重、合并读、`engine.insert(..., { sync: true })`。
 *
 * Run:  npx tsx test/authoring_dx_audit.ts
 *       npm run dx-audit
 *       npm run test:integration（最后一项）
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { configureModelDBStorageRoot } from '@mode-db/common';
import { AuthoringEngine } from '../packages/core/src/authoring/AuthoringEngine.js';
import {
  atlasVaultPath,
  integrationVaultAuthoringOptions,
  useIntegrationVaultEnv,
} from './integration-vault.js';
import { mergeDiskRowsWithAuthoringBuffer, QueryEngine } from '../packages/core/src/runtime/query-engine.js';
import type { ModelRecord } from '@mode-db/common';
import type { PredicateNode } from '../packages/core/src/runtime/predicate-tree.js';

const DATA_ROOT = join(process.cwd(), 'data');
const ATLAS = 'dx_audit';

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

function auditMergeHelper(): void {
  const disk: ModelRecord[] = [
    { _id: 'u1', _createdAt: '2026-01-01T00:00:00.000Z', v: 1 },
    { _id: 'u2', _createdAt: '2026-01-01T00:00:00.000Z', v: 2 },
  ];
  const pending = new Map<string, ModelRecord>([
    ['u1', { _id: 'u1', _createdAt: '2026-01-01T00:00:00.000Z', v: 99 }],
    ['u3', { _id: 'u3', _createdAt: '2026-01-01T00:00:00.000Z', v: 3 }],
  ]);
  const merged = mergeDiskRowsWithAuthoringBuffer(disk, pending);
  const byId = new Map(merged.map((r) => [r._id, r]));
  assert(byId.get('u1')!.v === 99, 'mergeDiskRowsWithAuthoringBuffer：同 _id 以缓冲行为准');
  assert(byId.get('u2')!.v === 2, 'mergeDiskRowsWithAuthoringBuffer：仅磁盘有的行保留');
  assert(byId.get('u3')!.v === 3, 'mergeDiskRowsWithAuthoringBuffer：仅缓冲有的行追加');

  const emptyPending = mergeDiskRowsWithAuthoringBuffer(disk, new Map());
  assert(
    emptyPending.length === 2 && emptyPending[0]!._id === 'u1',
    'pending 为空时等价于磁盘快照',
  );
}

function auditQueryEngineExecute(): void {
  const row: ModelRecord = {
    _id: 'x',
    _createdAt: '2026-01-01T00:00:00.000Z',
    n: 42,
  };
  const node: PredicateNode = { type: 'atom', field: 'n', op: 'eq', value: 42 };
  const e1 = QueryEngine.evaluate(row, node);
  const e2 = QueryEngine.execute(row, node);
  assert(e1.ok === e2.ok && e1.ok === true, 'QueryEngine.execute 与 evaluate 对同一行应一致');
}

async function main(): Promise<void> {
  configureModelDBStorageRoot({ storageRoot: DATA_ROOT });
  useIntegrationVaultEnv();
  await rm(join(DATA_ROOT, ATLAS), { recursive: true, force: true });

  auditMergeHelper();
  auditQueryEngineExecute();

  const engine = new AuthoringEngine({
    atlas: ATLAS,
    storageRoot: DATA_ROOT,
    ...integrationVaultAuthoringOptions,
  });
  engine.registerModel('Dx', new Set(['id']));

  const Dx = engine.model('Dx');
  assert(engine.model('Dx') === Dx, 'AtlasRegistry.model 应返回缓存的同一 ModelEntity');

  Dx.updateFields(['id', 'name', 'id']);
  const def = engine.registry.getModel('Dx');
  assert(
    def !== undefined && def.fields.size === 2 && def.fields.has('name'),
    'updateFields 应对 string[] 去重',
  );

  const r1 = await Dx.insert({ id: 'a1', name: '一' });
  const q1 = await engine.query('Dx', [r1._id]).execute();
  assert(q1.length === 1 && q1[0]!.getData().id === 'a1', '合并读：insert 后 query 可见');

  await engine.insert('Dx', { id: 'a2', name: '二' }, { sync: true });
  assert(
    existsSync(atlasVaultPath(DATA_ROOT, ATLAS)),
    'engine.insert(..., { sync: true }) 后 atlas.mld 应存在',
  );

  await engine.flushAll();

  console.log('authoring_dx_audit: 全部通过');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

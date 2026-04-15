/**
 * Meta-CRUD: `AuthoringEngine.alterModel` / `dropRelation` / `dropModel`，以及
 * WebSocket 线路上 `RemoteModelDBClient` 的同名 RPC（`orphan:m:*` 快照、Vault 关系键清理）。
 *
 * **独立 Atlas**：`meta_crud_rt`（进程内编排）、`meta_crud_wire_rt`（RPC）。与其它脚本无目录冲突。
 * **单跑**：`npx tsx test/meta_crud_audit.ts`（需集成 Vault 环境；见 [README.md](./README.md)）。
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { configureModelDBStorageRoot, PathResolver, DataType, type FieldDefsRecord } from '@mode-db/common';
import { AuthoringEngine } from '../src/authoring/AuthoringEngine.js';
import { AtlasSingleVault } from '../authoring/atlas-single-vault.js';
import {
  getWebSocketServerListeningPort,
  startModelDBWebSocketServer,
} from '../packages/server/dist/index.js';
import { RemoteModelDBClient } from '../packages/sdk/src/index.js';
import {
  integrationVaultAuthoringOptions,
  integrationVaultDerivedSecret,
  INTEGRATION_CONNECT_TOKEN,
  loadVaultRelationData,
  useIntegrationVaultEnv,
} from './integration-vault.js';

const DATA_ROOT = join(process.cwd(), 'data');
const ATLAS_LOCAL = 'meta_crud_rt';
const ATLAS_WIRE = 'meta_crud_wire_rt';

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

function section(title: string): void {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
}

function orphanModelBlob(
  storageRoot: string,
  atlas: string,
  modelName: string,
): string | undefined {
  const paths = new PathResolver(storageRoot, atlas);
  const vault = new AtlasSingleVault();
  const ok = vault.loadSync(paths.atlasSingleVaultPath(), integrationVaultDerivedSecret);
  if (!ok) {
    return undefined;
  }
  return vault.get(AtlasSingleVault.orphanModelKey(modelName));
}

useIntegrationVaultEnv();
configureModelDBStorageRoot({ storageRoot: DATA_ROOT });

section('0. 清理本脚本 Atlas 目录');
await rm(join(DATA_ROOT, ATLAS_LOCAL), { recursive: true, force: true });
await rm(join(DATA_ROOT, ATLAS_WIRE), { recursive: true, force: true });
assert(true, `已删除 data/${ATLAS_LOCAL} 与 data/${ATLAS_WIRE}`);

// ---------------------------------------------------------------------------
// A. 进程内 AuthoringEngine
// ---------------------------------------------------------------------------

section('1. 本地：建模 + MANUAL 绑定 + flush');
const engine = new AuthoringEngine({
  atlas: ATLAS_LOCAL,
  storageRoot: DATA_ROOT,
  ...integrationVaultAuthoringOptions,
});
engine.registerModel('Alpha', new Set(['id']));
engine.registerModel('Beta', new Set(['id']));
engine.quickLink('Alpha', 'Beta', 'owns', 'owned_by');
const rowA = await engine.insert('Alpha', { id: 'a1' });
const rowB = await engine.insert('Beta', { id: 'b1' });
await engine.bind('owns', 'MANUAL', { pairs: [[rowA._id, rowB._id]] });
await engine.flushAll();

const ridLocal = 'Alpha-Beta-owns';
const idxBefore = loadVaultRelationData(DATA_ROOT, ATLAS_LOCAL, ridLocal);
assert(Object.keys(idxBefore.fwd).length >= 1, 'Vault 关系索引 fwd 非空（已绑定）');

section('2. alterModel：非破坏性字段合并');
const alterSchema: FieldDefsRecord = {
  id: DataType.String,
  note: { type: DataType.String, required: false },
};
engine.alterModel('Alpha', alterSchema);
await engine.insert('Alpha', { id: 'a2', note: 'hello' });
await engine.flushAll();
const reopened = new AuthoringEngine({
  atlas: ATLAS_LOCAL,
  storageRoot: DATA_ROOT,
  ...integrationVaultAuthoringOptions,
});
assert(reopened.registry.getModel('Alpha')?.fields.has('note'), '重开引擎后 Alpha 含 note 字段');

section('3. dropRelation：拓扑与 Vault r:* 键移除');
await reopened.dropRelation('owns');
assert(reopened.registry.findRelationByLabel('owns') === undefined, '注册表中已无 owns');
const idxAfterDropRel = loadVaultRelationData(DATA_ROOT, ATLAS_LOCAL, ridLocal);
assert(
  Object.keys(idxAfterDropRel.fwd).length === 0 && Object.keys(idxAfterDropRel.rev).length === 0,
  'Vault 中关系索引被清空',
);

section('4. dropModel：orphan:m:* 与注册表');
await reopened.dropModel('Beta');
assert(reopened.registry.getModel('Beta') === undefined, 'Beta 已从注册表移除');
assert(
  orphanModelBlob(DATA_ROOT, ATLAS_LOCAL, 'Beta') !== undefined &&
    (orphanModelBlob(DATA_ROOT, ATLAS_LOCAL, 'Beta')?.length ?? 0) > 0,
  'Beta 模型 blob 迁至 orphan:m:Beta',
);
assert(
  !existsSync(join(DATA_ROOT, ATLAS_LOCAL, 'models')) &&
    existsSync(new PathResolver(DATA_ROOT, ATLAS_LOCAL).atlasSingleVaultPath()),
  '仍为单文件 atlas.mld（无 models/）',
);

await reopened.dropModel('Alpha');
assert(reopened.registry.getModel('Alpha') === undefined, 'Alpha 已从注册表移除');
assert(
  (orphanModelBlob(DATA_ROOT, ATLAS_LOCAL, 'Alpha')?.length ?? 0) > 0,
  'Alpha 数据迁至 orphan:m:Alpha',
);

// ---------------------------------------------------------------------------
// B. RemoteModelDBClient（线协议）
// ---------------------------------------------------------------------------

section('5. RPC：alterModel → dropRelation → dropModel');
const wireEngine = new AuthoringEngine({
  atlas: ATLAS_WIRE,
  storageRoot: DATA_ROOT,
  ...integrationVaultAuthoringOptions,
});
wireEngine.registerModel('Alpha2', new Set(['id']));
wireEngine.registerModel('Beta2', new Set(['id']));
wireEngine.quickLink('Alpha2', 'Beta2', 'links', 'linked_by');
const a2 = await wireEngine.insert('Alpha2', { id: 'x1' });
const b2 = await wireEngine.insert('Beta2', { id: 'y1' });
await wireEngine.bind('links', 'MANUAL', { pairs: [[a2._id, b2._id]] });
await wireEngine.flushAll();

const wss = await startModelDBWebSocketServer({
  port: 0,
  host: '127.0.0.1',
  storageRoot: DATA_ROOT,
  connectToken: INTEGRATION_CONNECT_TOKEN,
  dev: false,
});
try {
  const port = getWebSocketServerListeningPort(wss);
  const remote = await RemoteModelDBClient.connectNetwork({
    host: '127.0.0.1',
    port,
    token: INTEGRATION_CONNECT_TOKEN,
    database: ATLAS_WIRE,
  });
  try {
    const rpcSchema: Readonly<Record<string, unknown>> = {
      id: DataType.String,
      tag: { type: DataType.String, required: false },
    };
    await remote.alterModel('Alpha2', rpcSchema);
    await remote.alterModel(
      'Alpha2',
      { extra: { type: DataType.String, required: false } },
      { patch: true },
    );
    await remote.dropRelation('links');
    await remote.dropModel('Beta2');
  } finally {
    remote.close();
  }
} finally {
  await wss.close();
}

const afterRpc = new AuthoringEngine({
  atlas: ATLAS_WIRE,
  storageRoot: DATA_ROOT,
  ...integrationVaultAuthoringOptions,
});
assert(afterRpc.registry.getModel('Beta2') === undefined, 'RPC dropModel 后 Beta2 不在注册表');
assert(afterRpc.registry.findRelationByLabel('links') === undefined, 'RPC dropRelation 后 links 消失');
const idxWire = loadVaultRelationData(DATA_ROOT, ATLAS_WIRE, 'Alpha2-Beta2-links');
assert(
  Object.keys(idxWire.fwd).length === 0,
  'Alpha2-Beta2-links 的 Vault 索引已空',
);
assert(
  (orphanModelBlob(DATA_ROOT, ATLAS_WIRE, 'Beta2')?.length ?? 0) > 0,
  'Beta2 blob 位于 orphan:m:Beta2',
);
assert(
  afterRpc.registry.getModel('Alpha2')?.fields.has('tag'),
  'RPC alterModel 后 Alpha2 含 tag 字段（非破坏合并）',
);
assert(
  afterRpc.registry.getModel('Alpha2')?.fields.has('extra'),
  'RPC alterModel(..., { patch: true }) 增量增加 extra',
);

console.log(`\nmeta_crud_audit: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

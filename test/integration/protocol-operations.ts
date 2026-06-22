/**
 * Unified Engine Operation Protocol (JSON) 回归测试：所有引擎操作都能以 JSON 协议（`apply` / `applyAll`）执行，
 * 且与现有函数式 API 行为一致（双支持），为 Model Designer / Query Designer 提供可序列化的操作配置。
 *
 * 覆盖：
 *  1. 核心进程内 `AuthoringEngine.apply / applyAll`（database 作用域）：batchRegister → insert → bind →
 *     relationStats → previewBind → update，全部走 JSON 协议，并用函数式读取校验落库一致。
 *  2. 工作区作用域 `ModelDB.apply`：createDatabase / listDatabases / catalog / dropDatabase 走管理端协议。
 *  3. 数据库作用域 `RemoteModelDBClient.apply / applyAll`（经服务端共享执行器）：建模 / 写入 / 绑定 / 查询。
 *  4. 函数式 vs JSON 查询平价：同一条 `Country -> cities` 查询分别用 `.execute()` 与
 *     `apply({ op: 'executeQuery', snapshot })` 运行，结果（行数 / 子行）一致。
 *  5. 数据清除：`clearModelData` / `clearAllData` 经 JSON 协议执行，schema 保留。
 *
 * Run: `pnpm run build:*` 后 `npx tsx test/integration/protocol-operations.ts`。
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
import {
  ModelDB,
  RemoteHydratedEntity,
  type EngineOperation,
  type EngineOperationResult,
} from '@mode-db/sdk';
import { INTEGRATION_CONNECT_TOKEN, useIntegrationVaultEnv } from './vault-env.js';

const WORKSPACE = join(process.cwd(), 'data', 'protocol_ops_workspace');
const CORE_ATLAS = 'protocol_core';
const REMOTE_ATLAS = 'protocol_remote';
const CONFIG_PATH = join(WORKSPACE, 'modeldb.config.json');

let passed = 0;
let failed = 0;

function ok(cond: boolean, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  \u2713 ${msg}`);
  } else {
    failed++;
    console.error(`  \u2717 ${msg}`);
  }
}

function section(title: string): void {
  console.log(`\n${'='.repeat(60)}\n  ${title}\n${'='.repeat(60)}`);
}

function asRecord(x: unknown): Record<string, unknown> {
  return (x ?? {}) as Record<string, unknown>;
}

/** Pull the new `_id` out of an `insert` mutation result. */
function insertedId(result: EngineOperationResult): string {
  const rec = asRecord(asRecord(result).record);
  const id = rec._id;
  if (typeof id !== 'string') {
    throw new Error(`insert result missing _id: ${JSON.stringify(result)}`);
  }
  return id;
}

const COUNTRY_SCHEMA: FieldDefsRecord = {
  id: DataType.String,
  name: { type: DataType.String, required: true },
};
const CITY_SCHEMA: FieldDefsRecord = {
  id: DataType.String,
  name: { type: DataType.String, required: true },
};

/** Models + Country->City relation registered through one JSON `batchRegister` op. */
const SCHEMA_OP: EngineOperation = {
  op: 'batchRegister',
  models: [
    { name: 'Country', schema: COUNTRY_SCHEMA as Record<string, unknown> },
    { name: 'City', schema: CITY_SCHEMA as Record<string, unknown> },
  ],
  relations: [
    { source: 'Country', target: 'City', forward: 'cities', reverse: 'country', logic: 'one-to-many' },
  ],
};

useIntegrationVaultEnv();
configureModelDBStorageRoot({ storageRoot: WORKSPACE });

section('0. Reset workspace');
mkdirSync(WORKSPACE, { recursive: true });
rmSync(join(WORKSPACE, CORE_ATLAS), { recursive: true, force: true });
rmSync(join(WORKSPACE, REMOTE_ATLAS), { recursive: true, force: true });
writeFileSync(
  CONFIG_PATH,
  JSON.stringify({ connectToken: INTEGRATION_CONNECT_TOKEN, workspace: '.' }, null, 2),
  'utf-8',
);
ok(true, `workspace ${WORKSPACE} ready`);

// ---------------------------------------------------------------------------
section('1. Core in-process: AuthoringEngine.apply / applyAll (database scope)');
// ---------------------------------------------------------------------------
const engine = new AuthoringEngine({
  atlas: CORE_ATLAS,
  storageRoot: WORKSPACE,
  connectToken: INTEGRATION_CONNECT_TOKEN,
});

const schemaRes = await engine.apply(SCHEMA_OP);
ok(
  asRecord(schemaRes).op === 'batchRegister' && asRecord(schemaRes).ok === true,
  'apply(batchRegister) registered models + relation',
);
ok(
  engine.registry.getModel('Country') !== undefined && engine.registry.getModel('City') !== undefined,
  'fluent registry sees Country + City after JSON DDL (dual support)',
);

const coreInserts = await engine.applyAll([
  { op: 'insert', model: 'Country', data: { id: 'jp', name: 'Japan' } },
  { op: 'insert', model: 'Country', data: { id: 'cn', name: 'China' } },
  { op: 'insert', model: 'City', data: { id: 'tokyo', name: 'Tokyo' } },
  { op: 'insert', model: 'City', data: { id: 'osaka', name: 'Osaka' } },
  { op: 'insert', model: 'City', data: { id: 'beijing', name: 'Beijing' } },
]);
ok(coreInserts.length === 5 && coreInserts.every((o) => o.ok), 'applyAll inserted 5 rows (all ok)');

const jpId = insertedId(coreInserts[0]!.result!);
const cnId = insertedId(coreInserts[1]!.result!);
const tokyoId = insertedId(coreInserts[2]!.result!);
const osakaId = insertedId(coreInserts[3]!.result!);
const beijingId = insertedId(coreInserts[4]!.result!);

const coreBind = await engine.apply({
  op: 'bind',
  forward: 'cities',
  strategy: 'MANUAL',
  pairs: [
    [jpId, tokyoId],
    [jpId, osakaId],
    [cnId, beijingId],
  ],
});
ok(asRecord(coreBind).ok === true && asRecord(coreBind).pairsCount === 3, 'apply(bind MANUAL) linked 3 pairs');

const coreStats = await engine.apply({ op: 'relationStats', forward: 'cities' });
ok(
  asRecord(coreStats).kind === 'relationStats' &&
    asRecord(coreStats).forwardKeys === 2 &&
    asRecord(coreStats).totalLinks === 3,
  `apply(relationStats): forwardKeys=2 totalLinks=3 (got ${asRecord(coreStats).forwardKeys}/${asRecord(coreStats).totalLinks})`,
);

const corePreview = await engine.apply({ op: 'previewBind', forward: 'cities', strategy: 'GLOBAL' });
ok(
  asRecord(corePreview).kind === 'previewBind' && asRecord(corePreview).pairsCount === 6,
  `apply(previewBind GLOBAL) cross-join count = 2x3 = 6 (got ${asRecord(corePreview).pairsCount})`,
);

const coreUpdate = await engine.apply({
  op: 'update',
  model: 'City',
  id: tokyoId,
  partial: { name: 'Tokyo-Metropolis' },
});
ok(asRecord(asRecord(coreUpdate).record).name === 'Tokyo-Metropolis', 'apply(update) mutated City.name');

// Reject workspace-scope op on the engine.
let coreRejected = false;
try {
  await engine.apply({ op: 'listDatabases' } as EngineOperation);
} catch {
  coreRejected = true;
}
ok(coreRejected, 'engine.apply rejects workspace-scope op (listDatabases)');

// failFast: a bad op stops the batch.
const coreFailFast = await engine.applyAll(
  [
    { op: 'insert', model: 'Country', data: { id: 'us', name: 'USA' } },
    { op: 'insert', model: 'DoesNotExist', data: { id: 'x' } },
    { op: 'insert', model: 'Country', data: { id: 'never', name: 'Never' } },
  ],
  { failFast: true },
);
ok(
  coreFailFast.length === 2 && coreFailFast[0]!.ok && !coreFailFast[1]!.ok,
  'applyAll(failFast) stops after first failure (2 outcomes, 2nd failed)',
);

section('1b. Core: clearModelData / clearAllData via apply');
const clearCity = await engine.apply({ op: 'clearModelData', model: 'City' });
ok(asRecord(clearCity).deletedCount === 3, `clearModelData removed 3 City rows (got ${asRecord(clearCity).deletedCount})`);

const statsAfterCityClear = await engine.apply({ op: 'relationStats', forward: 'cities' });
ok(asRecord(statsAfterCityClear).totalLinks === 0, 'relation index empty after City data cleared');

const clearAllCore = await engine.apply({ op: 'clearAllData' });
ok(
  asRecord(clearAllCore).deletedCount === 3 && asRecord(clearAllCore).ok === true,
  `clearAllData removed remaining Country rows incl. failFast insert (got ${asRecord(clearAllCore).deletedCount})`,
);
ok(
  engine.registry.getModel('Country') !== undefined && engine.registry.getModel('City') !== undefined,
  'schema kept after clearAllData',
);

await engine.flushAll();

// ---------------------------------------------------------------------------
section('2. Start ModelDB server');
// ---------------------------------------------------------------------------
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

  section('3. Workspace scope via ModelDB.apply: createDatabase / listDatabases');
  const created = await modeldb.apply({ op: 'createDatabase', name: REMOTE_ATLAS });
  ok(
    asRecord(created).kind === 'database' && asRecord(created).op === 'createDatabase' && asRecord(created).ok === true,
    'apply(createDatabase) created logical library',
  );
  const listed = await modeldb.apply({ op: 'listDatabases' });
  const listedNames = Array.isArray(asRecord(listed).databases)
    ? (asRecord(listed).databases as { name: string }[]).map((d) => d.name)
    : [];
  ok(
    asRecord(listed).kind === 'databases' && listedNames.includes(REMOTE_ATLAS),
    `apply(listDatabases) includes "${REMOTE_ATLAS}"`,
  );

  section('4. Database scope via RemoteModelDBClient.apply / applyAll');
  const remote = await modeldb.use(REMOTE_ATLAS);

  const ddlOutcomes = await remote.applyAll([
    SCHEMA_OP,
    { op: 'insert', model: 'Country', data: { id: 'jp', name: 'Japan' } },
    { op: 'insert', model: 'Country', data: { id: 'cn', name: 'China' } },
    { op: 'insert', model: 'City', data: { id: 'tokyo', name: 'Tokyo' } },
    { op: 'insert', model: 'City', data: { id: 'osaka', name: 'Osaka' } },
    { op: 'insert', model: 'City', data: { id: 'beijing', name: 'Beijing' } },
  ]);
  ok(ddlOutcomes.length === 6 && ddlOutcomes.every((o) => o.ok), 'remote.applyAll DDL + 5 inserts all ok');

  const rJp = insertedId(ddlOutcomes[1]!.result!);
  const rCn = insertedId(ddlOutcomes[2]!.result!);
  const rTokyo = insertedId(ddlOutcomes[3]!.result!);
  const rOsaka = insertedId(ddlOutcomes[4]!.result!);
  const rBeijing = insertedId(ddlOutcomes[5]!.result!);

  const remoteBind = await remote.apply({
    op: 'bind',
    forward: 'cities',
    strategy: 'MANUAL',
    pairs: [
      [rJp, rTokyo],
      [rJp, rOsaka],
      [rCn, rBeijing],
    ],
  });
  ok(asRecord(remoteBind).ok === true && asRecord(remoteBind).pairsCount === 3, 'remote.apply(bind) linked 3 pairs');

  const remoteStats = await remote.apply({ op: 'relationStats', forward: 'cities' });
  ok(
    asRecord(remoteStats).forwardKeys === 2 && asRecord(remoteStats).totalLinks === 3,
    'remote.apply(relationStats) forwardKeys=2 totalLinks=3',
  );

  section('5. Fluent vs JSON query parity (Country with cities attached)');
  const fluentRows = (await remote
    .model('Country')
    .query()
    .group('cities')
    .execute()) as RemoteHydratedEntity[];

  const snapshot = remote.model('Country').query().group('cities').getRemoteExecuteSnapshot();
  const jsonResult = await remote.apply({ op: 'executeQuery', snapshot });
  const jsonRows =
    asRecord(jsonResult).kind === 'rows'
      ? (asRecord(jsonResult).rows as { model: string; data: Record<string, unknown> }[])
      : [];

  ok(
    fluentRows.length === 2 && jsonRows.length === 2,
    `both paths return 2 Country rows (fluent=${fluentRows.length}, json=${jsonRows.length})`,
  );

  const fluentJp = fluentRows.find((e) => e.getData().id === 'jp');
  const fluentJpCities = ((fluentJp?.getData().relates as Record<string, unknown> | undefined)
    ?.cities as unknown[] | undefined)?.length;
  const jsonJp = jsonRows.find((r) => r.data.id === 'jp');
  const jsonJpCities = ((jsonJp?.data.relates as Record<string, unknown> | undefined)?.cities as
    | unknown[]
    | undefined)?.length;
  ok(
    fluentJpCities === 2 && jsonJpCities === 2,
    `Japan carries 2 cities in both paths (fluent=${fluentJpCities}, json=${jsonJpCities})`,
  );

  section('5b. Remote: clearModelData / clearAllData via apply');
  const remoteClearCity = await remote.apply({ op: 'clearModelData', model: 'City' });
  ok(
    asRecord(remoteClearCity).deletedCount === 3,
    `remote clearModelData removed 3 cities (got ${asRecord(remoteClearCity).deletedCount})`,
  );
  const remoteClearAll = await remote.apply({ op: 'clearAllData' });
  ok(
    asRecord(remoteClearAll).deletedCount === 2 && asRecord(remoteClearAll).ok === true,
    `remote clearAllData removed 2 countries (got ${asRecord(remoteClearAll).deletedCount})`,
  );

  section('6. Workspace catalog + dropDatabase via ModelDB.apply');
  const catalog = await modeldb.apply({ op: 'catalog', database: REMOTE_ATLAS });
  const catalogModels = Array.isArray(asRecord(catalog).models)
    ? (asRecord(catalog).models as { name: string }[]).map((m) => m.name)
    : [];
  ok(
    asRecord(catalog).kind === 'catalog' &&
      catalogModels.includes('Country') &&
      catalogModels.includes('City'),
    `apply(catalog) lists Country + City (got [${catalogModels.join(', ')}])`,
  );

  remote.close();
  modeldb.releaseClient(REMOTE_ATLAS);

  const dropped = await modeldb.apply({ op: 'dropDatabase', name: REMOTE_ATLAS });
  ok(
    asRecord(dropped).kind === 'database' && asRecord(dropped).op === 'dropDatabase' && asRecord(dropped).ok === true,
    'apply(dropDatabase) removed logical library',
  );
  const afterDrop = await modeldb.apply({ op: 'listDatabases' });
  const afterNames = Array.isArray(asRecord(afterDrop).databases)
    ? (asRecord(afterDrop).databases as { name: string }[]).map((d) => d.name)
    : [];
  ok(!afterNames.includes(REMOTE_ATLAS), 'listDatabases no longer includes the dropped library');
} finally {
  await app.close();
}

console.log(`\nprotocol-operations: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

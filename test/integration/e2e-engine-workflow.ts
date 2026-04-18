/**
 * End-to-end workflow: start server → SDK connect → schema already authored locally → query/import → meta RPC → local update/delete.
 *
 * Wire note: **`registerModel` / `registerRelation` / `bind`** are not exposed as RPC; integration tests use {@link AuthoringEngine} for DDL, then {@link ModelDB} / {@link RemoteModelDBClient} for wire DML/query and **`alterModel`**.
 *
 * Run: **`pnpm run test:integration`** (from repo root) or **`npx tsx test/integration/e2e-engine-workflow.ts`** after **`pnpm run build:server && pnpm run build:sdk`**.
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

const WORKSPACE = join(process.cwd(), 'data', 'e2e_engine_workspace');
const ATLAS = 'e2e_engine_flow';
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

section('1. AuthoringEngine: create logical DB, models (inheritance), relation, bind, seed');
const ddl = new AuthoringEngine({
  atlas: ATLAS,
  storageRoot: WORKSPACE,
  connectToken: INTEGRATION_CONNECT_TOKEN,
});

const baseSchema: FieldDefsRecord = {
  id: DataType.String,
  name: { type: DataType.String, required: true },
};
ddl.registerModel('Person', baseSchema);
const childSchema: FieldDefsRecord = {
  id: DataType.String,
  name: { type: DataType.String, required: true },
  badge: { type: DataType.String, required: false },
};
ddl.registerModel('Employee', childSchema, 'Person');
ddl.quickLink('Person', 'Employee', 'manages', 'reports_to');
const p = await ddl.insert('Person', { id: 'p1', name: 'Alice' });
const e = await ddl.insert('Employee', { id: 'e1', name: 'Bob', badge: 'B-1' });
const seededEmployeeId = String(e._id);
await ddl.bind('manages', 'MANUAL', { pairs: [[p._id, e._id]] });
await ddl.flushAll();
ok(true, 'DDL + MANUAL bind + seed rows');

section('2. Start ModelDB server (Fastify + WebSocket)');
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
  section('3. ModelDB SDK: management + use + query + insertMany + alterModel (wire)');
  const modeldb = new ModelDB({
    host: '127.0.0.1',
    port,
    token: INTEGRATION_CONNECT_TOKEN,
  });

  const names = await modeldb.listDatabases();
  ok(names.includes(ATLAS), 'listDatabases includes authored atlas');

  const remote = await modeldb.use(ATLAS);
  const rows = (await remote.model('Employee').query().execute()) as unknown[];
  ok(Array.isArray(rows) && rows.length >= 1, 'query Employee returns rows');
  const first = rows[0];
  ok(
    first instanceof RemoteHydratedEntity && first.getModelName() === 'Employee',
    'hydrated row type',
  );

  await remote.model('Employee').insertMany([{ id: 'e2', name: 'Carol', badge: 'B-2' }], {
    sync: true,
  });
  const afterInsert = (await remote.model('Employee').query().execute()) as unknown[];
  ok(afterInsert.length >= 2, 'insertMany visible in query');

  const patchSchema: FieldDefsRecord = {
    title: { type: DataType.String, required: false },
  };
  await remote.alterModel('Person', patchSchema, { patch: true });
  ok(true, 'alterModel patch over wire');

  remote.close();

  section('4. AuthoringEngine (reopen): update + relation logic tweak + delete');
  const rw = new AuthoringEngine({
    atlas: ATLAS,
    storageRoot: WORKSPACE,
    connectToken: INTEGRATION_CONNECT_TOKEN,
  });
  const personDef = rw.registry.getModel('Person');
  ok(personDef?.fields.has('title') === true, 'Person has title after remote alterModel');

  rw.updateRelationLogic('manages', 'one-to-many');
  ok(true, 'updateRelationLogic(manages)');

  const updated = await rw.update('Employee', seededEmployeeId, { badge: 'B-99' });
  ok(
    updated !== undefined && (updated as { badge?: string }).badge === 'B-99',
    'engine.update Employee',
  );

  const employees = (await rw.model('Employee').query().execute()) as Array<{
    getData: () => Record<string, unknown>;
  }>;
  const e2Row = employees.find((h) => h.getData().id === 'e2');
  ok(e2Row !== undefined, 'Employee e2 exists after remote insertMany');
  assert(e2Row, 'Employee e2 exists after remote insertMany');
  const e2InternalId = String(e2Row.getData()._id);
  const deleted = await rw.delete('Employee', e2InternalId);
  ok(deleted === true, 'engine.delete Employee e2');
  await rw.flushAll();

  section('5. Disconnect (server stop)');
  ok(true, 'client already closed');
} finally {
  await app.close();
}

console.log(`\ne2e-engine-workflow: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { AuthoringEngine } from '@mode-db/core';
import { RemoteModelDBClient } from '@mode-db/sdk';
import type { TransferModel } from '@mode-db/data-kit';
import { buildDualTrackFastify } from '../../packages/server/src/dual-track-app.js';
import { collectModelTransfer, preflightModelTransfer } from '../../apps/model-designer/src/data-transfer/model-transfer.js';
import { readTransferWorkbook, writeTransferWorkbook } from '../../apps/model-designer/src/data-transfer/workbook.js';
import { queryModelPivot } from '../../apps/model-designer/src/pivot/sources/model-source.js';
import type { TransferFilter } from '../../apps/model-designer/src/data-transfer/filters.js';

it('exports filtered data and bidirectional/self relations through the SDK and validates without changing the vault', async () => {
  const root = mkdtempSync(join(tmpdir(), 'modedb-transfer-'));
  const engine = new AuthoringEngine({ atlas: 'fixture', storageRoot: root, keyProvider: fixtureVaultKeys(root) });
  engine.registerModel('Node', { name: 'I18N', score: 'Int', code: 'String', happenedAt:'DateTime',active:'Boolean' });
  engine.registerModel('Group', { title: 'String' });
  engine.registerRelation('Node', 'Node', 'children', 'parent', 'one-to-many');
  engine.registerRelation('Group', 'Node', 'nodes', 'group', 'one-to-many');
  const parent = await engine.insert('Node', { name: { zh: '父', en: 'Parent' }, score: 10, code: 'PARENT-A',happenedAt:'2026-10-17T12:34:56.123+08:00',active:false }, { sync: true });
  const child = await engine.insert('Node', { name: { zh: '子', en: 'Child' }, score: 2, code: 'CHILD-B',happenedAt:'2026-09-01T12:00:00Z',active:true }, { sync: true });
  const group = await engine.insert('Group', { title: 'Group' }, { sync: true });
  await engine.bind('children', 'MANUAL', { pairs: [[parent._id, child._id]] });
  await engine.bind('nodes', 'MANUAL', { pairs: [[group._id, parent._id]] });
  await engine.flushAll();
  const vault = join(root, 'fixture', 'atlas.mld');
  const hash = (): string => createHash('sha256').update(readFileSync(vault)).digest('hex');
  const before = hash();
  const app = await buildDualTrackFastify({ host: '127.0.0.1', port: 0, storageRoot: root, vaultKeyProvider: fixtureVaultKeys(root), designerWorkspace: 'designer', connectToken: 'transfer-fixture', dev: false, configFilePath: join(root, 'config.json') });
  let client: RemoteModelDBClient | undefined;
  try {
    const address = app.server.address();
    assert.ok(address && typeof address === 'object');
    const url = `http://127.0.0.1:${address.port}`;
    client = await RemoteModelDBClient.connect({ url, token: 'transfer-fixture', dbName: 'fixture', mode: 'short' });
    const catalog = await RemoteModelDBClient.getDatabaseCatalog({ host: '127.0.0.1', port: Number(new URL(url).port), token: 'transfer-fixture', database: 'fixture' });
    const models: TransferModel[] = catalog.models.filter((m) => !m.name.startsWith('sys_')).map((m) => ({ name: m.name, label: m.name, sheet: m.name, fields: m.fields.filter((f) => !f.startsWith('_')).map((name) => ({ name, label: name, type: m.fieldTypes?.[name] ?? 'String' })) }));
    const model = models.find((m) => m.name === 'Node')!;
    const data = await collectModelTransfer({ client, database: 'fixture', model, relations: catalog.relations, filters: [{ field: 'score', op: 'gt', value: '5' }] });
    assert.equal(data.rows.length, 1); assert.equal(data.rows[0]?.id, parent._id);
    assert.deepEqual(data.rows[0]?.values.name, { zh: '父', en: 'Parent' });
    assert.equal(data.edges.length, 2);
    assert.ok(data.edges.some((edge) => edge.sourceRef === `id:${group._id}` && edge.targetRef === `id:${parent._id}`));
    assert.ok(data.edges.some((edge) => edge.sourceRef === `id:${parent._id}` && edge.targetRef === `id:${child._id}`));
    const bytes = await writeTransferWorkbook(data, (key) => key);
    const parsed = await readTransferWorkbook(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const checked = await preflightModelTransfer({ client, database: 'fixture', data: parsed, models, relations: catalog.relations });
    assert.deepEqual(checked.issues, []); assert.equal(checked.existingRows, 1); assert.equal(checked.newRows, 0);
    const bad = await preflightModelTransfer({ client, database: 'fixture', data: { ...parsed, edges: [{ ...parsed.edges[0]!, targetRef: 'id:missing' }] }, models, relations: catalog.relations });
    assert.equal(bad.valid, false); assert.equal(bad.issues[0]?.code, 'reference');
    const all = await collectModelTransfer({ client, database: 'fixture', model, relations: catalog.relations, filters: [] });
    assert.equal(all.rows.length, 2); assert.equal(all.edges.length, 2, 'self relation read in both directions is deduplicated');
    const withoutRelations = await collectModelTransfer({client, database:'fixture', model, relations:catalog.relations, filters:[], includeRelations:false});
    assert.deepEqual(withoutRelations.rows, all.rows);
    assert.deepEqual(withoutRelations.edges, []);
    assert.deepEqual(withoutRelations.manifest.relations, []);
    const expectedConditions: [TransferFilter[],number][] = [
      [[{field:'happenedAt',op:'eq',value:'2026-10-17T04:34:56.123Z'}],1],
      [[{field:'happenedAt',op:'gte',value:'2026-10-01T00:00:00Z'}],1],
      [[{field:'happenedAt',op:'between',value:'2026-10-01T00:00:00Z',valueTo:'2026-10-31T23:59:59Z'}],1],
      [[{field:'name',op:'contains',value:'父',locale:'zh'}],1],
      [[{field:'name',op:'eq',value:'Child',locale:'en'}],1],
      [[{field:'active',op:'eq',value:'false'}],1],
      [[{field:'active',op:'isNull',value:''}],0],
      [[{field:'active',op:'isNotNull',value:''}],2],
      [[{field:'score',op:'gte',value:'10'},{field:'score',op:'lte',value:'2',join:'or'}],2],
      [[{field:'score',op:'between',value:'2',valueTo:'10'}],2],
    ];
    for(const [conditions,count] of expectedConditions) {
      const preview=await queryModelPivot({client,source:{kind:'model',modelName:model.name},filter:{model,conditions}});
      const exported=await collectModelTransfer({client,database:'fixture',model,relations:catalog.relations,filters:conditions});
      assert.equal(preview.rows.length,count,JSON.stringify(conditions));
      assert.equal(exported.rows.length,count,JSON.stringify(conditions));
    }
    const firstPage=await queryModelPivot({client,source:{kind:'model',modelName:model.name},page:0,limit:1});
    const secondPage=await queryModelPivot({client,source:{kind:'model',modelName:model.name},page:1,limit:1});
    assert.equal(firstPage.page.total,2);assert.equal(firstPage.page.pageCount,2);
    assert.equal(secondPage.page.page,1);assert.notDeepEqual(firstPage.rawRows,secondPage.rawRows);
    for (const filters of [
      [],
      [{ field: 'score', op: 'gt', value: '5' }],
      [{ field: 'code', op: 'contains', value: 'PARENT' }],
      [{ field: 'score', op: 'gt', value: '5' }, { field: 'code', op: 'contains', value: 'CHILD' }],
    ] satisfies TransferFilter[][]) {
      const preview = await queryModelPivot({ client, source: { kind: 'model', modelName: model.name }, fieldPolicy: { fields: model.fields.map((field) => field.name) }, filter: { model, conditions: filters } });
      const exported = await collectModelTransfer({ client, database: 'fixture', model, relations: catalog.relations, filters });
      assert.equal(preview.rows.length, exported.rows.length, 'preview and export must match for each condition set');
      assert.deepEqual(preview.rawRows.map((row) => ({ code: row.code, score: row.score })), exported.rows.map((row) => ({ code: row.values.code, score: row.values.score })));
    }
  } finally {
    client?.close();
    await app.close();
    try { assert.equal(hash(), before, 'read-only export and validation must not change the business vault'); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }
});
import { fixtureVaultKeys } from '../vault-keys.js';

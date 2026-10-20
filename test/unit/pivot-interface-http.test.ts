import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { AuthoringEngine } from '@mode-db/core';
import { RemoteModelDBClient } from '@mode-db/sdk';
import { queryInterfaceAccessKeyDigest, queryParameterPlaceholder, type PublishedQueryExecutionTemplate } from '@mode-db/shared';
import { buildDualTrackFastify } from '../../packages/server/src/dual-track-app.js';
import { preparePivotParameters } from '../../apps/model-designer/src/pivot/interface-input.js';
import { invokeInterfacePivot } from '../../apps/model-designer/src/pivot/sources/interface-source.js';
import type { InterfaceParameter } from '../../apps/model-designer/src/query-designer/types.js';

it('invokes a published interface through HTTP with typed inputs, defaults, keys and projection intact', async () => {
  const root = mkdtempSync(join(tmpdir(), 'modedb-pivot-input-'));
  const business = new AuthoringEngine({ atlas: 'business', storageRoot: root, connectToken: 'fixture' });
  const designer = new AuthoringEngine({ atlas: 'designer', storageRoot: root, connectToken: 'fixture' });
  const parameters: InterfaceParameter[] = [
    { id: 'p_score', name: 'score', type: 'number', required: true, defaultValue: 0 },
    { id: 'p_active', name: 'active', type: 'boolean', required: true, defaultValue: false },
    { id: 'p_category', name: 'category', type: 'string', required: true },
  ];
  const template: PublishedQueryExecutionTemplate = {
    format: 1,
    snapshot: {
      plan: {
        version: 2, originModel: 'Item', start: { kind: 'all' }, hops: [],
        trailing: { type: 'group', logic: 'AND', children: [
          { type: 'atom', field: 'score', op: 'eq', value: queryParameterPlaceholder('p_score') },
          { type: 'atom', field: 'active', op: 'eq', value: queryParameterPlaceholder('p_active') },
          { type: 'atom', field: 'category', op: 'eq', value: queryParameterPlaceholder('p_category') },
        ] },
      },
      execute: {}, analysis: { groupBy: null, compute: null },
    },
    parameters,
    pagination: { mode: 'none' },
    resultAdapter: { kind: 'rows', rootNodeId: 'item', fieldsByNode: { item: [
      { sourceField: 'category', outputName: 'label' },
      { sourceField: 'score', outputName: 'value' },
      { sourceField: 'active', outputName: 'enabled' },
    ] }, edgesBySource: {} },
  };
  business.registerModel('Item', { category: 'String', score: 'Int', active: 'Boolean', hidden: 'String' });
  await business.insert('Item', { category: 'A', score: 0, active: false, hidden: 'private' }, { sync: true });
  await business.insert('Item', { category: 'A', score: 1, active: true, hidden: 'private' }, { sync: true });
  designer.registerModel('sys_query_interface', { library_code: 'String', release_json: 'String', release_history_json: 'String' });
  await designer.insert('sys_query_interface', {
    library_code: 'business', release_history_json: '',
    release_json: JSON.stringify({
      version: '1.2.3', publishedAt: '2026-10-17T00:00:00Z', callableName: 'itemsByInputs', signature: 'fixture',
      queryInterface: { status: 'active', contract: { permissions: { mode: 'key', accessKeyDigest: queryInterfaceAccessKeyDigest('interface-fixture-key') } } },
      executionTemplate: template,
    }),
  }, { sync: true });
  for(const mode of ['offset','cursor'] as const) {
    const paginated=structuredClone(template);
    if(mode==='cursor') paginated.snapshot.plan.version=7;
    paginated.snapshot.plan.trailing={type:'group',logic:'AND',children:[]};
    await designer.insert('sys_query_interface',{
      library_code:'business',release_history_json:'',
      release_json:JSON.stringify({version:'1.0.0',publishedAt:'2026-10-17T00:00:00Z',callableName:`items_${mode}`,signature:`fixture_${mode}`,queryInterface:{status:'active',contract:{permissions:{mode:'none'}}},executionTemplate:{...paginated,parameters:[],pagination:{mode,defaultLimit:1,maxLimit:2}}}),
    },{sync:true});
  }
  await business.flushAll();
  await designer.flushAll();
  const hash = (): string => createHash('sha256').update(readFileSync(join(root, 'business', 'atlas.mld'))).digest('hex');
  const before = hash();
  const app = await buildDualTrackFastify({ host: '127.0.0.1', port: 0, storageRoot: root, designerWorkspace: 'designer', connectToken: 'fixture', dev: false, configFilePath: join(root, 'config.json') });
  let client: RemoteModelDBClient | undefined;
  try {
    const address = app.server.address();
    assert.ok(address && typeof address === 'object');
    client = await RemoteModelDBClient.connect({ url: `http://127.0.0.1:${address.port}`, token: 'fixture', dbName: 'business', mode: 'short' });
    const source = { kind: 'interface' as const, interfaceId: 'fixture', callableName: 'itemsByInputs', version: '1.2.3' };
    const prepared = preparePivotParameters(parameters, { p_category: 'A', p_score: '0', p_active: 'false' });
    assert.deepEqual(prepared.issues, []);
    assert.deepEqual(prepared.values, { category: 'A', score: 0, active: false });
    const explicit = await invokeInterfacePivot({ client, source, parameters: prepared.values, accessKey: 'interface-fixture-key' });
    assert.deepEqual(explicit.rawRows, [{ label: 'A', value: 0, enabled: false }]);
    const direct = await fetch(`http://127.0.0.1:${address.port}/api/v1/databases/business/query-interfaces/itemsByInputs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ModelDB-Connect-Token': 'fixture',
      },
      body: JSON.stringify({
        version: '1.2.3',
        parameters: { category: 'A', score: '0', active: 'false' },
        accessKey: 'interface-fixture-key',
      }),
    });
    assert.equal(direct.status, 200);
    assert.deepEqual((await direct.json()).rows, [{ label: 'A', value: 0, enabled: false }]);
    const directWithoutToken = await fetch(`http://127.0.0.1:${address.port}/api/v1/databases/business/query-interfaces/itemsByInputs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: '1.2.3', parameters: { category: 'A' } }),
    });
    assert.equal(directWithoutToken.status, 401);
    const defaults = preparePivotParameters(parameters, { p_category: 'A' });
    assert.deepEqual(defaults.issues, []);
    const defaultResult = await invokeInterfacePivot({ client, source, parameters: defaults.values, accessKey: 'interface-fixture-key' });
    assert.deepEqual(defaultResult.rawRows, explicit.rawRows);
    await assert.rejects(invokeInterfacePivot({ client, source, parameters: prepared.values }), /INTERFACE_ACCESS_KEY_REQUIRED/);
    await assert.rejects(invokeInterfacePivot({ client, source: { ...source, version: '9.9.9' }, parameters: prepared.values, accessKey: 'interface-fixture-key' }), /INTERFACE_RELEASE_NOT_FOUND/);
    for(const mode of ['offset','cursor'] as const) {
      const pagedSource={...source,callableName:`items_${mode}`,version:'1.0.0'};
      const first=await invokeInterfacePivot({client,source:pagedSource,limit:1,...(mode==='cursor'?{cursor:null}:{page:0})});
      assert.equal(first.page.mode,mode);
      assert.equal(first.rawRows.length,1);
      assert.equal(first.page.limit,1);
      if(mode==='cursor') assert.ok(first.page.nextCursor);
      else {assert.equal(first.page.total,2);assert.equal(first.page.pageCount,2);}
      const next=await invokeInterfacePivot({client,source:pagedSource,limit:1,...(mode==='cursor'?{cursor:first.page.nextCursor}:{page:1})});
      assert.equal(next.rawRows.length,1);
      assert.notDeepEqual(first.rawRows,next.rawRows);
      const previous=await invokeInterfacePivot({client,source:pagedSource,limit:1,...(mode==='cursor'?{cursor:null}:{page:0})});
      assert.deepEqual(first.rawRows,previous.rawRows);
    }
    assert.equal(hash(), before, 'query preview must not modify business records');
  } finally {
    client?.close();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

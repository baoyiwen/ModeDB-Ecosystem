import assert from 'node:assert/strict';
import { it } from 'node:test';
import { securityReleaseDigest } from '@mode-db/sdk';
import { buildInterfaceCallDocs } from '../../apps/model-designer/src/query-designer/interface-call-docs.js';
import { customerOrdersQueryFixture } from '../../apps/model-designer/src/query-designer/index.js';
import type { QueryInterfaceRelease } from '../../apps/model-designer/src/query-designer/query-interface-publication.js';

function release(): QueryInterfaceRelease {
  const queryInterface = structuredClone(customerOrdersQueryFixture);
  queryInterface.contract.parameters = [
    { id: 'name', name: 'name', type: 'string', required: true },
    { id: 'count', name: 'count', type: 'number', required: false, defaultValue: 25 },
    { id: 'enabled', name: 'enabled', type: 'boolean', required: false },
    { id: 'date', name: 'date', type: 'date', required: false },
    { id: 'time', name: 'time', type: 'datetime', required: false },
    { id: 'json', name: 'json', type: 'json', required: false },
  ];
  queryInterface.query.pagination = { mode: 'offset', defaultLimit: 25, maxLimit: 100 };
  return {
    version: '1.2.3',
    callableName: 'Customer_Query',
    publishedAt: '2026-10-20T00:00:00Z',
    signature: 'fixture',
    queryInterface,
    executionTemplate: {} as QueryInterfaceRelease['executionTemplate'],
  };
}

it('exports a secret-free Postman request with typed parameters, release pin and the same HTTP body', () => {
  const published = release();
  published.queryInterface.contract.permissions = { mode: 'key', accessKeyDigest: 'not-a-key' };
  const docs = buildInterfaceCallDocs({
    release: published,
    libraryCode: '业务库',
    baseUrl: 'https://data.example.com/modeldb///',
    authMode: 'registry',
  });
  assert.equal(
    docs.endpoint,
    'https://data.example.com/modeldb/api/v1/databases/%E4%B8%9A%E5%8A%A1%E5%BA%93/query-interfaces/Customer_Query',
  );
  const collection = JSON.parse(JSON.stringify(docs.postman));
  const request = collection.item[0].request;
  assert.equal(request.method, 'POST');
  assert.equal(request.auth.type, 'bearer');
  assert.equal(collection.variable[1].value, '');
  assert.equal(collection.item[0].protocolProfileBehavior.followRedirects, false);
  assert.equal(request.url.replace('{{baseUrl}}', collection.variable[0].value), docs.endpoint);
  assert.deepEqual(JSON.parse(request.body.raw), {
    version: '1.2.3',
    parameters: {
      name: '<name>', count: 25, enabled: true, date: '2026-01-01',
      time: '2026-01-01T00:00:00.000Z', json: {},
    },
    accessKey: '<ACCESS_KEY>', page: 0, limit: 25,
  });
  assert.equal(docs.grant?.releaseDigest, securityReleaseDigest(published));
  assert.deepEqual(docs.grant?.actions, ['callable.query']);
  assert.ok(docs.curl.includes('Authorization: Bearer $MODELDB_TOKEN'));
  assert.ok(!JSON.stringify(docs).includes('not-a-key'));
  assert.ok(!docs.curl.includes('X-ModelDB-Connect-Token'));
  // Bash escaping must keep authored defaults as literal data, including quotes and expansions.
  published.queryInterface.contract.parameters[0]!.defaultValue = "O'Brien $(do-not-run) `literal`";
  const escaped = buildInterfaceCallDocs({ release: published, libraryCode: 'business', baseUrl: 'https://data.example.com', authMode: 'registry' });
  assert.ok(escaped.curl.includes("O'\"'\"'Brien $(do-not-run) `literal`"));
});

it('keeps legacy auth explicit, and only emits pagination controls when the release supports them', () => {
  const published = release();
  published.queryInterface.contract.permissions = { mode: 'none' };
  published.queryInterface.query.pagination = { mode: 'none' };
  const build = () => buildInterfaceCallDocs({ release: published, libraryCode: 'business', baseUrl: 'http://127.0.0.1:9091', authMode: 'legacy' });
  const docs = build();
  assert.equal(docs.grant, undefined);
  assert.ok(docs.curl.includes('X-ModelDB-Connect-Token: $MODELDB_CONNECT_TOKEN'));
  assert.ok(!docs.curl.includes('Bearer'));
  assert.equal(docs.postman.item[0]!.request.auth.type, 'noauth');
  assert.ok(!('page' in docs.body) && !('cursor' in docs.body) && !('limit' in docs.body));
  assert.ok(!('accessKey' in docs.body));
  published.queryInterface.query.pagination = { mode: 'cursor', defaultLimit: 10 };
  assert.equal(build().body.cursor, null);
  assert.equal(build().body.limit, 10);
});

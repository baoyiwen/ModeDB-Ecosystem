import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  queryInterfaceAccessKeyDigest,
  queryParameterPlaceholder,
  QueryInterfaceInvocationError,
  RemoteModelDBClient,
  WireQueryChain,
  type PublishedQueryExecutionTemplate,
} from '@mode-db/sdk';
import {
  ensureDesignerCatalog,
  SYS_QUERY_INTERFACE,
  SYS_QUERY_INTERFACE_CALL_LOG,
} from '../apps/model-designer/src/bootstrap/designer-storage-init.js';
import {
  EMPTY_QUERY_CHAIN_STATE,
  customerOrdersQueryFixture,
  type QueryInterfaceRelease,
} from '../apps/model-designer/src/query-designer/index.js';
import {
  listQueryInterfaceAuditSummaries,
  upsertQueryInterfaceRegistry,
} from '../apps/model-designer/src/sync/query-interface-registry.js';

const configPath = resolve(process.argv[2] ?? 'modeldb.config.json');
const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
  host?: string;
  port?: number;
  connectToken?: string;
};
if (!config.connectToken) {
  throw new Error('ModelDB config does not contain connectToken.');
}

const host = config.host ?? '127.0.0.1';
const port = config.port ?? 9090;
const token = config.connectToken;
const suffix = Date.now().toString(36);
const database = `__query_interface_call_${suffix}`;
const interfaceId = `__query_interface_call_${suffix}`;
const callableName = `itemsByCategory_${suffix}`;
const accessKey = `query-live-access-${suffix}`;
let businessClient: RemoteModelDBClient | undefined;
let businessStreamClient: RemoteModelDBClient | undefined;
let designerClient: RemoteModelDBClient | undefined;

try {
  await RemoteModelDBClient.createDatabase({ host, port, token, name: database });
  businessClient = await RemoteModelDBClient.connectNetwork({
    host,
    port,
    token,
    database,
    mode: 'short',
  });
  designerClient = await RemoteModelDBClient.connectNetwork({
    host,
    port,
    token,
    database: 'model_designer_workspace',
    mode: 'short',
  });
  businessStreamClient = await RemoteModelDBClient.connectNetwork({
    host,
    port,
    token,
    database,
    mode: 'stream',
  });

  await businessClient.registerModel('Item', { category: 'String', score: 'Int' });
  const inserted = await businessClient.model('Item').insertMany(
    [
      { category: 'A', score: 3 },
      { category: 'A', score: 2 },
      { category: 'A', score: 1 },
      { category: 'B', score: 9 },
    ],
    { sync: true },
  );
  assert.equal(inserted.successCount, 4);

  await ensureDesignerCatalog(designerClient);
  const queryInterface = structuredClone(customerOrdersQueryFixture);
  queryInterface.id = interfaceId;
  queryInterface.name = 'Invocation live check';
  queryInterface.status = 'active';
  queryInterface.contract.permissions = {
    mode: 'key',
    accessKeyDigest: queryInterfaceAccessKeyDigest(accessKey),
    rateLimit: { maxRequests: 3, windowSeconds: 60 },
  };
  const now = new Date().toISOString();
  const release: QueryInterfaceRelease = {
    version: '1.0.0',
    publishedAt: now,
    callableName,
    signature: `live-check-${suffix}`,
    queryInterface: structuredClone(queryInterface),
    executionTemplate: executionTemplate(),
  };
  const historicalRelease: QueryInterfaceRelease = {
    ...structuredClone(release),
    version: '0.9.0',
    signature: `live-check-${suffix}-historical`,
    executionTemplate: executionTemplate('legacyValue'),
  };
  await upsertQueryInterfaceRegistry(designerClient, database, {
    id: interfaceId,
    name: queryInterface.name,
    queryInterface,
    queryChain: EMPTY_QUERY_CHAIN_STATE,
    createdAt: now,
    updatedAt: now,
    signature: release.signature,
    projectionConfigured: true,
    publishedRelease: release,
    releaseHistory: [historicalRelease],
  });

  const first = await businessClient.invokeQueryInterface(callableName, {
    version: '1.0.0',
    parameters: { category: 'A' },
    accessKey,
    cursor: null,
    limit: 2,
  });
  assert.deepEqual(first.rows, [
    { label: 'A', value: 3 },
    { label: 'A', value: 2 },
  ]);
  assert.ok(first.nextCursor);

  const second = await businessClient.invokeQueryInterface(callableName, {
    version: '1.0.0',
    parameters: { category: 'A' },
    accessKey,
    cursor: first.nextCursor,
    limit: 2,
  });
  assert.deepEqual(second.rows, [{ label: 'A', value: 1 }]);
  assert.equal(second.nextCursor, undefined);

  const historical = await businessClient.invokeQueryInterface(callableName, {
    version: '0.9.0',
    parameters: { category: 'A' },
    accessKey,
    cursor: null,
    limit: 2,
  });
  assert.equal(historical.version, '0.9.0');
  assert.deepEqual(historical.rows, [
    { label: 'A', legacyValue: 3 },
    { label: 'A', legacyValue: 2 },
  ]);

  await assert.rejects(
    businessClient.invokeQueryInterface(callableName, {
      version: '2.0.0',
      parameters: { category: 'A' },
      accessKey,
      cursor: null,
    }),
    (error: unknown) =>
      error instanceof QueryInterfaceInvocationError &&
      error.code === 'INTERFACE_RELEASE_NOT_FOUND' &&
      error.category === 'not_found' &&
      error.details?.version === '2.0.0',
  );
  await assert.rejects(
    businessClient.invokeQueryInterface(callableName, {
      version: '1.0.0',
      accessKey,
      cursor: null,
    }),
    (error: unknown) =>
      error instanceof QueryInterfaceInvocationError &&
      error.code === 'INTERFACE_PARAMETER_REQUIRED' &&
      error.category === 'validation' &&
      error.details?.parameter === 'category',
  );
  await assert.rejects(
    businessStreamClient.invokeQueryInterface(callableName, {
      version: '2.0.0',
      parameters: { category: 'A' },
      accessKey,
      cursor: null,
    }),
    (error: unknown) =>
      error instanceof QueryInterfaceInvocationError &&
      error.code === 'INTERFACE_RELEASE_NOT_FOUND' &&
      error.category === 'not_found',
  );
  await assert.rejects(
    businessClient.invokeQueryInterface(callableName, {
      version: '1.0.0',
      parameters: { category: 'A' },
      cursor: null,
    }),
    (error: unknown) =>
      error instanceof QueryInterfaceInvocationError &&
      error.code === 'INTERFACE_ACCESS_KEY_REQUIRED' &&
      error.category === 'forbidden',
  );
  await assert.rejects(
    businessClient.invokeQueryInterface(callableName, {
      version: '1.0.0',
      parameters: { category: 'A' },
      accessKey,
      cursor: null,
    }),
    (error: unknown) =>
      error instanceof QueryInterfaceInvocationError &&
      error.code === 'INTERFACE_RATE_LIMITED' &&
      error.category === 'rate_limited' &&
      error.retryable &&
      Number(error.details?.retryAfterSeconds) > 0,
  );

  const auditRows = await designerClient.model(SYS_QUERY_INTERFACE_CALL_LOG).query().execute();
  const scopedAudit = (Array.isArray(auditRows) ? auditRows : [])
    .map((row) =>
      row && typeof row === 'object' && 'getData' in row && typeof row.getData === 'function'
        ? row.getData()
        : undefined,
    )
    .filter(
      (row): row is Record<string, unknown> => Boolean(row) && row?.library_code === database,
    );
  assert.equal(scopedAudit.length, 8);
  assert.equal(scopedAudit.filter((row) => row.status === 'success').length, 3);
  assert.deepEqual(
    scopedAudit
      .filter((row) => row.status === 'error')
      .map((row) => row.error_code)
      .sort(),
    [
      'INTERFACE_ACCESS_KEY_REQUIRED',
      'INTERFACE_PARAMETER_REQUIRED',
      'INTERFACE_RATE_LIMITED',
      'INTERFACE_RELEASE_NOT_FOUND',
      'INTERFACE_RELEASE_NOT_FOUND',
    ],
  );
  assert.equal(
    scopedAudit.some((row) => 'parameters' in row || 'category' in row),
    false,
  );
  const auditSummaries = await listQueryInterfaceAuditSummaries(designerClient, database);
  const auditSummary = auditSummaries.get(callableName);
  assert.equal(auditSummary?.callCount, 8);
  assert.equal(auditSummary?.successCount, 3);
  assert.equal(auditSummary?.errorCount, 5);
  assert.ok((auditSummary?.averageDurationMs ?? 0) >= 0);
  assert.equal(auditSummary?.trend.length, 12);
  assert.equal(
    auditSummary?.trend.reduce((total, point) => total + point.callCount, 0),
    8,
  );
  assert.equal(auditSummary?.recentCalls.length, 8);
  assert.equal(auditSummary?.recentCalls[0]?.errorCode, 'INTERFACE_RATE_LIMITED');

  console.log(
    JSON.stringify({
      ok: true,
      database,
      callableName,
      version: first.version,
      firstPage: first.rows,
      secondPage: second.rows,
      historicalVersion: historical.version,
      cursorPagination: true,
      rateLimit: true,
      auditObservability: true,
      validationErrors: true,
      auditRows: scopedAudit.length,
      auditSummary,
    }),
  );
} finally {
  if (designerClient) {
    await cleanupDesignerRows(designerClient, interfaceId, database).catch(() => undefined);
  }
  businessClient?.close();
  businessStreamClient?.close();
  designerClient?.close();
  await RemoteModelDBClient.deleteDatabase({ host, port, token, name: database }).catch(() => {});
}

function executionTemplate(valueOutputName = 'value'): PublishedQueryExecutionTemplate {
  const snapshot = new WireQueryChain('Item', { kind: 'all' })
    .where('category', 'eq', queryParameterPlaceholder('parameter_category'))
    .orderBy('score', 'desc')
    .cursor()
    .limit(2)
    .getRemoteExecuteSnapshot();
  return {
    format: 1,
    snapshot,
    parameters: [
      {
        id: 'parameter_category',
        name: 'category',
        type: 'string',
        required: true,
      },
    ],
    resultAdapter: {
      kind: 'rows',
      rootNodeId: 'node_item',
      fieldsByNode: {
        node_item: [
          { sourceField: 'category', outputName: 'label' },
          { sourceField: 'score', outputName: valueOutputName },
        ],
      },
      edgesBySource: {},
    },
    pagination: { mode: 'cursor', defaultLimit: 2, maxLimit: 10 },
  };
}

async function cleanupDesignerRows(
  client: RemoteModelDBClient,
  logicalInterfaceId: string,
  libraryCode: string,
): Promise<void> {
  const deletes: Array<{ model: string; id: string }> = [];
  for (const model of [SYS_QUERY_INTERFACE, SYS_QUERY_INTERFACE_CALL_LOG]) {
    const raw = await client.model(model).query().execute();
    for (const row of Array.isArray(raw) ? raw : []) {
      if (!row || typeof row !== 'object' || !('getData' in row)) {
        continue;
      }
      const getData = (row as { getData?: unknown }).getData;
      if (typeof getData !== 'function') {
        continue;
      }
      const data = getData.call(row) as Record<string, unknown>;
      const matches =
        model === SYS_QUERY_INTERFACE
          ? data.interface_id === logicalInterfaceId
          : data.library_code === libraryCode;
      if (matches && typeof data._id === 'string') {
        deletes.push({ model, id: data._id });
      }
    }
  }
  if (deletes.length > 0) {
    await client.batchDelete(deletes, { sync: true });
  }
}

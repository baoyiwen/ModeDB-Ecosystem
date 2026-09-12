import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  interfaceParameterPlaceholder,
  queryInterfaceAccessKeyDigest,
  queryParameterPlaceholder,
  RemoteModelDBClient,
  WireQueryChain,
  type PublishedBindingSurfaceContract,
  type PublishedOperationExecutionTemplate,
  type PublishedQueryExecutionTemplate,
} from '@mode-db/sdk';
import {
  ensureDesignerCatalog,
  SYS_BINDING_SURFACE,
  SYS_BINDING_SURFACE_CALL_LOG,
  SYS_OPERATION_INTERFACE,
  SYS_OPERATION_INTERFACE_CALL_LOG,
  SYS_QUERY_INTERFACE,
  SYS_QUERY_INTERFACE_CALL_LOG,
} from '../apps/model-designer/src/bootstrap/designer-storage-init.js';

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
const designerWorkspace = 'model_designer_workspace';
const suffix = Date.now().toString(36);
const database = `__binding_surface_recovery_${suffix}`;
const queryInterfaceId = `query_items_${suffix}`;
const operationInterfaceId = `operation_update_item_${suffix}`;
const queryCallable = `itemsByCategory_${suffix}`;
const operationCallable = `updateItemStatus_${suffix}`;
const healthySurfaceId = `itemEditor_${suffix}`;
const refreshFailureSurfaceId = `itemEditorRefreshFailure_${suffix}`;
const surfaceAccessKey = `surface-access-${suffix}`;
let businessClient: RemoteModelDBClient | undefined;
let designerClient: RemoteModelDBClient | undefined;
let designerWorkspaceCreated = false;

try {
  const databases = await RemoteModelDBClient.listDatabases({ host, port, token });
  if (!databases.some((candidate) => candidate.name === designerWorkspace)) {
    await RemoteModelDBClient.createDatabase({
      host,
      port,
      token,
      name: designerWorkspace,
    });
    designerWorkspaceCreated = true;
  }
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
    database: designerWorkspace,
    mode: 'short',
  });

  await ensureDesignerCatalog(designerClient);
  await businessClient.registerModel('Item', { category: 'String', status: 'String' });
  const inserted = await businessClient
    .model('Item')
    .insertOne({ category: 'A', status: 'READY' }, { sync: true });

  await installQueryRelease(designerClient);
  await installOperationRelease(designerClient);
  await installSurfaceRelease(designerClient, surfaceContract(healthySurfaceId, '1.0.0'));
  await installSurfaceRelease(designerClient, surfaceContract(refreshFailureSurfaceId, '9.9.9'));

  await assert.rejects(
    businessClient.invokeBindingSurface(healthySurfaceId, {
      version: '1.0.0',
      parameters: { category: 'A' },
      action: { kind: 'read' },
    }),
    (error: unknown) => interfaceErrorCode(error) === 'INTERFACE_ACCESS_KEY_REQUIRED',
  );

  const initial = await businessClient.invokeBindingSurface(healthySurfaceId, {
    version: '1.0.0',
    accessKey: surfaceAccessKey,
    parameters: { category: 'A' },
    action: { kind: 'read' },
  });
  assert.equal(initial.status, 'success');
  assert.equal(initial.query?.rows.length, 1);
  assert.equal(initial.query?.rows[0]?.status, 'READY');
  const recordRef = projectedRecordRef(initial.query?.rows[0]?.$recordRef);
  assert.equal(recordRef.id, inserted.id);

  await assert.rejects(
    businessClient.invokeBindingSurface(healthySurfaceId, {
      version: '1.0.0',
      accessKey: surfaceAccessKey,
      parameters: { category: 'A' },
      action: {
        kind: 'mutate',
        mutationId: 'update-status',
        editedValue: 'MUST_NOT_BE_WRITTEN',
      },
    }),
    (error: unknown) => interfaceErrorCode(error) === 'INTERFACE_PARAMETER_REQUIRED',
  );
  assert.equal((await itemById(businessClient, inserted.id)).status, 'READY');

  const refreshFailed = await businessClient.invokeBindingSurface(refreshFailureSurfaceId, {
    version: '1.0.0',
    accessKey: surfaceAccessKey,
    parameters: { category: 'A' },
    action: {
      kind: 'mutate',
      mutationId: 'update-status',
      recordRefs: { node_item: recordRef },
      editedValue: 'RUNNING',
    },
  });
  assert.equal(refreshFailed.status, 'refreshFailed');
  assert.equal(refreshFailed.mutation?.result.operation, 'update');
  assert.equal(refreshFailed.refreshError?.code, 'INTERFACE_RELEASE_NOT_FOUND');
  assert.equal((await itemById(businessClient, inserted.id)).status, 'RUNNING');

  const recoveryRead = await businessClient.invokeBindingSurface(healthySurfaceId, {
    version: '1.0.0',
    accessKey: surfaceAccessKey,
    parameters: { category: 'A' },
    action: { kind: 'read' },
  });
  assert.equal(recoveryRead.query?.rows[0]?.status, 'RUNNING');

  const restored = await businessClient.invokeBindingSurface(healthySurfaceId, {
    version: '1.0.0',
    accessKey: surfaceAccessKey,
    parameters: { category: 'A' },
    action: {
      kind: 'mutate',
      mutationId: 'update-status',
      recordRefs: { node_item: recordRef },
      editedValue: 'READY',
    },
  });
  assert.equal(restored.status, 'success');
  assert.equal(restored.query?.rows[0]?.status, 'READY');
  assert.equal((await itemById(businessClient, inserted.id)).status, 'READY');

  const queryAudits = await auditRows(designerClient, SYS_QUERY_INTERFACE_CALL_LOG, database);
  const operationAudits = await auditRows(
    designerClient,
    SYS_OPERATION_INTERFACE_CALL_LOG,
    database,
  );
  const surfaceAudits = await auditRows(designerClient, SYS_BINDING_SURFACE_CALL_LOG, database);
  assert.equal(queryAudits.length, 4);
  assert.equal(queryAudits.filter((row) => row.status === 'success').length, 3);
  assert.equal(queryAudits.filter((row) => row.status === 'error').length, 1);
  assert.equal(operationAudits.length, 3);
  assert.equal(operationAudits.filter((row) => row.status === 'success').length, 2);
  assert.equal(operationAudits.filter((row) => row.status === 'error').length, 1);
  assert.deepEqual(
    surfaceAudits
      .sort((left, right) => String(left.started_at).localeCompare(String(right.started_at)))
      .map((row) => row.status),
    ['error', 'success', 'error', 'refresh_failed', 'success', 'success'],
  );
  assert.ok(
    surfaceAudits.every(
      (row) =>
        !Object.hasOwn(row, 'access_key') &&
        !Object.hasOwn(row, 'parameters') &&
        !Object.hasOwn(row, 'edited_value') &&
        !JSON.stringify(row).includes(surfaceAccessKey),
    ),
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        database,
        healthySurfaceId,
        refreshFailureSurfaceId,
        surfacePolicyEnforced: true,
        mutationFailureSkippedRefresh: true,
        refreshFailurePreservedMutation: true,
        recoveryReadSucceeded: true,
        businessDataRestored: true,
        audit: {
          queryCalls: queryAudits.length,
          queryErrors: queryAudits.filter((row) => row.status === 'error').length,
          operationCalls: operationAudits.length,
          operationErrors: operationAudits.filter((row) => row.status === 'error').length,
          surfaceCalls: surfaceAudits.length,
          surfaceErrors: surfaceAudits.filter((row) => row.status === 'error').length,
          surfaceRefreshFailures: surfaceAudits.filter((row) => row.status === 'refresh_failed')
            .length,
        },
      },
      null,
      2,
    ),
  );
} finally {
  if (designerClient) {
    await cleanupDesignerRows(designerClient, database).catch(() => undefined);
  }
  businessClient?.close();
  designerClient?.close();
  await RemoteModelDBClient.deleteDatabase({ host, port, token, name: database }).catch(() => {});
  if (designerWorkspaceCreated) {
    await RemoteModelDBClient.deleteDatabase({
      host,
      port,
      token,
      name: designerWorkspace,
    }).catch(() => {});
  }
}

async function installQueryRelease(client: RemoteModelDBClient): Promise<void> {
  const now = new Date().toISOString();
  const result = await client.model(SYS_QUERY_INTERFACE).insertMany(
    [
      {
        _id: `${database}_${queryInterfaceId}`,
        library_code: database,
        interface_id: queryInterfaceId,
        display_name: queryCallable,
        query_json: '{}',
        chain_json: '{}',
        signature: `live-check-${queryInterfaceId}`,
        created_at: now,
        updated_at: now,
        projection_configured: true,
        release_json: JSON.stringify({
          version: '1.0.0',
          publishedAt: now,
          callableName: queryCallable,
          signature: `live-check-${queryInterfaceId}`,
          queryInterface: { status: 'active', contract: { permissions: { mode: 'none' } } },
          executionTemplate: queryTemplate(),
        }),
        release_history_json: '',
      },
    ],
    { sync: true },
  );
  assert.equal(result.failureCount, 0);
}

async function installOperationRelease(client: RemoteModelDBClient): Promise<void> {
  const now = new Date().toISOString();
  const result = await client.model(SYS_OPERATION_INTERFACE).insertMany(
    [
      {
        _id: `${database}_${operationInterfaceId}`,
        library_code: database,
        interface_id: operationInterfaceId,
        display_name: operationCallable,
        operation_json: '{}',
        signature: `live-check-${operationInterfaceId}`,
        created_at: now,
        updated_at: now,
        release_json: JSON.stringify({
          version: '1.0.0',
          publishedAt: now,
          callableName: operationCallable,
          signature: `live-check-${operationInterfaceId}`,
          operationInterface: {
            status: 'active',
            contract: { permissions: { mode: 'none' } },
          },
          executionTemplate: operationTemplate(),
        }),
        release_history_json: '',
      },
    ],
    { sync: true },
  );
  assert.equal(result.failureCount, 0);
}

async function installSurfaceRelease(
  client: RemoteModelDBClient,
  contract: PublishedBindingSurfaceContract,
): Promise<void> {
  const now = new Date().toISOString();
  const result = await client.model(SYS_BINDING_SURFACE).insertMany(
    [
      {
        _id: `${database}_${contract.surfaceId}`,
        library_code: database,
        surface_id: contract.surfaceId,
        display_name: contract.name,
        surface_json: '{}',
        signature: `live-check-${contract.surfaceId}`,
        created_at: now,
        updated_at: now,
        release_json: JSON.stringify({
          version: contract.version,
          publishedAt: now,
          signature: `live-check-${contract.surfaceId}`,
          bindingSurface: { status: 'active' },
          contract,
        }),
        release_history_json: '',
      },
    ],
    { sync: true },
  );
  assert.equal(result.failureCount, 0);
}

function surfaceContract(surfaceId: string, queryVersion: string): PublishedBindingSurfaceContract {
  return {
    format: 1,
    surfaceId,
    name: surfaceId,
    version: '1.0.0',
    permissions: {
      mode: 'key',
      accessKeyDigest: queryInterfaceAccessKeyDigest(surfaceAccessKey),
      rateLimit: { maxRequests: 10, windowSeconds: 60 },
    },
    parameters: [{ id: 'surface_category', name: 'category', type: 'string', required: true }],
    query: {
      interfaceId: queryInterfaceId,
      callableName: queryCallable,
      version: queryVersion,
      parameterBindings: [
        {
          parameterId: 'parameter_category',
          source: { kind: 'surfaceParameter', parameterId: 'surface_category' },
        },
      ],
    },
    writeback: {
      mode: 'explicit',
      refresh: 'afterMutation',
      mutations: [
        {
          id: 'update-status',
          trigger: { kind: 'update', fieldPath: 'status' },
          operation: {
            interfaceId: operationInterfaceId,
            callableName: operationCallable,
            version: '1.0.0',
            operationType: 'update',
          },
          parameterBindings: [
            {
              parameterId: 'param_id',
              source: { kind: 'rowRecordRef', nodeId: 'node_item' },
            },
            { parameterId: 'param_status', source: { kind: 'editedValue' } },
          ],
        },
      ],
    },
  };
}

function queryTemplate(): PublishedQueryExecutionTemplate {
  const snapshot = new WireQueryChain('Item', { kind: 'all' })
    .where('category', 'eq', queryParameterPlaceholder('parameter_category'))
    .getRemoteExecuteSnapshot();
  return {
    format: 1,
    snapshot,
    parameters: [{ id: 'parameter_category', name: 'category', type: 'string', required: true }],
    resultAdapter: {
      kind: 'rows',
      rootNodeId: 'node_item',
      fieldsByNode: {
        node_item: [
          { sourceField: 'category', outputName: 'category' },
          { sourceField: 'status', outputName: 'status' },
        ],
      },
      edgesBySource: {},
    },
    pagination: { mode: 'none' },
  };
}

function operationTemplate(): PublishedOperationExecutionTemplate {
  return {
    format: 1,
    operation: {
      op: 'update',
      model: 'Item',
      id: interfaceParameterPlaceholder('param_id'),
      partial: { status: interfaceParameterPlaceholder('param_status') },
      sync: true,
    },
    parameters: [
      { id: 'param_id', name: 'id', type: 'recordRef', required: true },
      { id: 'param_status', name: 'status', type: 'string', required: true },
    ],
    result: { returns: 'record' },
  };
}

function projectedRecordRef(value: unknown): { model: string; id: string } {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  const ref = value as Record<string, unknown>;
  assert.equal(ref.model, 'Item');
  assert.equal(typeof ref.id, 'string');
  return { model: 'Item', id: ref.id as string };
}

function interfaceErrorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /INTERFACE_[A-Z_]+/.exec(message)?.[0];
}

async function itemById(client: RemoteModelDBClient, id: string): Promise<Record<string, unknown>> {
  const rows = await modelRows(client, 'Item');
  const row = rows.find((candidate) => candidate._id === id);
  assert.ok(row);
  return row;
}

async function auditRows(
  client: RemoteModelDBClient,
  model: string,
  libraryCode: string,
): Promise<Record<string, unknown>[]> {
  const rows = await modelRows(client, model);
  return rows.filter((row) => row.library_code === libraryCode);
}

async function cleanupDesignerRows(
  client: RemoteModelDBClient,
  libraryCode: string,
): Promise<void> {
  const deletes: Array<{ model: string; id: string }> = [];
  for (const model of [
    SYS_QUERY_INTERFACE,
    SYS_OPERATION_INTERFACE,
    SYS_BINDING_SURFACE,
    SYS_BINDING_SURFACE_CALL_LOG,
    SYS_QUERY_INTERFACE_CALL_LOG,
    SYS_OPERATION_INTERFACE_CALL_LOG,
  ]) {
    const rows = await modelRows(client, model);
    for (const row of rows) {
      if (row.library_code === libraryCode && typeof row._id === 'string') {
        deletes.push({ model, id: row._id });
      }
    }
  }
  if (deletes.length > 0) {
    const result = await client.batchDelete(deletes, { sync: true });
    assert.equal(result.failureCount, 0);
  }
}

async function modelRows(
  client: RemoteModelDBClient,
  model: string,
): Promise<Record<string, unknown>[]> {
  const raw = await client.model(model).query().execute();
  assert.ok(Array.isArray(raw), `Expected rows while reading ${model}.`);
  return raw.map(remoteRowData);
}

function remoteRowData(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && 'getData' in value);
  const getData = (value as { getData?: unknown }).getData;
  if (typeof getData !== 'function') {
    throw new Error('Expected a hydrated row with getData().');
  }
  const data = getData.call(value) as unknown;
  assert.ok(data && typeof data === 'object' && !Array.isArray(data));
  return data as Record<string, unknown>;
}

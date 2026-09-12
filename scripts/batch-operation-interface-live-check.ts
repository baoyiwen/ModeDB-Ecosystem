import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  interfaceParameterPlaceholder,
  isPublishedOperationExecutionTemplate,
  RemoteModelDBClient,
  type PublishedOperationExecutionTemplate,
} from '@mode-db/sdk';
import {
  SYS_OPERATION_INTERFACE,
  SYS_OPERATION_INTERFACE_CALL_LOG,
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
const inspectDisplayName = process.argv[3]?.trim();
const suffix = Date.now().toString(36);
const database = `__batch_operation_call_${suffix}`;
const continueCallable = `batchContinue_${suffix}`;
const stopCallable = `batchStop_${suffix}`;
let businessClient: RemoteModelDBClient | undefined;
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

  if (inspectDisplayName) {
    await printRegistrySummary(designerClient, inspectDisplayName);
  }

  await businessClient.registerModel('Item', { name: 'String', score: 'Number' });
  const first = await businessClient
    .model('Item')
    .insertOne({ name: 'First', score: 1 }, { sync: true });
  const third = await businessClient
    .model('Item')
    .insertOne({ name: 'Third', score: 3 }, { sync: true });

  await installRelease(designerClient, database, continueCallable, batchUpdateTemplate('continue'));
  await installRelease(designerClient, database, stopCallable, batchUpdateTemplate('stop'));

  const continueResult = await businessClient.invokeOperationInterface(continueCallable, {
    version: '1.0.0',
    parameters: {
      items: [
        { id: first.id, name: 'First continued' },
        { id: '', name: 'Invalid' },
        { id: third.id, name: 'Third continued' },
      ],
    },
  });
  assert.deepEqual(batchSummary(continueResult.output), {
    ok: false,
    status: 'partial',
    requestedCount: 3,
    attemptedCount: 3,
    successCount: 2,
    failureCount: 1,
    skippedCount: 0,
  });

  const stopResult = await businessClient.invokeOperationInterface(stopCallable, {
    version: '1.0.0',
    parameters: {
      items: [
        { id: first.id, name: 'First stopped' },
        { id: '', name: 'Invalid' },
        { id: third.id, name: 'Not attempted' },
      ],
    },
  });
  assert.deepEqual(batchSummary(stopResult.output), {
    ok: false,
    status: 'partial',
    requestedCount: 3,
    attemptedCount: 2,
    successCount: 1,
    failureCount: 1,
    skippedCount: 1,
  });

  console.log(
    JSON.stringify(
      {
        database,
        continue: continueResult.output,
        stop: stopResult.output,
      },
      null,
      2,
    ),
  );
} finally {
  if (designerClient) {
    await deleteRowsForLibrary(designerClient, SYS_OPERATION_INTERFACE, database);
    await deleteRowsForLibrary(designerClient, SYS_OPERATION_INTERFACE_CALL_LOG, database);
    designerClient.close();
  }
  businessClient?.close();
  await RemoteModelDBClient.deleteDatabase({ host, port, token, name: database });
}

async function installRelease(
  client: RemoteModelDBClient,
  libraryCode: string,
  callableName: string,
  executionTemplate: PublishedOperationExecutionTemplate,
): Promise<void> {
  const now = new Date().toISOString();
  const result = await client.model(SYS_OPERATION_INTERFACE).insertMany(
    [
      {
        _id: `${libraryCode}_${callableName}`,
        library_code: libraryCode,
        interface_id: callableName,
        display_name: callableName,
        operation_json: '{}',
        signature: `live-check-${callableName}`,
        created_at: now,
        updated_at: now,
        release_json: JSON.stringify({
          version: '1.0.0',
          publishedAt: now,
          callableName,
          signature: `live-check-${callableName}`,
          operationInterface: {
            status: 'active',
            contract: { permissions: { mode: 'none' } },
          },
          executionTemplate,
        }),
        release_history_json: '',
      },
    ],
    { sync: true },
  );
  assert.equal(result.failureCount, 0);
}

async function printRegistrySummary(
  client: RemoteModelDBClient,
  displayName: string,
): Promise<void> {
  const rows = (await modelRows(client, SYS_OPERATION_INTERFACE))
    .filter((row) => row.display_name === displayName)
    .map((row) => {
      const release = parseJsonRecord(row.release_json);
      const operationInterface = parseJsonRecord(row.operation_json);
      const releaseOperationInterface = objectRecord(release.operationInterface);
      const executionTemplate = release.executionTemplate;
      return {
        id: row._id,
        libraryCode: row.library_code,
        interfaceId: row.interface_id,
        operationStatus: operationInterface.status,
        releaseStatus: releaseOperationInterface.status,
        callableName: release.callableName,
        version: release.version,
        executionTemplateValid: isPublishedOperationExecutionTemplate(executionTemplate),
        batch: objectRecord(objectRecord(executionTemplate).batch),
        transaction: objectRecord(objectRecord(executionTemplate).transaction),
        releaseJsonLength: typeof row.release_json === 'string' ? row.release_json.length : -1,
        updatedAt: row.updated_at,
      };
    });
  console.log(JSON.stringify({ inspectedOperationInterfaces: rows }, null, 2));
}

async function deleteRowsForLibrary(
  client: RemoteModelDBClient,
  model: string,
  libraryCode: string,
): Promise<void> {
  const refs = (await modelRows(client, model))
    .filter((row) => row.library_code === libraryCode && typeof row._id === 'string')
    .map((row) => ({ model, id: row._id as string }));
  if (refs.length > 0) {
    const result = await client.batchDelete(refs, { sync: true });
    assert.equal(result.failureCount, 0);
  }
}

function batchUpdateTemplate(
  failureMode: 'continue' | 'stop',
): PublishedOperationExecutionTemplate {
  return {
    format: 1,
    operation: {
      op: 'update',
      model: 'Item',
      id: interfaceParameterPlaceholder('param_id'),
      partial: { name: interfaceParameterPlaceholder('param_name') },
      sync: true,
    },
    parameters: [
      { id: 'param_id', name: 'id', type: 'recordRef', required: true },
      { id: 'param_name', name: 'name', type: 'string', required: true },
    ],
    batch: { itemsParameter: 'items', maxItems: 10, failureMode },
    transaction: { mode: 'batch', rollbackOnFailure: false },
    result: { returns: 'summary', includeItemResults: true },
  };
}

function batchSummary(output: unknown): Record<string, unknown> {
  assert.ok(output && typeof output === 'object');
  const value = output as Record<string, unknown>;
  return {
    ok: value.ok,
    status: value.status,
    requestedCount: value.requestedCount,
    attemptedCount: value.attemptedCount,
    successCount: value.successCount,
    failureCount: value.failureCount,
    skippedCount: value.skippedCount,
  };
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || !value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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

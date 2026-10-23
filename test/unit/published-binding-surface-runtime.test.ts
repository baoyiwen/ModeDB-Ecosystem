import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { AuthoringEngine } from '@mode-db/core';
import {
  interfaceParameterPlaceholder,
  queryInterfaceAccessKeyDigest,
  queryParameterPlaceholder,
  type PublishedBindingSurfaceContract,
  type PublishedOperationExecutionTemplate,
  type PublishedQueryExecutionTemplate,
} from '@mode-db/shared';
import { executePublishedBindingSurface } from '../../packages/server/src/published-binding-surface-runtime.js';

describe('published binding surface runtime', () => {
  it('reads through a fixed query release and exposes root record references', async () => {
    await withRuntime(async ({ designer, getEngine }) => {
      await installQueryRelease(designer);
      await installOperationRelease(designer);
      await installSurfaceRelease(designer, surfaceContract('1.0.0', 'afterMutation'));

      const result = await executePublishedBindingSurface({
        atlas: 'business',
        designerWorkspace: 'designer',
        body: {
          op: 'executeBindingSurface',
          surfaceId: 'item-editor',
          parameters: { category: 'A' },
          action: { kind: 'read' },
        },
        getEngine,
      });

      assert.equal(result.status, 'success');
      assert.equal(result.action, 'read');
      assert.equal(result.query?.rows.length, 1);
      const recordRef = result.query?.rows[0]?.$recordRef as
        | { nodeId?: string; model?: string; id?: string }
        | undefined;
      assert.equal(recordRef?.nodeId, 'node_item');
      assert.equal(recordRef?.model, 'Item');
      assert.equal(typeof recordRef?.id, 'string');
      assert.equal(result.query?.rows[0]?.name, 'First');
    });
  });

  it('enforces surface access, rate limits, and writes sanitized audit rows', async () => {
    await withRuntime(async ({ designer, getEngine }) => {
      await installQueryRelease(designer);
      await installOperationRelease(designer);
      await installSurfaceRelease(designer, {
        ...surfaceContract('1.0.0', 'manual'),
        permissions: {
          mode: 'key',
          accessKeyDigest: queryInterfaceAccessKeyDigest('surface-secret'),
          rateLimit: { maxRequests: 1, windowSeconds: 60 },
        },
      });

      const request = (accessKey?: string) =>
        executePublishedBindingSurface({
          atlas: 'business',
          designerWorkspace: 'designer',
          body: {
            op: 'executeBindingSurface',
            surfaceId: 'item-editor',
            parameters: { category: 'A' },
            ...(accessKey ? { accessKey } : {}),
            action: { kind: 'read' },
          },
          getEngine,
        });

      await assert.rejects(request(), /INTERFACE_ACCESS_KEY_REQUIRED/);
      await assert.rejects(request('wrong-secret'), /INTERFACE_ACCESS_DENIED/);
      const success = await request('surface-secret');
      assert.equal(success.status, 'success');
      await assert.rejects(request('surface-secret'), /INTERFACE_RATE_LIMITED/);

      const audits = (await designer.persistence
        .getMergedReader()
        .getAll('sys_binding_surface_call_log'))
        .filter((row) => row.library_code === 'business');
      assert.equal(audits.length, 4);
      assert.deepEqual(
        audits.map((row) => row.status),
        ['error', 'error', 'success', 'error'],
      );
      assert.deepEqual(
        audits.map((row) => row.error_code),
        [
          'INTERFACE_ACCESS_KEY_REQUIRED',
          'INTERFACE_ACCESS_DENIED',
          '',
          'INTERFACE_RATE_LIMITED',
        ],
      );
      assert.equal(
        audits.some(
          (row) =>
            'parameters' in row ||
            'access_key' in row ||
            'accessKey' in row ||
            'edited_value' in row,
        ),
        false,
      );
    });
  });

  it('binds edited values and row refs, then refreshes after a mutation', async () => {
    await withRuntime(async ({ designer, getEngine }) => {
      await installQueryRelease(designer);
      await installOperationRelease(designer);
      await installSurfaceRelease(designer, surfaceContract('1.0.0', 'afterMutation'));
      const initial = await executePublishedBindingSurface({
        atlas: 'business',
        designerWorkspace: 'designer',
        body: {
          op: 'executeBindingSurface',
          surfaceId: 'item-editor',
          parameters: { category: 'A' },
          action: { kind: 'read' },
        },
        getEngine,
      });
      const recordRef = initial.query?.rows[0]?.$recordRef as
        | { nodeId: string; model: string; id: string }
        | undefined;
      assert.ok(recordRef);

      const result = await executePublishedBindingSurface({
        atlas: 'business',
        designerWorkspace: 'designer',
        body: {
          op: 'executeBindingSurface',
          surfaceId: 'item-editor',
          parameters: { category: 'A' },
          action: {
            kind: 'mutate',
            mutationId: 'update-name',
            editedValue: 'Updated',
            recordRefs: { node_item: recordRef },
          },
        },
        getEngine,
      });

      assert.equal(result.status, 'success');
      assert.equal(result.mutation?.result.operation, 'update');
      assert.equal(result.query?.rows[0]?.name, 'Updated');
      assert.equal((result.query?.rows[0]?.$recordRef as { id?: string })?.id, recordRef.id);
    });
  });

  it('supports manual refresh and reports refresh failure without losing mutation success', async () => {
    await withRuntime(async ({ business, designer, getEngine }) => {
      await installQueryRelease(designer);
      await installOperationRelease(designer);
      const manual = surfaceContract('1.0.0', 'manual');
      await installSurfaceRelease(designer, manual);
      const row = (await business.persistence.getMergedReader().getAll('Item'))[0]!;

      const manualResult = await executePublishedBindingSurface({
        atlas: 'business',
        designerWorkspace: 'designer',
        body: {
          op: 'executeBindingSurface',
          surfaceId: 'item-editor',
          parameters: { category: 'A' },
          action: {
            kind: 'mutate',
            mutationId: 'update-name',
            editedValue: 'Manual',
            recordRefs: { node_item: { model: 'Item', id: String(row._id) } },
          },
        },
        getEngine,
      });
      assert.equal(manualResult.status, 'success');
      assert.equal(manualResult.query, undefined);

      await replaceSurfaceRelease(
        designer,
        {
          ...surfaceContract('2.0.0', 'afterMutation'),
          query: {
            ...surfaceContract('2.0.0', 'afterMutation').query,
            version: '9.9.9',
          },
        },
        manual,
      );
      const refreshFailed = await executePublishedBindingSurface({
        atlas: 'business',
        designerWorkspace: 'designer',
        body: {
          op: 'executeBindingSurface',
          surfaceId: 'item-editor',
          parameters: { category: 'A' },
          action: {
            kind: 'mutate',
            mutationId: 'update-name',
            editedValue: 'Committed',
            recordRefs: { node_item: { model: 'Item', id: String(row._id) } },
          },
        },
        getEngine,
      });
      assert.equal(refreshFailed.status, 'refreshFailed');
      assert.equal(refreshFailed.mutation?.result.operation, 'update');
      assert.equal(refreshFailed.refreshError?.code, 'INTERFACE_RELEASE_NOT_FOUND');
      const persisted = (await business.persistence.getMergedReader().getAll('Item')).find(
        (candidate) => candidate._id === row._id,
      );
      assert.equal(persisted?.name, 'Committed');
      const surfaceAudits = (await designer.persistence
        .getMergedReader()
        .getAll('sys_binding_surface_call_log'))
        .filter((audit) => audit.library_code === 'business');
      assert.deepEqual(
        surfaceAudits.map((audit) => audit.status),
        ['success', 'refresh_failed'],
      );
      assert.equal(surfaceAudits[1]?.error_code, 'INTERFACE_RELEASE_NOT_FOUND');
    });
  });

  it('does not refresh when the mutation itself fails', async () => {
    await withRuntime(async ({ business, designer, getEngine }) => {
      await installQueryRelease(designer);
      await installOperationRelease(designer);
      await installSurfaceRelease(designer, surfaceContract('1.0.0', 'afterMutation'));

      await executePublishedBindingSurface({
        atlas: 'business',
        designerWorkspace: 'designer',
        body: {
          op: 'executeBindingSurface',
          surfaceId: 'item-editor',
          parameters: { category: 'A' },
          action: { kind: 'read' },
        },
        getEngine,
      });

      await assert.rejects(
        executePublishedBindingSurface({
          atlas: 'business',
          designerWorkspace: 'designer',
          body: {
            op: 'executeBindingSurface',
            surfaceId: 'item-editor',
            parameters: { category: 'A' },
            action: {
              kind: 'mutate',
              mutationId: 'update-name',
              editedValue: 'Must not be written',
            },
          },
          getEngine,
        }),
        /INTERFACE_PARAMETER_REQUIRED:id/,
      );

      const queryAudits = await designer.persistence
        .getMergedReader()
        .getAll('sys_query_interface_call_log');
      assert.equal(queryAudits.filter((row) => row.library_code === 'business').length, 1);

      const operationAudits = await designer.persistence
        .getMergedReader()
        .getAll('sys_operation_interface_call_log');
      const failedOperationAudits = operationAudits.filter(
        (row) => row.library_code === 'business',
      );
      assert.equal(failedOperationAudits.length, 1);
      assert.equal(failedOperationAudits[0]?.status, 'error');
      assert.equal(failedOperationAudits[0]?.error_code, 'INTERFACE_PARAMETER_REQUIRED');

      const persisted = (await business.persistence.getMergedReader().getAll('Item'))[0];
      assert.equal(persisted?.name, 'First');
    });
  });

  it('resolves explicit historical surface versions and rejects unknown mutations', async () => {
    await withRuntime(async ({ designer, getEngine }) => {
      await installQueryRelease(designer);
      await installOperationRelease(designer);
      const historical = surfaceContract('1.0.0', 'manual');
      await installSurfaceRelease(designer, surfaceContract('2.0.0', 'manual'), [historical]);

      const result = await executePublishedBindingSurface({
        atlas: 'business',
        designerWorkspace: 'designer',
        body: {
          op: 'executeBindingSurface',
          surfaceId: 'item-editor',
          version: '1.0.0',
          parameters: { category: 'A' },
          action: { kind: 'read' },
        },
        getEngine,
      });
      assert.equal(result.version, '1.0.0');

      await assert.rejects(
        executePublishedBindingSurface({
          atlas: 'business',
          designerWorkspace: 'designer',
          body: {
            op: 'executeBindingSurface',
            surfaceId: 'item-editor',
            parameters: { category: 'A' },
            action: { kind: 'mutate', mutationId: 'missing' },
          },
          getEngine,
        }),
        /INTERFACE_BINDING_MUTATION_NOT_FOUND:missing/,
      );
    });
  });
});

async function withRuntime(
  run: (context: {
    business: AuthoringEngine;
    designer: AuthoringEngine;
    getEngine: (atlas: string) => Promise<AuthoringEngine>;
  }) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'modedb-published-binding-surface-'));
  const business = new AuthoringEngine({
    atlas: 'business',
    storageRoot: root,
    keyProvider: fixtureVaultKeys(root),
  });
  const designer = new AuthoringEngine({
    atlas: 'designer',
    storageRoot: root,
    keyProvider: fixtureVaultKeys(root),
  });
  try {
    business.registerModel('Item', { category: 'String', name: 'String' });
    await business.insert('Item', { category: 'A', name: 'First' }, { sync: true });
    await business.insert('Item', { category: 'B', name: 'Second' }, { sync: true });
    designer.registerModel('sys_query_interface', releaseModel());
    designer.registerModel('sys_operation_interface', releaseModel());
    designer.registerModel('sys_binding_surface', {
      library_code: 'String',
      surface_id: 'String',
      release_json: 'String',
      release_history_json: 'String',
    });
    const engines = new Map([
      ['business', business],
      ['designer', designer],
    ]);
    await run({
      business,
      designer,
      getEngine: async (atlas) => {
        const engine = engines.get(atlas);
        if (!engine) {
          throw new Error(`Unknown test atlas: ${atlas}`);
        }
        return engine;
      },
    });
  } finally {
    await Promise.all([business.close(), designer.close()]);
    rmSync(root, { recursive: true, force: true });
  }
}

function releaseModel(): Record<string, 'String'> {
  return {
    library_code: 'String',
    release_json: 'String',
    release_history_json: 'String',
  };
}

async function installQueryRelease(designer: AuthoringEngine): Promise<void> {
  await designer.insert(
    'sys_query_interface',
    {
      library_code: 'business',
      release_json: JSON.stringify({
        version: '1.0.0',
        publishedAt: '2026-07-22T00:00:00.000Z',
        callableName: 'itemsByCategory',
        signature: 'query-signature',
        queryInterface: { status: 'active', contract: { permissions: { mode: 'none' } } },
        executionTemplate: queryTemplate(),
      }),
      release_history_json: '',
    },
    { sync: true },
  );
}

async function installOperationRelease(designer: AuthoringEngine): Promise<void> {
  await designer.insert(
    'sys_operation_interface',
    {
      library_code: 'business',
      release_json: JSON.stringify({
        version: '1.0.0',
        publishedAt: '2026-07-22T00:00:00.000Z',
        callableName: 'updateItem',
        signature: 'operation-signature',
        operationInterface: {
          status: 'active',
          contract: { permissions: { mode: 'none' } },
        },
        executionTemplate: updateTemplate(),
      }),
      release_history_json: '',
    },
    { sync: true },
  );
}

async function installSurfaceRelease(
  designer: AuthoringEngine,
  contract: PublishedBindingSurfaceContract,
  history: readonly PublishedBindingSurfaceContract[] = [],
): Promise<void> {
  await designer.insert(
    'sys_binding_surface',
    {
      library_code: 'business',
      surface_id: contract.surfaceId,
      release_json: JSON.stringify(storedSurfaceRelease(contract)),
      release_history_json: JSON.stringify(history.map(storedSurfaceRelease)),
    },
    { sync: true },
  );
}

async function replaceSurfaceRelease(
  designer: AuthoringEngine,
  contract: PublishedBindingSurfaceContract,
  historical: PublishedBindingSurfaceContract,
): Promise<void> {
  const row = (await designer.persistence.getMergedReader().getAll('sys_binding_surface'))[0]!;
  await designer.update(
    'sys_binding_surface',
    String(row._id),
    {
      release_json: JSON.stringify(storedSurfaceRelease(contract)),
      release_history_json: JSON.stringify([storedSurfaceRelease(historical)]),
    },
    { sync: true },
  );
}

function storedSurfaceRelease(contract: PublishedBindingSurfaceContract): Record<string, unknown> {
  return {
    version: contract.version,
    publishedAt: '2026-07-22T00:00:00.000Z',
    signature: `surface-signature-${contract.version}`,
    bindingSurface: { status: 'active' },
    contract,
  };
}

function surfaceContract(
  version: string,
  refresh: 'manual' | 'afterMutation',
): PublishedBindingSurfaceContract {
  return {
    format: 1,
    surfaceId: 'item-editor',
    name: 'Item editor',
    version,
    parameters: [
      { id: 'surface_category', name: 'category', type: 'string', required: true },
    ],
    query: {
      interfaceId: 'query-items',
      callableName: 'itemsByCategory',
      version: '1.0.0',
      parameterBindings: [
        {
          parameterId: 'parameter_category',
          source: { kind: 'surfaceParameter', parameterId: 'surface_category' },
        },
      ],
    },
    writeback: {
      mode: 'explicit',
      refresh,
      mutations: [
        {
          id: 'update-name',
          trigger: { kind: 'update', fieldPath: 'name' },
          operation: {
            interfaceId: 'operation-update-item',
            callableName: 'updateItem',
            version: '1.0.0',
            operationType: 'update',
          },
          parameterBindings: [
            {
              parameterId: 'param_id',
              source: { kind: 'rowRecordRef', nodeId: 'node_item' },
            },
            { parameterId: 'param_name', source: { kind: 'editedValue' } },
          ],
        },
      ],
    },
  };
}

function queryTemplate(): PublishedQueryExecutionTemplate {
  return {
    format: 1,
    snapshot: {
      plan: {
        version: 2,
        originModel: 'Item',
        start: { kind: 'all' },
        hops: [],
        trailing: {
          type: 'atom',
          field: 'category',
          op: 'eq',
          value: queryParameterPlaceholder('parameter_category'),
        },
      },
      execute: {},
      analysis: { groupBy: null, compute: null },
    },
    parameters: [
      { id: 'parameter_category', name: 'category', type: 'string', required: true },
    ],
    resultAdapter: {
      kind: 'rows',
      rootNodeId: 'node_item',
      fieldsByNode: {
        node_item: [
          { sourceField: 'category', outputName: 'category' },
          { sourceField: 'name', outputName: 'name' },
        ],
      },
      edgesBySource: {},
    },
    pagination: { mode: 'none' },
  };
}

function updateTemplate(): PublishedOperationExecutionTemplate {
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
    result: { returns: 'record' },
  };
}
import { fixtureVaultKeys } from '../vault-keys.js';

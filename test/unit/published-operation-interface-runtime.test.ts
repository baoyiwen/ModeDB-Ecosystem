import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { AuthoringEngine } from '@mode-db/core';
import {
  interfaceParameterPlaceholder,
  type PublishedOperationExecutionTemplate,
} from '@mode-db/shared';
import { executePublishedOperationInterface } from '../../packages/server/src/published-operation-interface-runtime.js';

describe('published operation interface runtime', () => {
  it('executes create, update and delete releases with adapted results and audit rows', async () => {
    await withRuntime(async ({ business, designer, getEngine }) => {
      await installRelease(designer, 'createItem', createTemplate());
      await installRelease(designer, 'updateItem', updateTemplate());
      await installRelease(designer, 'deleteItem', deleteTemplate());

      const created = await executePublishedOperationInterface({
        atlas: 'business',
        designerWorkspace: 'designer',
        body: {
          op: 'executeOperationInterface',
          callableName: 'createItem',
          parameters: { name: 'First', score: '7' },
        },
        getEngine,
      });
      assert.equal(created.operation, 'create');
      assert.equal((created.output as Record<string, unknown>).name, 'First');
      assert.equal((created.output as Record<string, unknown>).score, 7);
      const id = (created.output as Record<string, unknown>)._id;
      assert.equal(typeof id, 'string');

      const updated = await executePublishedOperationInterface({
        atlas: 'business',
        designerWorkspace: 'designer',
        body: {
          op: 'executeOperationInterface',
          callableName: 'updateItem',
          parameters: { id, name: 'Updated' },
        },
        getEngine,
      });
      assert.equal(updated.operation, 'update');
      assert.equal((updated.output as Record<string, unknown>).name, 'Updated');

      const deleted = await executePublishedOperationInterface({
        atlas: 'business',
        designerWorkspace: 'designer',
        body: {
          op: 'executeOperationInterface',
          callableName: 'deleteItem',
          parameters: { id },
        },
        getEngine,
      });
      assert.deepEqual(deleted.output, { ok: true, affectedCount: 1 });

      const auditRows = await designer.persistence
        .getMergedReader()
        .getAll('sys_operation_interface_call_log');
      assert.deepEqual(
        auditRows.map((row) => [row.callable_name, row.operation_type, row.status]),
        [
          ['createItem', 'create', 'success'],
          ['updateItem', 'update', 'success'],
          ['deleteItem', 'delete', 'success'],
        ],
      );
      assert.ok(business.registry.getModel('Item'));
    });
  });

  it('rejects missing parameters before mutation and records a structured audit error', async () => {
    await withRuntime(async ({ designer, getEngine }) => {
      await installRelease(designer, 'createItem', createTemplate());
      await assert.rejects(
        executePublishedOperationInterface({
          atlas: 'business',
          designerWorkspace: 'designer',
          body: { op: 'executeOperationInterface', callableName: 'createItem' },
          getEngine,
        }),
        /INTERFACE_PARAMETER_REQUIRED:name/,
      );
      const auditRows = await designer.persistence
        .getMergedReader()
        .getAll('sys_operation_interface_call_log');
      assert.equal(auditRows[0]?.error_code, 'INTERFACE_PARAMETER_REQUIRED');
    });
  });

  it('returns the inserted and updated record from a published upsert release', async () => {
    await withRuntime(async ({ designer, getEngine }) => {
      await installRelease(designer, 'upsertItem', upsertTemplate());
      const first = await executePublishedOperationInterface({
        atlas: 'business',
        designerWorkspace: 'designer',
        body: {
          op: 'executeOperationInterface',
          callableName: 'upsertItem',
          parameters: { name: 'Stable key', score: 1 },
        },
        getEngine,
      });
      const second = await executePublishedOperationInterface({
        atlas: 'business',
        designerWorkspace: 'designer',
        body: {
          op: 'executeOperationInterface',
          callableName: 'upsertItem',
          parameters: { name: 'Stable key', score: 2 },
        },
        getEngine,
      });
      assert.equal(first.operation, 'upsert');
      assert.equal((first.output as Record<string, unknown>).score, 1);
      assert.equal(second.operation, 'upsert');
      assert.equal((second.output as Record<string, unknown>).score, 2);
      assert.equal(
        (first.output as Record<string, unknown>)._id,
        (second.output as Record<string, unknown>)._id,
      );
    });
  });

  it('executes bind, rebind and unbind releases against the relation index', async () => {
    await withRuntime(async ({ business, designer, getEngine }) => {
      business.registerModel('Department', { name: 'String' });
      business.registerModel('Employee', { name: 'String' });
      business.registerRelation(
        'Department',
        'Employee',
        'members',
        'department',
        'one-to-many',
      );
      const department = await business.insert('Department', { name: 'Platform' }, { sync: true });
      const first = await business.insert('Employee', { name: 'First' }, { sync: true });
      const second = await business.insert('Employee', { name: 'Second' }, { sync: true });
      await installRelease(designer, 'bindMember', relationTemplate('bindPair'));
      await installRelease(designer, 'rebindMember', relationTemplate('rebindPair'));
      await installRelease(designer, 'unbindMember', relationTemplate('unlinkPair'));

      const bound = await executePublishedOperationInterface({
        atlas: 'business',
        designerWorkspace: 'designer',
        body: {
          op: 'executeOperationInterface',
          callableName: 'bindMember',
          parameters: { sourceId: department._id, targetId: first._id },
        },
        getEngine,
      });
      assert.equal(bound.operation, 'bind');
      assert.deepEqual(bound.output, { ok: true, affectedCount: 1 });

      const rebound = await executePublishedOperationInterface({
        atlas: 'business',
        designerWorkspace: 'designer',
        body: {
          op: 'executeOperationInterface',
          callableName: 'rebindMember',
          parameters: {
            sourceId: department._id,
            previousTargetId: first._id,
            nextTargetId: second._id,
          },
        },
        getEngine,
      });
      assert.equal(rebound.operation, 'rebind');
      assert.deepEqual(rebound.output, { ok: true, affectedCount: 1 });

      const relation = business.registry.getRelations().find((entry) => entry.forward === 'members');
      assert.ok(relation);
      assert.deepEqual(await business.indexer.getForward(relation, department._id), [second._id]);

      const unbound = await executePublishedOperationInterface({
        atlas: 'business',
        designerWorkspace: 'designer',
        body: {
          op: 'executeOperationInterface',
          callableName: 'unbindMember',
          parameters: { sourceId: department._id, targetId: second._id },
        },
        getEngine,
      });
      assert.equal(unbound.operation, 'unbind');
      assert.deepEqual(unbound.output, { ok: true, affectedCount: 1 });
      assert.deepEqual(await business.indexer.getForward(relation, department._id), []);
    });
  });

  it('continues a batch after item failure and returns a partial-success contract', async () => {
    await withRuntime(async ({ business, designer, getEngine }) => {
      const first = await business.insert('Item', { name: 'First', score: 1 }, { sync: true });
      const third = await business.insert('Item', { name: 'Third', score: 3 }, { sync: true });
      await installRelease(designer, 'batchUpdateItems', batchUpdateTemplate('continue'));

      const result = await executePublishedOperationInterface({
        atlas: 'business',
        designerWorkspace: 'designer',
        body: {
          op: 'executeOperationInterface',
          callableName: 'batchUpdateItems',
          parameters: {
            items: [
              { id: first._id, name: 'First updated' },
              { id: '', name: 'Invalid' },
              { id: third._id, name: 'Third updated' },
            ],
          },
        },
        getEngine,
      });

      assert.equal(result.operation, 'batch');
      const output = result.output as Record<string, unknown>;
      assert.deepEqual(
        {
          ok: output.ok,
          status: output.status,
          requestedCount: output.requestedCount,
          attemptedCount: output.attemptedCount,
          successCount: output.successCount,
          failureCount: output.failureCount,
          skippedCount: output.skippedCount,
        },
        {
          ok: false,
          status: 'partial',
          requestedCount: 3,
          attemptedCount: 3,
          successCount: 2,
          failureCount: 1,
          skippedCount: 0,
        },
      );
      assert.equal(Array.isArray(output.items), true);
    });
  });

  it('stops a batch after the first failure and reports unattempted items', async () => {
    await withRuntime(async ({ business, designer, getEngine }) => {
      const first = await business.insert('Item', { name: 'First', score: 1 }, { sync: true });
      const third = await business.insert('Item', { name: 'Third', score: 3 }, { sync: true });
      await installRelease(designer, 'stoppingBatch', batchUpdateTemplate('stop'));

      const result = await executePublishedOperationInterface({
        atlas: 'business',
        designerWorkspace: 'designer',
        body: {
          op: 'executeOperationInterface',
          callableName: 'stoppingBatch',
          parameters: {
            items: [
              { id: first._id, name: 'First updated' },
              { id: '', name: 'Invalid' },
              { id: third._id, name: 'Not attempted' },
            ],
          },
        },
        getEngine,
      });

      assert.deepEqual(result.output, {
        ok: false,
        status: 'partial',
        requestedCount: 3,
        attemptedCount: 2,
        successCount: 1,
        failureCount: 1,
        skippedCount: 1,
        items: [
          {
            index: 0,
            ok: true,
            affectedCount: 1,
            recordRef: { model: 'Item', id: first._id },
          },
          {
            index: 1,
            ok: false,
            error: {
              code: 'INTERFACE_BATCH_ITEM_INVALID',
              message: 'INTERFACE_BATCH_ITEM_INVALID:1:INTERFACE_PARAMETER_REQUIRED:id',
            },
          },
        ],
      });
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
  const root = mkdtempSync(join(tmpdir(), 'modedb-published-operation-interface-'));
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
    business.registerModel('Item', { name: 'String', score: 'Number' });
    designer.registerModel('sys_operation_interface', {
      library_code: 'String',
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

async function installRelease(
  designer: AuthoringEngine,
  callableName: string,
  executionTemplate: PublishedOperationExecutionTemplate,
): Promise<void> {
  await designer.insert(
    'sys_operation_interface',
    {
      library_code: 'business',
      release_json: JSON.stringify({
        version: '1.0.0',
        publishedAt: '2026-07-21T00:00:00.000Z',
        callableName,
        signature: `signature-${callableName}`,
        operationInterface: {
          status: 'active',
          contract: { permissions: { mode: 'none' } },
        },
        executionTemplate,
      }),
      release_history_json: '',
    },
    { sync: true },
  );
}

function createTemplate(): PublishedOperationExecutionTemplate {
  return {
    format: 1,
    operation: {
      op: 'insert',
      model: 'Item',
      data: {
        name: interfaceParameterPlaceholder('param_name'),
        score: interfaceParameterPlaceholder('param_score'),
      },
      sync: true,
    },
    parameters: [
      { id: 'param_name', name: 'name', type: 'string', required: true },
      { id: 'param_score', name: 'score', type: 'number', required: false },
    ],
    result: { returns: 'record' },
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

function deleteTemplate(): PublishedOperationExecutionTemplate {
  return {
    format: 1,
    operation: {
      op: 'delete',
      model: 'Item',
      id: interfaceParameterPlaceholder('param_id'),
      sync: true,
    },
    parameters: [{ id: 'param_id', name: 'id', type: 'recordRef', required: true }],
    result: { returns: 'summary' },
  };
}

function relationTemplate(
  op: 'bindPair' | 'unlinkPair' | 'rebindPair',
): PublishedOperationExecutionTemplate {
  const source = { model: 'Department', id: interfaceParameterPlaceholder('param_source') };
  const target = { model: 'Employee', id: interfaceParameterPlaceholder('param_target') };
  const operation: PublishedOperationExecutionTemplate['operation'] =
    op === 'rebindPair'
      ? {
          op,
          forward: 'members',
          reverse: 'department',
          source,
          previousTarget: {
            model: 'Employee',
            id: interfaceParameterPlaceholder('param_previous_target'),
          },
          nextTarget: {
            model: 'Employee',
            id: interfaceParameterPlaceholder('param_next_target'),
          },
        }
      : { op, forward: 'members', reverse: 'department', source, target };
  return {
    format: 1,
    operation,
    parameters:
      op === 'rebindPair'
        ? [
            { id: 'param_source', name: 'sourceId', type: 'recordRef', required: true },
            {
              id: 'param_previous_target',
              name: 'previousTargetId',
              type: 'recordRef',
              required: true,
            },
            {
              id: 'param_next_target',
              name: 'nextTargetId',
              type: 'recordRef',
              required: true,
            },
          ]
        : [
            { id: 'param_source', name: 'sourceId', type: 'recordRef', required: true },
            { id: 'param_target', name: 'targetId', type: 'recordRef', required: true },
          ],
    result: { returns: 'summary' },
  };
}

function upsertTemplate(): PublishedOperationExecutionTemplate {
  return {
    format: 1,
    operation: {
      op: 'insertMany',
      model: 'Item',
      rows: [
        {
          name: interfaceParameterPlaceholder('param_name'),
          score: interfaceParameterPlaceholder('param_score'),
        },
      ],
      sync: true,
      returning: true,
      upsert: { matchFields: ['name'], updateExisting: true },
    },
    parameters: [
      { id: 'param_name', name: 'name', type: 'string', required: true },
      { id: 'param_score', name: 'score', type: 'number', required: true },
    ],
    result: { returns: 'record' },
  };
}

function batchUpdateTemplate(
  failureMode: 'continue' | 'stop',
): PublishedOperationExecutionTemplate {
  return {
    ...updateTemplate(),
    batch: { itemsParameter: 'items', maxItems: 10, failureMode },
    transaction: { mode: 'batch', rollbackOnFailure: false },
    result: { returns: 'summary', includeItemResults: true },
  };
}
import { fixtureVaultKeys } from '../vault-keys.js';

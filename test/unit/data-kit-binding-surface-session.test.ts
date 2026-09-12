import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  bindingSurfaceRecordRefs,
  createBindingSurfaceSession,
  type BindingSurfaceExecutor,
} from '@mode-db/data-kit';
import type { WireBindingSurfaceResult } from '@mode-db/shared';

describe('BindingSurfaceSession', () => {
  it('refreshes a surface and derives record refs for row mutations', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const executor: BindingSurfaceExecutor = {
      async invokeBindingSurface(surfaceId, options) {
        calls.push({ surfaceId, options });
        return readResult('First');
      },
    };
    const session = createBindingSurfaceSession({
      surfaceId: 'item-editor',
      executor,
      version: '1.0.0',
      parameters: { category: 'A' },
      accessKey: 'surface-secret',
    });

    const shape = await session.refresh({ limit: 20 });
    assert.equal(shape.kind, 'tabular');
    assert.equal(session.rows[0]?.name, 'First');
    assert.deepEqual(session.recordRefsForRow(0), {
      node_item: { model: 'Item', id: 'item-1' },
    });
    assert.equal(session.resolvedVersion, '1.0.0');
    assert.equal(session.needsRefresh, false);
    const options = calls[0]?.options as {
      action?: unknown;
      parameters?: unknown;
      version?: unknown;
      accessKey?: unknown;
    };
    assert.deepEqual(options.action, { kind: 'read', limit: 20 });
    assert.deepEqual(options.parameters, { category: 'A' });
    assert.equal(options.version, '1.0.0');
    assert.equal(options.accessKey, 'surface-secret');
  });

  it('uses the selected raw row for mutation and consumes an automatic refresh', async () => {
    let requestCount = 0;
    const executor: BindingSurfaceExecutor = {
      async invokeBindingSurface(_surfaceId, options) {
        requestCount += 1;
        if (options.action.kind === 'read') {
          return readResult('First');
        }
        assert.equal(options.action.mutationId, 'update-name');
        assert.equal(options.action.editedValue, 'Updated');
        assert.equal(options.action.row?.name, 'First');
        assert.deepEqual(options.action.recordRefs, {
          node_item: { model: 'Item', id: 'item-1' },
        });
        return mutationResult({ query: readResult('Updated').query });
      },
    };
    const session = createBindingSurfaceSession({ surfaceId: 'item-editor', executor });
    await session.refresh();
    const result = await session.mutate({
      mutationId: 'update-name',
      rowIndex: 0,
      editedValue: 'Updated',
    });

    assert.equal(result.status, 'success');
    assert.equal(requestCount, 2);
    assert.equal(session.rows[0]?.name, 'Updated');
    assert.equal(session.needsRefresh, false);
    assert.equal(session.refreshError, null);
  });

  it('keeps committed mutation state distinct from manual and failed refreshes', async () => {
    const results: WireBindingSurfaceResult[] = [
      readResult('First'),
      mutationResult({}),
      {
        ...mutationResult({}),
        status: 'refreshFailed',
        refreshError: {
          code: 'INTERFACE_RELEASE_NOT_FOUND',
          message: 'INTERFACE_RELEASE_NOT_FOUND:items@2.0.0',
          category: 'not_found',
          retryable: false,
        },
      },
      readResult('Committed'),
    ];
    const executor: BindingSurfaceExecutor = {
      async invokeBindingSurface() {
        const result = results.shift();
        assert.ok(result);
        return result;
      },
    };
    const session = createBindingSurfaceSession({ surfaceId: 'item-editor', executor });
    await session.refresh();

    const manual = await session.mutate({ mutationId: 'update-name', rowIndex: 0 });
    assert.equal(manual.status, 'success');
    assert.equal(session.needsRefresh, true);
    assert.equal(session.rows[0]?.name, 'First');

    const failedRefresh = await session.mutate({ mutationId: 'update-name', rowIndex: 0 });
    assert.equal(failedRefresh.status, 'refreshFailed');
    assert.equal(session.needsRefresh, true);
    assert.equal(session.refreshError?.code, 'INTERFACE_RELEASE_NOT_FOUND');
    assert.equal(session.lastError, null);

    await session.refresh();
    assert.equal(session.needsRefresh, false);
    assert.equal(session.rows[0]?.name, 'Committed');
    assert.equal(session.refreshError, null);
  });

  it('omits ambiguous descendant refs instead of selecting an arbitrary record', () => {
    assert.deepEqual(
      bindingSurfaceRecordRefs({
        $recordRef: { nodeId: 'root', model: 'Parent', id: 'parent-1' },
        children: [
          { $recordRef: { nodeId: 'child', model: 'Child', id: 'child-1' } },
          { $recordRef: { nodeId: 'child', model: 'Child', id: 'child-2' } },
        ],
      }),
      { root: { model: 'Parent', id: 'parent-1' } },
    );
  });
});

function readResult(name: string): WireBindingSurfaceResult {
  return {
    kind: 'bindingSurface',
    surfaceId: 'item-editor',
    version: '1.0.0',
    action: 'read',
    status: 'success',
    query: {
      kind: 'interface',
      callableName: 'items',
      version: '1.0.0',
      rows: [
        {
          $recordRef: { nodeId: 'node_item', model: 'Item', id: 'item-1' },
          name,
        },
      ],
    },
  };
}

function mutationResult(input: {
  query?: WireBindingSurfaceResult['query'];
}): WireBindingSurfaceResult {
  return {
    kind: 'bindingSurface',
    surfaceId: 'item-editor',
    version: '1.0.0',
    action: 'mutate',
    status: 'success',
    mutation: {
      mutationId: 'update-name',
      result: {
        kind: 'operationInterface',
        callableName: 'updateItem',
        version: '1.0.0',
        operation: 'update',
        output: { ok: true },
      },
    },
    ...(input.query ? { query: input.query } : {}),
  };
}

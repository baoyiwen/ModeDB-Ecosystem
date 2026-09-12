import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { AuthoringEngine } from '@mode-db/core';
import {
  queryInterfaceAccessKeyDigest,
  queryParameterPlaceholder,
  type PublishedQueryExecutionTemplate,
} from '@mode-db/shared';
import { executePublishedQueryInterface } from '../../packages/server/src/published-interface-runtime.js';

describe('published query interface runtime', () => {
  it('binds parameters, executes the active release and projects contract fields', async () => {
    await withRuntime(async ({ business, designer, getEngine }) => {
      await installRelease(designer, { status: 'active' });
      const result = await executePublishedQueryInterface({
        atlas: 'business',
        designerWorkspace: 'designer',
        body: {
          op: 'executeInterface',
          callableName: 'itemsByCategory',
          version: '1.0.0',
          parameters: { category: 'A' },
        },
        getEngine,
      });

      assert.deepEqual(result, {
        kind: 'interface',
        callableName: 'itemsByCategory',
        version: '1.0.0',
        rows: [{ label: 'A', value: 2 }],
      });
      assert.ok(business.registry.getModel('Item'));
      const auditRows = await designer.persistence
        .getMergedReader()
        .getAll('sys_query_interface_call_log');
      assert.equal(auditRows.length, 1);
      assert.equal(auditRows[0]?.status, 'success');
      assert.equal(auditRows[0]?.resolved_version, '1.0.0');
      assert.equal(auditRows[0]?.row_count, 1);
      assert.equal(auditRows[0]?.parameter_count, 1);
      assert.equal('parameters' in (auditRows[0] ?? {}), false);
    });
  });

  it('rejects missing parameters, unavailable versions and deprecated releases', async () => {
    await withRuntime(async ({ designer, getEngine }) => {
      await installRelease(designer, { status: 'active' });
      await assert.rejects(
        executePublishedQueryInterface({
          atlas: 'business',
          designerWorkspace: 'designer',
          body: { op: 'executeInterface', callableName: 'itemsByCategory' },
          getEngine,
        }),
        /INTERFACE_PARAMETER_REQUIRED:category/,
      );
      await assert.rejects(
        executePublishedQueryInterface({
          atlas: 'business',
          designerWorkspace: 'designer',
          body: {
            op: 'executeInterface',
            callableName: 'itemsByCategory',
            version: '2.0.0',
            parameters: { category: 'A' },
          },
          getEngine,
        }),
        /INTERFACE_RELEASE_NOT_FOUND:itemsByCategory@2.0.0/,
      );
      const auditRows = await designer.persistence
        .getMergedReader()
        .getAll('sys_query_interface_call_log');
      assert.deepEqual(
        auditRows.map((row) => row.error_code),
        ['INTERFACE_PARAMETER_REQUIRED', 'INTERFACE_RELEASE_NOT_FOUND'],
      );
    });

    await withRuntime(async ({ designer, getEngine }) => {
      await installRelease(designer, { status: 'deprecated' });
      await assert.rejects(
        executePublishedQueryInterface({
          atlas: 'business',
          designerWorkspace: 'designer',
          body: {
            op: 'executeInterface',
            callableName: 'itemsByCategory',
            parameters: { category: 'A' },
          },
          getEngine,
        }),
        /INTERFACE_RELEASE_NOT_FOUND:itemsByCategory/,
      );
    });
  });

  it('uses only the current release by default and resolves history by explicit version', async () => {
    await withRuntime(async ({ designer, getEngine }) => {
      await installRelease(designer, {
        status: 'active',
        version: '2.0.0',
        history: [storedRelease('1.0.0', 'active', 'legacyValue')],
      });

      const current = await executePublishedQueryInterface({
        atlas: 'business',
        designerWorkspace: 'designer',
        body: {
          op: 'executeInterface',
          callableName: 'itemsByCategory',
          parameters: { category: 'A' },
        },
        getEngine,
      });
      const historical = await executePublishedQueryInterface({
        atlas: 'business',
        designerWorkspace: 'designer',
        body: {
          op: 'executeInterface',
          callableName: 'itemsByCategory',
          version: '1.0.0',
          parameters: { category: 'A' },
        },
        getEngine,
      });

      assert.deepEqual(current, {
        kind: 'interface',
        callableName: 'itemsByCategory',
        version: '2.0.0',
        rows: [{ label: 'A', value: 2 }],
      });
      assert.deepEqual(historical, {
        kind: 'interface',
        callableName: 'itemsByCategory',
        version: '1.0.0',
        rows: [{ label: 'A', legacyValue: 2 }],
      });
    });
  });

  it('does not execute a deprecated historical release', async () => {
    await withRuntime(async ({ designer, getEngine }) => {
      await installRelease(designer, {
        status: 'deprecated',
        version: '2.0.0',
        history: [storedRelease('1.0.0', 'deprecated', 'legacyValue')],
      });

      await assert.rejects(
        executePublishedQueryInterface({
          atlas: 'business',
          designerWorkspace: 'designer',
          body: {
            op: 'executeInterface',
            callableName: 'itemsByCategory',
            version: '1.0.0',
            parameters: { category: 'A' },
          },
          getEngine,
        }),
        /INTERFACE_RELEASE_NOT_FOUND:itemsByCategory@1.0.0/,
      );
    });
  });

  it('enforces access keys and disabled policies before query execution', async () => {
    await withRuntime(async ({ designer, getEngine }) => {
      await installRelease(designer, {
        status: 'active',
        permission: {
          mode: 'key',
          accessKeyDigest: queryInterfaceAccessKeyDigest('correct-access-key'),
        },
      });
      const base = {
        atlas: 'business',
        designerWorkspace: 'designer',
        getEngine,
      };
      await assert.rejects(
        executePublishedQueryInterface({
          ...base,
          body: {
            op: 'executeInterface',
            callableName: 'itemsByCategory',
            parameters: { category: 'A' },
          },
        }),
        /INTERFACE_ACCESS_KEY_REQUIRED/,
      );
      await assert.rejects(
        executePublishedQueryInterface({
          ...base,
          body: {
            op: 'executeInterface',
            callableName: 'itemsByCategory',
            accessKey: 'wrong-access-key',
            parameters: { category: 'A' },
          },
        }),
        /INTERFACE_ACCESS_DENIED/,
      );
      const result = await executePublishedQueryInterface({
        ...base,
        body: {
          op: 'executeInterface',
          callableName: 'itemsByCategory',
          accessKey: 'correct-access-key',
          parameters: { category: 'A' },
        },
      });
      assert.equal(result.rows.length, 1);
    });

    await withRuntime(async ({ designer, getEngine }) => {
      await installRelease(designer, {
        status: 'active',
        permission: { mode: 'disabled' },
      });
      await assert.rejects(
        executePublishedQueryInterface({
          atlas: 'business',
          designerWorkspace: 'designer',
          body: {
            op: 'executeInterface',
            callableName: 'itemsByCategory',
            parameters: { category: 'A' },
          },
          getEngine,
        }),
        /INTERFACE_ACCESS_DISABLED/,
      );
    });
  });

  it('rate limits an authenticated release before query execution', async () => {
    await withRuntime(async ({ designer, getEngine }) => {
      await installRelease(designer, {
        status: 'active',
        permission: {
          mode: 'key',
          accessKeyDigest: queryInterfaceAccessKeyDigest('correct-access-key'),
          rateLimit: { maxRequests: 1, windowSeconds: 60 },
        },
      });
      const body = {
        op: 'executeInterface' as const,
        callableName: 'itemsByCategory',
        accessKey: 'correct-access-key',
        parameters: { category: 'A' },
      };
      const first = await executePublishedQueryInterface({
        atlas: 'business',
        designerWorkspace: 'designer',
        body,
        getEngine,
      });
      assert.equal(first.rows.length, 1);
      await assert.rejects(
        executePublishedQueryInterface({
          atlas: 'business',
          designerWorkspace: 'designer',
          body,
          getEngine,
        }),
        /INTERFACE_RATE_LIMITED:60/,
      );
      const auditRows = await designer.persistence
        .getMergedReader()
        .getAll('sys_query_interface_call_log');
      assert.deepEqual(
        auditRows.map((row) => row.error_code),
        ['', 'INTERFACE_RATE_LIMITED'],
      );
    });
  });
});

interface TestPermissionPolicy {
  mode: string;
  accessKeyDigest?: string;
  rateLimit?: { maxRequests: number; windowSeconds: number };
}

async function withRuntime(
  run: (context: {
    business: AuthoringEngine;
    designer: AuthoringEngine;
    getEngine: (atlas: string) => Promise<AuthoringEngine>;
  }) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'modedb-published-interface-'));
  const business = new AuthoringEngine({
    atlas: 'business',
    storageRoot: root,
    connectToken: 'test-token',
  });
  const designer = new AuthoringEngine({
    atlas: 'designer',
    storageRoot: root,
    connectToken: 'test-token',
  });
  try {
    business.registerModel('Item', { category: 'String', score: 'Int' });
    await business.insert('Item', { category: 'A', score: 2 }, { sync: true });
    await business.insert('Item', { category: 'B', score: 5 }, { sync: true });
    designer.registerModel('sys_query_interface', {
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
    rmSync(root, { recursive: true, force: true });
  }
}

async function installRelease(
  designer: AuthoringEngine,
  input: {
    status: 'active' | 'deprecated';
    version?: string;
    history?: readonly Record<string, unknown>[];
    permission?: TestPermissionPolicy;
  },
): Promise<void> {
  await designer.insert(
    'sys_query_interface',
    {
      library_code: 'business',
      release_json: JSON.stringify(
        storedRelease(input.version ?? '1.0.0', input.status, 'value', input.permission),
      ),
      release_history_json: input.history ? JSON.stringify(input.history) : '',
    },
    { sync: true },
  );
}

function storedRelease(
  version: string,
  status: 'active' | 'deprecated',
  valueOutputName: string,
  permission?: TestPermissionPolicy,
): Record<string, unknown> {
  const baseTemplate = structuredClone(template());
  const releaseTemplate = {
    ...baseTemplate,
    resultAdapter:
      baseTemplate.resultAdapter.kind === 'rows'
        ? {
            ...baseTemplate.resultAdapter,
            fieldsByNode: {
              ...baseTemplate.resultAdapter.fieldsByNode,
              node_item: [
                { sourceField: 'category', outputName: 'label' },
                { sourceField: 'score', outputName: valueOutputName },
              ],
            },
          }
        : baseTemplate.resultAdapter,
  };
  return {
    version,
    publishedAt: '2026-07-21T00:00:00.000Z',
    callableName: 'itemsByCategory',
    signature: `test-signature-${version}`,
    queryInterface: {
      status,
      contract: { permissions: permission ?? { mode: 'none' } },
    },
    executionTemplate: releaseTemplate,
  };
}

function template(): PublishedQueryExecutionTemplate {
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
          { sourceField: 'score', outputName: 'value' },
        ],
      },
      edgesBySource: {},
    },
    pagination: { mode: 'none' },
  };
}

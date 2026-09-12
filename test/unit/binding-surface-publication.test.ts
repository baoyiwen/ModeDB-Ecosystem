import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RemoteModelDBClient } from '@mode-db/sdk';
import type { PublishedQueryExecutionTemplate } from '@mode-db/sdk';
import {
  appendBindingSurfaceReleaseHistory,
  bindingSurfacePublicationSignature,
  customerOrdersQueryFixture,
  deprecateBindingSurfaceRelease,
  nextDraftBindingSurface,
  publishBindingSurface,
  publishQueryInterface,
  queryInterfacePublicationSignature,
  type BindingSurface,
  type QueryInterfaceRelease,
} from '../../apps/model-designer/src/query-designer/index.js';
import {
  deleteBindingSurfaceRegistry,
  listBindingSurfaceRegistry,
  summarizeBindingSurfaceAuditRows,
  type BindingSurfaceRegistryRecord,
  upsertBindingSurfaceRegistry,
} from '../../apps/model-designer/src/sync/binding-surface-registry.js';
import {
  ensureDesignerCatalog,
  SYS_BINDING_SURFACE,
  SYS_BINDING_SURFACE_CALL_LOG,
} from '../../apps/model-designer/src/bootstrap/designer-storage-init.js';
import type { EngineModelNode } from '../../apps/model-designer/src/types/engine-schema.js';

const now = '2026-07-22T10:00:00.000Z';

describe('BindingSurface publication', () => {
  it('publishes an immutable contract with pinned query release metadata', () => {
    const queryRelease = publishedQueryRelease();
    const draft = readonlySurface();
    const result = publishBindingSurface({
      bindingSurface: draft,
      signature: bindingSurfacePublicationSignature(draft),
      queryReleases: [queryRelease],
      operationReleases: [],
      now,
    });

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.bindingSurface.status, 'active');
    assert.equal(result.release.version, '0.1.0');
    assert.equal(result.release.contract.query.callableName, 'customerOrders');
    assert.equal(result.release.contract.query.version, queryRelease.version);
    assert.notEqual(result.release.bindingSurface, result.bindingSurface);

    draft.name = 'changedAfterPublication';
    assert.equal(result.release.bindingSurface.name, 'customerOrdersSurface');
  });

  it('archives the previous complete release when publishing a new draft', () => {
    const queryRelease = publishedQueryRelease();
    const first = publishSurface(readonlySurface(), queryRelease, now);
    const draft = nextDraftBindingSurface(
      { ...first.bindingSurface, description: 'Updated binding description.' },
      first.release,
      '2026-07-22T11:00:00.000Z',
    );
    const second = publishBindingSurface({
      bindingSurface: draft,
      signature: bindingSurfacePublicationSignature(draft),
      queryReleases: [queryRelease],
      operationReleases: [],
      existingRelease: first.release,
      now: '2026-07-22T12:00:00.000Z',
    });

    assert.equal(second.ok, true);
    if (!second.ok) {
      return;
    }
    assert.equal(second.release.version, '0.1.1');
    assert.deepEqual(second.bindingSurface.version.history?.map((entry) => entry.version), [
      '0.1.0',
    ]);
    const history = appendBindingSurfaceReleaseHistory(undefined, first.release);
    assert.equal(history[0]?.contract.query.version, queryRelease.version);
  });

  it('rejects unchanged publications and supports non-destructive deprecation', () => {
    const queryRelease = publishedQueryRelease();
    const first = publishSurface(readonlySurface(), queryRelease, now);
    const unchanged = publishBindingSurface({
      bindingSurface: first.bindingSurface,
      signature: bindingSurfacePublicationSignature(first.bindingSurface),
      queryReleases: [queryRelease],
      operationReleases: [],
      existingRelease: first.release,
    });

    assert.equal(unchanged.ok, false);
    if (!unchanged.ok) {
      assert.equal(
        unchanged.issues.some(
          (issue) => issue.code === 'binding_surface_publication_release_unchanged',
        ),
        true,
      );
    }
    const deprecated = deprecateBindingSurfaceRelease(
      first.release,
      '2026-07-22T13:00:00.000Z',
    );
    assert.equal(deprecated.bindingSurface.status, 'deprecated');
    assert.equal(deprecated.contract.query.version, first.release.contract.query.version);
  });
});

describe('BindingSurface registry', () => {
  it('scopes rows by library and updates through the engine storage id', async () => {
    const queryRelease = publishedQueryRelease();
    const published = publishSurface(readonlySurface(), queryRelease, now);
    const record: BindingSurfaceRegistryRecord = {
      id: published.bindingSurface.id,
      storageId: 'engine-row-7',
      name: 'Customer Orders Surface',
      bindingSurface: published.bindingSurface,
      createdAt: now,
      updatedAt: now,
      signature: published.release.signature,
      publishedRelease: published.release,
      releaseHistory: [],
    };
    const fake = new FakeBindingSurfaceClient([
      registryRow(record, 'railway', 'engine-row-7'),
      registryRow({ ...record, id: 'other-surface' }, 'other-library', 'engine-row-8'),
    ]);
    const client = fake as unknown as RemoteModelDBClient;

    const listed = await listBindingSurfaceRegistry(client, 'railway');
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.storageId, 'engine-row-7');
    assert.equal(listed[0]?.publishedRelease?.contract.format, 1);

    const updated = {
      ...listed[0]!,
      name: 'Updated Surface',
      updatedAt: '2026-07-22T14:00:00.000Z',
    };
    await upsertBindingSurfaceRegistry(client, 'railway', updated);
    assert.equal(fake.lastUpdatedId, 'engine-row-7');
    assert.equal(fake.rows.find((row) => row._id === 'engine-row-7')?.display_name, 'Updated Surface');
    assert.equal(fake.rows.length, 2);

    await deleteBindingSurfaceRegistry(client, 'railway', record.id);
    assert.equal(fake.lastDeletedId, 'engine-row-7');
    assert.equal(fake.rows.some((row) => row._id === 'engine-row-7'), false);
    assert.equal(fake.rows.some((row) => row._id === 'engine-row-8'), true);

    await assert.rejects(
      () =>
        upsertBindingSurfaceRegistry(client, 'railway', {
          ...record,
          id: 'mismatched-surface',
        }),
      /BINDING_SURFACE_REGISTRY_ID_MISMATCH/,
    );
    const inserted = {
      ...record,
      id: 'new-surface',
      storageId: undefined,
      bindingSurface: { ...record.bindingSurface, id: 'new-surface' },
    };
    await upsertBindingSurfaceRegistry(client, 'railway', inserted);
    assert.equal(fake.rows.some((row) => row._id === 'new-surface'), true);
  });

  it('summarizes success, refresh failures, errors, trends, and recent calls', () => {
    const summary = summarizeBindingSurfaceAuditRows(
      [
        auditRow('success', '2026-07-22T09:00:00.000Z'),
        auditRow(
          'refresh_failed',
          '2026-07-22T09:05:00.000Z',
          'INTERFACE_RELEASE_NOT_FOUND',
        ),
        auditRow('error', '2026-07-22T09:10:00.000Z', 'INTERFACE_ACCESS_DENIED'),
      ],
      Date.parse('2026-07-22T10:00:00.000Z'),
    ).get('customer-orders');

    assert.equal(summary?.callCount, 3);
    assert.equal(summary?.successCount, 1);
    assert.equal(summary?.refreshFailureCount, 1);
    assert.equal(summary?.errorCount, 1);
    assert.equal(summary?.averageDurationMs, 12);
    assert.equal(summary?.lastErrorCode, 'INTERFACE_ACCESS_DENIED');
    assert.equal(summary?.recentCalls[0]?.status, 'error');
    assert.equal(
      summary?.trend.reduce((total, point) => total + point.callCount, 0),
      3,
    );
  });
});

describe('BindingSurface catalog', () => {
  it('registers the sys_binding_surface persistence schema', async () => {
    const models = new Map<string, Record<string, unknown>>();
    const client = {
      async registerModel(name: string, schema: Record<string, unknown>) {
        models.set(name, schema);
      },
      async registerRelation() {},
      async alterModel() {},
    } as unknown as RemoteModelDBClient;

    await ensureDesignerCatalog(client);

    assert.deepEqual(models.get(SYS_BINDING_SURFACE), {
      library_code: 'String',
      surface_id: 'String',
      display_name: 'String',
      description: 'String',
      surface_json: 'String',
      signature: 'String',
      created_at: 'String',
      updated_at: 'String',
      release_json: 'String',
      release_history_json: 'String',
    });
    assert.deepEqual(models.get(SYS_BINDING_SURFACE_CALL_LOG), {
      library_code: 'String',
      surface_id: 'String',
      requested_version: 'String',
      resolved_version: 'String',
      action: 'String',
      mutation_id: 'String',
      status: 'String',
      error_code: 'String',
      started_at: 'String',
      duration_ms: 'Number',
      parameter_count: 'Int',
      row_count: 'Int',
    });
  });
});

function auditRow(
  status: string,
  startedAt: string,
  errorCode = '',
): Record<string, unknown> {
  return {
    library_code: 'railway',
    surface_id: 'customer-orders',
    requested_version: '1.0.0',
    resolved_version: status === 'error' ? '' : '1.0.0',
    action: status === 'success' ? 'read' : 'mutate',
    mutation_id: status === 'success' ? '' : 'update-status',
    status,
    error_code: errorCode,
    started_at: startedAt,
    duration_ms: 12,
    parameter_count: 1,
    row_count: status === 'success' ? 2 : 0,
  };
}

class FakeBindingSurfaceClient {
  readonly rows: Record<string, unknown>[];
  lastUpdatedId: string | undefined;
  lastDeletedId: string | undefined;

  constructor(rows: Record<string, unknown>[]) {
    this.rows = rows;
  }

  model(name: string) {
    assert.equal(name, 'sys_binding_surface');
    return {
      query: () => ({
        execute: async () => this.rows.map((data) => fakeRow(data)),
      }),
      insertMany: async (rows: readonly Record<string, unknown>[]) => {
        this.rows.push(...rows.map((row) => ({ ...row })));
        return { failureCount: 0 };
      },
    };
  }

  async batchUpdate(
    updates: readonly { id: string; partial: Readonly<Record<string, unknown>> }[],
  ) {
    const update = updates[0]!;
    this.lastUpdatedId = update.id;
    const index = this.rows.findIndex((row) => row._id === update.id);
    this.rows[index] = { ...this.rows[index], ...update.partial };
    return { failureCount: 0 };
  }

  async batchDelete(deletes: readonly { id: string }[]) {
    const deletion = deletes[0]!;
    this.lastDeletedId = deletion.id;
    const index = this.rows.findIndex((row) => row._id === deletion.id);
    this.rows.splice(index, 1);
    return { failureCount: 0 };
  }
}

function fakeRow(data: Record<string, unknown>): {
  id: string;
  getData(): Record<string, unknown>;
} {
  return {
    id: String(data._id ?? ''),
    getData: () => ({ ...data }),
  };
}

function registryRow(
  record: BindingSurfaceRegistryRecord,
  libraryCode: string,
  storageId: string,
): Record<string, unknown> {
  return {
    _id: storageId,
    library_code: libraryCode,
    surface_id: record.id,
    display_name: record.name,
    description: record.bindingSurface.description ?? '',
    surface_json: JSON.stringify(record.bindingSurface),
    signature: record.signature ?? '',
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    release_json: record.publishedRelease ? JSON.stringify(record.publishedRelease) : '',
    release_history_json: JSON.stringify(record.releaseHistory ?? []),
  };
}

function readonlySurface(): BindingSurface {
  return {
    id: 'binding_customer_orders',
    kind: 'binding',
    name: 'customerOrdersSurface',
    displayName: 'Customer Orders Surface',
    status: 'draft',
    version: { current: '0.1.0', compatibility: 'draft' },
    parameters: [
      {
        id: 'surface_status',
        name: 'status',
        type: 'string',
        required: false,
      },
    ],
    query: {
      interfaceId: 'query_customer_orders',
      version: '0.1.0',
      parameterBindings: [
        {
          parameterId: 'param_status',
          source: { kind: 'surfaceParameter', parameterId: 'surface_status' },
        },
      ],
    },
    writeback: { mode: 'readonly', mutations: [], refresh: 'manual' },
    lifecycle: { createdAt: now, updatedAt: now },
  };
}

function publishSurface(
  surface: BindingSurface,
  queryRelease: QueryInterfaceRelease,
  publishedAt: string,
): Extract<ReturnType<typeof publishBindingSurface>, { ok: true }> {
  const result = publishBindingSurface({
    bindingSurface: surface,
    signature: bindingSurfacePublicationSignature(surface),
    queryReleases: [queryRelease],
    operationReleases: [],
    now: publishedAt,
  });
  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error('Expected BindingSurface publication to succeed.');
  }
  return result;
}

function publishedQueryRelease(): QueryInterfaceRelease {
  const draft = structuredClone(customerOrdersQueryFixture);
  const result = publishQueryInterface({
    queryInterface: draft,
    signature: queryInterfacePublicationSignature(draft),
    executionTemplate: queryTemplate(),
    models: [
      model('Customer', 'Customer', [field('name', 'name')]),
      model('Order', 'Order', [field('status', 'status')]),
    ],
    now,
  });
  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error('Expected QueryInterface publication to succeed.');
  }
  return result.release;
}

function queryTemplate(): PublishedQueryExecutionTemplate {
  return {
    format: 1,
    snapshot: {
      plan: {
        version: 2,
        originModel: 'Customer',
        start: { kind: 'all' },
        hops: [],
        trailing: { type: 'group', logic: 'AND', children: [] },
      },
      execute: {},
      analysis: { groupBy: null, compute: null },
    },
    parameters: [],
    resultAdapter: { kind: 'rows', rootNodeId: 'node_customer', fieldsByNode: {}, edgesBySource: {} },
    pagination: { mode: 'none' },
  };
}

function model(
  id: string,
  name: string,
  props: EngineModelNode['props_objects_array'],
): EngineModelNode {
  return { id, model_name: name, parent_id: null, props_objects_array: props };
}

function field(id: string, name: string): EngineModelNode['props_objects_array'][number] {
  return { id, name, type: 'string', is_primary: false, encrypt_level: 0, metadata: {} };
}

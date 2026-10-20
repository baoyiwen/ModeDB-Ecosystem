import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TransferError, type TransferModel } from '@mode-db/data-kit';
import {
  invokeInterfacePivot,
  queryModelPivot,
  type PivotInterfaceClient,
  type PivotModelQueryClient,
} from '../../apps/model-designer/src/pivot/index.js';

const unfilteredQuery = {
  is() { throw new Error('Unexpected filter'); },
  contains() { throw new Error('Unexpected filter'); },
  gt() { throw new Error('Unexpected filter'); },
  lt() { throw new Error('Unexpected filter'); },
};

describe('Pivot source adapters', () => {
  it('normalizes model rows and relation payloads from a paginated query', async () => {
    let receivedOptions: Record<string, unknown> | undefined;
    const client: PivotModelQueryClient = {
      model() {
        return {
          query() {
            return {
              ...unfilteredQuery,
              async execute(options) {
                receivedOptions = options as Record<string, unknown>;
                return {
                  items: [
                    {
                      getData: () => ({
                        _id: 'route-1',
                        relates: { stations: [{ _id: 'station-1', name: 'North' }] },
                      }),
                    },
                  ],
                  total: 8,
                  page: 1,
                  pageCount: 4,
                };
              },
            };
          },
        };
      },
    };

    const document = await queryModelPivot({
      client,
      source: { kind: 'model', modelId: 'route', modelName: 'Route' },
      page: 1,
      limit: 2,
    });

    assert.equal(receivedOptions?.includeRelates, true);
    assert.equal(receivedOptions?.page, 1);
    assert.equal(receivedOptions?.limit, 2);
    assert.equal(document.page.mode, 'offset');
    assert.equal(document.page.total, 8);
    assert.equal(document.rows[0]?.raw._id, 'route-1');
  });

  it('passes interface parameters and preserves cursor metadata', async () => {
    let received: { name: string; options?: Record<string, unknown> } | undefined;
    const client: PivotInterfaceClient = {
      async invokeQueryInterface(name, options) {
        received = { name, options: options as Record<string, unknown> };
        return {
          kind: 'interface',
          callableName: name,
          version: '2.0.0',
          rows: [{ code: 'R1', stations: [{ name: 'North' }] }],
          total: 12,
          page: 0,
          pageCount: 3,
          nextCursor: 'cursor-2',
        };
      },
    };

    const document = await invokeInterfacePivot({
      client,
      source: {
        kind: 'interface',
        callableName: 'routes',
        version: '2.0.0',
      },
      parameters: { status: 'active' },
      accessKey: 'fixture-key',
      cursor: 'cursor-1',
      limit: 5,
    });

    assert.equal(received?.name, 'routes');
    assert.deepEqual(received?.options?.parameters, { status: 'active' });
    assert.equal(received?.options?.version, '2.0.0');
    assert.equal(received?.options?.accessKey, 'fixture-key');
    assert.equal(received?.options?.cursor, 'cursor-1');
    assert.equal(document.page.mode, 'cursor');
    assert.equal(document.page.nextCursor, 'cursor-2');
    assert.equal(document.rows[0]?.root.children[1]?.kind, 'array');
  });

  it('filters model metadata and undeclared fields while retaining relation properties', async () => {
    const client: PivotModelQueryClient = {
      model() {
        return {
          query() {
            return {
              ...unfilteredQuery,
              async execute() {
                return [
                  {
                    getData: () => ({
                      _id: 'route-1',
                      name: 'Route A',
                      hidden_debug: 'secret',
                      relates: {
                        stations: [
                          { _id: 'station-1', name: 'North', hidden_debug: 'secret-child' },
                        ],
                      },
                    }),
                  },
                ];
              },
            };
          },
        };
      },
    };

    const document = await queryModelPivot({
      client,
      source: { kind: 'model', modelId: 'route', modelName: 'Route' },
      fieldPolicy: { fields: ['name'], relatedFields: { stations: ['name'] } },
    });

    assert.deepEqual(document.rawRows, [
      { name: 'Route A', relates: { stations: [{ name: 'North' }] } },
    ]);
  });

  it('applies typed AND conditions to the database query before normalizing the preview', async () => {
    const calls: unknown[][] = [];
    const query = {
      is: (field: string, value: unknown) => calls.push(['eq', field, value]),
      contains: (field: string, value: string) => calls.push(['contains', field, value]),
      gt: (field: string, value: unknown) => calls.push(['gt', field, value]),
      lt: (field: string, value: unknown) => calls.push(['lt', field, value]),
      execute: async () => { calls.push(['execute']); return [{ count: 8, code: 'R-A', active: false }]; },
    };
    const model: TransferModel = { name: 'Route', label: 'Route', sheet: 'Route', fields: [
      { name: 'count', label: 'Count', type: 'Int' },
      { name: 'code', label: 'Code', type: 'String' },
      { name: 'active', label: 'Active', type: 'Boolean' },
    ] };
    const client = { model: () => ({ query: () => query }) };
    const source = { kind: 'model' as const, modelName: 'Route' };
    const document = await queryModelPivot({ client, source, filter: { model, conditions: [
      { field: 'count', op: 'gt', value: '5' },
      { field: 'count', op: 'lt', value: '10' },
      { field: 'code', op: 'contains', value: 'R-' },
      { field: 'active', op: 'eq', value: 'false' },
    ] } });
    assert.deepEqual(calls, [['gt', 'count', 5], ['lt', 'count', 10], ['contains', 'code', 'R-'], ['eq', 'active', false], ['execute']]);
    assert.equal(document.rawRows[0]?.count, 8);
    calls.length = 0;
    for (const conditions of [
      [{ field: 'count', op: 'eq' as const, value: '' }],
      [{ field: 'count', op: 'eq' as const, value: '1.5' }],
      [{ field: 'code', op: 'contains' as const, value: 'R-' }, { field: '_id', op: 'eq' as const, value: 'secret' }],
    ]) {
      await assert.rejects(queryModelPivot({ client, source, filter: { model, conditions } }), (error: unknown) => error instanceof TransferError && error.code === 'filter');
    }
    await assert.rejects(queryModelPivot({ client, source: { kind: 'model', modelName: 'Other' }, filter: { model, conditions: [] } }), (error: unknown) => error instanceof TransferError && error.code === 'filter');
    assert.deepEqual(calls, [], 'invalid forms must neither mutate nor execute a query');
  });
});

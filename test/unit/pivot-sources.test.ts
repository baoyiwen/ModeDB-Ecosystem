import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  invokeInterfacePivot,
  queryModelPivot,
  type PivotInterfaceClient,
  type PivotModelQueryClient,
} from '../../apps/model-designer/src/pivot/index.js';

describe('Pivot source adapters', () => {
  it('normalizes model rows and relation payloads from a paginated query', async () => {
    let receivedOptions: Record<string, unknown> | undefined;
    const client: PivotModelQueryClient = {
      model() {
        return {
          query() {
            return {
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
      cursor: 'cursor-1',
      limit: 5,
    });

    assert.equal(received?.name, 'routes');
    assert.deepEqual(received?.options?.parameters, { status: 'active' });
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
});

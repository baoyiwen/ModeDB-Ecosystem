import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { adaptQueryResult, isPivotLeafEditable } from '@mode-db/data-kit';

describe('adaptQueryResult', () => {
  it('maps rows to tabular ViewDataShape with row refs', () => {
    const shape = adaptQueryResult(
      {
        kind: 'rows',
        rows: [
          { model: 'Country', data: { _id: 'jp', name: 'Japan' } },
          { model: 'Country', data: { _id: 'us', name: 'USA' } },
        ],
      },
      { sourceModel: 'Country' },
    );
    assert.equal(shape.kind, 'tabular');
    if (shape.kind !== 'tabular') {
      return;
    }
    assert.equal(shape.rows.length, 2);
    assert.deepEqual(shape.rowRefs?.[0], { model: 'Country', id: 'jp' });
  });

  it('maps nested relates to tree ViewDataShape', () => {
    const shape = adaptQueryResult({
      kind: 'rows',
      rows: [
        {
          model: 'Region',
          data: { _id: 'r1', name: 'East' },
          relates: {
            hasCities: [
              {
                model: 'City',
                data: { _id: 'c1', name: 'Tokyo' },
              },
            ],
          },
        },
      ],
    });
    assert.equal(shape.kind, 'tree');
    if (shape.kind !== 'tree') {
      return;
    }
    assert.equal(shape.treeKind, 'entity');
    assert.equal(shape.roots.length, 1);
    assert.equal(shape.roots[0]?.children.length, 1);
    assert.equal(shape.roots[0]?.children[0]?.relationKey, 'hasCities');
  });

  it('maps analysis to pivot with metrics read-only until leaf grain', () => {
    const agg = adaptQueryResult(
      {
        kind: 'analysis',
        dimensionKeys: ['year'],
        shape: 'flat',
        rows: [{ year: 2020, population: 100 }],
      },
      { preferAnalysisTree: false },
    );
    assert.equal(agg.kind, 'pivot');
    if (agg.kind !== 'pivot') {
      return;
    }
    assert.equal(agg.isLeafGrain, false);
    assert.equal(isPivotLeafEditable(agg), false);
    const metricCol = agg.columns.find((c) => c.key === 'population');
    assert.equal(metricCol?.readOnly, true);
  });

  it('prefers analysis tree when wire includes nested tree payload', () => {
    const shape = adaptQueryResult({
      kind: 'analysis',
      dimensionKeys: ['year', 'country'],
      shape: 'tree',
      rows: [{ year: 2020, country: 'JP', count: 3 }],
      tree: {
        '2020': {
          JP: { count: 3 },
        },
      },
    });
    assert.equal(shape.kind, 'tree');
    if (shape.kind !== 'tree') {
      return;
    }
    assert.equal(shape.treeKind, 'analysis');
    assert.equal(shape.roots.length, 1);
    assert.equal(shape.roots[0]?.label, '2020');
    assert.equal(shape.roots[0]?.children[0]?.label, 'JP');
  });

  it('allows leaf pivot editing when pivotLeafGrain is set', () => {
    const leaf = adaptQueryResult(
      {
        kind: 'analysis',
        dimensionKeys: ['year'],
        shape: 'flat',
        rows: [{ year: 2020, _id: 'r1', name: 'Tokyo' }],
      },
      { pivotLeafGrain: true, preferAnalysisTree: false },
    );
    assert.equal(leaf.kind, 'pivot');
    if (leaf.kind !== 'pivot') {
      return;
    }
    assert.equal(isPivotLeafEditable(leaf), true);
  });

  it('maps groups wire payload to grouped ViewDataShape', () => {
    const shape = adaptQueryResult({
      kind: 'groups',
      dimensionKeys: ['year'],
      groups: [
        {
          dimensionValues: [2020],
          aggregates: { year: 2020, count: 2 },
          members: [
            { model: 'City', data: { _id: 'c1', name: 'Tokyo' } },
            { model: 'City', data: { _id: 'c2', name: 'Osaka' } },
          ],
        },
      ],
    });
    assert.equal(shape.kind, 'grouped');
    if (shape.kind !== 'grouped') {
      return;
    }
    assert.equal(shape.groups.length, 1);
    assert.equal(shape.groups[0]?.members.length, 2);
  });

  it('filters tabular columns to schema prop fields', () => {
    const shape = adaptQueryResult(
      {
        kind: 'rows',
        rows: [
          {
            model: 'Country',
            data: { _id: 'jp', name: 'Japan', _rev: 1, extra: 'x' },
          },
        ],
      },
      { sourceModel: 'Country', propFields: ['name'] },
    );
    assert.equal(shape.kind, 'tabular');
    if (shape.kind !== 'tabular') {
      return;
    }
    assert.deepEqual(
      shape.columns.map((c) => c.key),
      ['name'],
    );
  });

  it('adapts binding surface query rows and keeps record refs out of visible data', () => {
    const shape = adaptQueryResult({
      kind: 'bindingSurface',
      surfaceId: 'item-editor',
      version: '1.0.0',
      action: 'read',
      status: 'success',
      query: {
        kind: 'interface',
        callableName: 'itemsByCategory',
        version: '1.0.0',
        rows: [
          {
            $recordRef: { nodeId: 'node_item', model: 'Item', id: 'item-1' },
            label: 'First',
          },
        ],
      },
    });
    assert.equal(shape.kind, 'tabular');
    if (shape.kind !== 'tabular') {
      return;
    }
    assert.deepEqual(shape.columns.map((column) => column.key), ['label']);
    assert.deepEqual(shape.rows, [{ label: 'First' }]);
    assert.deepEqual(shape.rowRefs, [{ model: 'Item', id: 'item-1' }]);
  });

  it('returns an empty shape for a mutation-only binding surface result', () => {
    const shape = adaptQueryResult({
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
    });
    assert.deepEqual(shape, {
      kind: 'empty',
      reason: 'binding_surface_result_not_viewable',
    });
  });
});

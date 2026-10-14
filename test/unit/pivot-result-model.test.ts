import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  collectPivotLeafNodes,
  normalizePivotResult,
} from '../../apps/model-designer/src/pivot/index.js';

describe('Pivot result model', () => {
  it('normalizes nested objects and arrays while preserving raw rows', () => {
    const raw = {
      name: 'Route A',
      stations: [{ name: 'North', platforms: [{ code: 'N1' }] }],
    };
    const document = normalizePivotResult({
      source: { kind: 'model', modelId: 'route', modelName: 'Route' },
      rows: [raw],
    });

    assert.equal(document.rows.length, 1);
    assert.strictEqual(document.rawRows[0], raw);
    assert.equal(document.rows[0]?.root.kind, 'record');
    const stations = document.rows[0]?.root.children.find((node) => node.key === 'stations');
    assert.equal(stations?.kind, 'array');
    assert.equal(stations?.children[0]?.kind, 'object');
    assert.equal(stations?.children[0]?.children[1]?.key, 'platforms');
    assert.equal(stations?.children[0]?.children[1]?.children[0]?.children[0]?.value, 'N1');
  });

  it('creates stable path-based node IDs and leaf values', () => {
    const input = {
      status: 'active',
      metrics: { count: 3 },
    };
    const document = normalizePivotResult({
      source: {
        kind: 'interface',
        callableName: 'routes',
        version: '1.0.0',
      },
      rows: [input],
      page: { mode: 'cursor', nextCursor: 'next-1' },
    });
    const row = document.rows[0]!;
    const leaves = collectPivotLeafNodes(row);

    assert.equal(document.page.mode, 'cursor');
    assert.equal(document.page.nextCursor, 'next-1');
    assert.deepEqual(
      leaves.map((node) => node.value),
      ['active', 3],
    );
    assert.equal(leaves[1]?.id, 'row:0:[{"key":"metrics","kind":"field"},{"key":"count","kind":"field"}]');
  });

  it('keeps null, undefined, and empty arrays as inspectable values', () => {
    const document = normalizePivotResult({
      source: { kind: 'model', modelId: 'item', modelName: 'Item' },
      rows: [{ missing: undefined, empty: [], nullable: null }],
    });
    const children = document.rows[0]!.root.children;

    assert.equal(children.find((node) => node.key === 'missing')?.value, undefined);
    assert.equal(children.find((node) => node.key === 'nullable')?.value, null);
    assert.equal(children.find((node) => node.key === 'empty')?.kind, 'array');
    assert.equal(children.find((node) => node.key === 'empty')?.children.length, 0);
  });
});

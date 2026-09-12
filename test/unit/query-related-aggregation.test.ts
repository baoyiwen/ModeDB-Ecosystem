import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ModelRegistry,
  type DataReader,
  type IndexReader,
  type ModelRecord,
} from '@mode-db/common';
import { AnalysisResult, QueryChain, type HydratedEntity } from '@mode-db/core';

const parents: ModelRecord[] = [
  { _id: 'p1', _createdAt: '2026-07-21T00:00:00.000Z', name: 'First' },
  { _id: 'p2', _createdAt: '2026-07-21T00:00:00.000Z', name: 'Second' },
];
const orders: ModelRecord[] = [
  { _id: 'o1', _createdAt: '2026-07-21T00:00:00.000Z', category: 'X', amount: 2 },
  { _id: 'o2', _createdAt: '2026-07-21T00:00:00.000Z', category: 'X', amount: 3 },
  { _id: 'o3', _createdAt: '2026-07-21T00:00:00.000Z', category: 'Y', amount: 10 },
];

const links = new Map([
  ['p1', ['o1', 'o2']],
  ['p2', ['o3']],
]);

const registry = new ModelRegistry();
registry.registerModel('Parent', new Set(['name']));
registry.registerModel('Order', new Set(['category', 'amount']));
registry.registerRelation('Parent', 'Order', 'orders', 'parent', 'one-to-many');

const dataReader: DataReader = {
  async getByIds(modelName, ids) {
    const rows = modelName === 'Parent' ? parents : orders;
    return rows.filter((row) => ids.includes(row._id));
  },
  async getAll(modelName) {
    return [...(modelName === 'Parent' ? parents : orders)];
  },
  async findFirstByFieldEq(modelName, field, value) {
    const rows = modelName === 'Parent' ? parents : orders;
    return rows.find((row) => row[field] === value);
  },
};

const indexReader: IndexReader = {
  async getForward(_relation, sourceId) {
    return links.get(sourceId) ?? [];
  },
  async getReverse(_relation, targetId) {
    return [...links.entries()]
      .filter(([, targetIds]) => targetIds.includes(targetId))
      .map(([sourceId]) => sourceId);
  },
};

describe('QueryChain related-node aggregation', () => {
  it('sorts row results by fields from the primary traversal terminal model', async () => {
    const result = (await new QueryChain(
      registry,
      indexReader,
      dataReader,
      'Parent',
      { kind: 'all' },
    )
      .relate('orders')
      .orderBy('amount', 'desc')
      .execute()) as HydratedEntity[];

    assert.deepEqual(
      result.map((row) => row.getData().amount),
      [10, 3, 2],
    );
  });

  it('aggregates records at the primary traversal terminal model', async () => {
    const result = (await new QueryChain(
      registry,
      indexReader,
      dataReader,
      'Parent',
      { kind: 'all' },
    )
      .relate('orders')
      .groupBy(['category'])
      .compute({ amount: 'sum' })
      .orderBy('category', 'asc')
      .execute()) as AnalysisResult;

    assert.deepEqual(result.asFlatTable(), [
      { category: 'X', amount: 5 },
      { category: 'Y', amount: 10 },
    ]);
  });
});

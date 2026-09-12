import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ModelRegistry,
  type DataReader,
  type IndexReader,
  type ModelRecord,
} from '@mode-db/common';
import { AnalysisResult, QueryChain } from '@mode-db/core';
import { WireQueryChain } from '@mode-db/shared';

const rows: ModelRecord[] = [
  { _id: 'a1', _createdAt: '2026-07-21T00:00:00.000Z', group: 'A', category: 'x', score: 2 },
  { _id: 'a2', _createdAt: '2026-07-21T00:00:00.000Z', group: 'A', category: 'x', score: 2 },
  { _id: 'a3', _createdAt: '2026-07-21T00:00:00.000Z', group: 'A', category: 'y', score: 3 },
  { _id: 'a4', _createdAt: '2026-07-21T00:00:00.000Z', group: 'A', category: null, score: null },
  { _id: 'b1', _createdAt: '2026-07-21T00:00:00.000Z', group: 'B', category: 'z', score: 5 },
  { _id: 'b2', _createdAt: '2026-07-21T00:00:00.000Z', group: 'B', category: 'z', score: 5 },
];

const dataReader: DataReader = {
  async getByIds(_modelName, ids) {
    return rows.filter((row) => ids.includes(row._id));
  },
  async getAll() {
    return [...rows];
  },
  async findFirstByFieldEq(_modelName, field, value) {
    return rows.find((row) => row[field] === value);
  },
};

const indexReader: IndexReader = {
  async getForward() {
    return [];
  },
  async getReverse() {
    return [];
  },
};

function createRegistry(): ModelRegistry {
  const registry = new ModelRegistry();
  registry.registerModel('Item', new Set(['group', 'category', 'score']));
  return registry;
}

function createChain(): QueryChain<Record<string, unknown>> {
  return new QueryChain(createRegistry(), indexReader, dataReader, 'Item', { kind: 'all' });
}

describe('QueryChain distinct aggregation', () => {
  it('computes distinct counts and numeric metrics per bucket', async () => {
    const result = (await createChain()
      .groupBy(['group'])
      .compute({
        category: 'countDistinct',
        score: ['sumDistinct', 'avgDistinct', 'minDistinct', 'maxDistinct', 'countDistinct'],
      })
      .orderBy('group', 'asc')
      .execute()) as AnalysisResult;

    assert.deepEqual(result.asFlatTable(), [
      {
        group: 'A',
        category: 2,
        sumDistinct_score: 5,
        avgDistinct_score: 2.5,
        minDistinct_score: 2,
        maxDistinct_score: 3,
        countDistinct_score: 2,
      },
      {
        group: 'B',
        category: 1,
        sumDistinct_score: 5,
        avgDistinct_score: 5,
        minDistinct_score: 5,
        maxDistinct_score: 5,
        countDistinct_score: 1,
      },
    ]);
  });

  it('serializes distinct metrics with protocol version 6', () => {
    const snapshot = new WireQueryChain('Item', { kind: 'all' })
      .groupBy(['group'])
      .compute({ category: 'countDistinct' })
      .getRemoteExecuteSnapshot();

    assert.equal(snapshot.plan.version, 6);
    assert.deepEqual(snapshot.analysis.compute, { category: 'countDistinct' });
  });

  it('rejects distinct metrics attached to a legacy protocol plan', () => {
    const chain = QueryChain.fromWirePlan(createRegistry(), indexReader, dataReader, {
      version: 5,
      originModel: 'Item',
      start: { kind: 'all' },
      hops: [],
      trailing: { type: 'group', logic: 'AND', children: [] },
    });
    assert.throws(
      () =>
        QueryChain.applyRemoteAnalysisSnapshot(
          chain,
          { groupBy: ['group'], compute: { category: 'countDistinct' } },
          { page: 0 },
        ),
      /version 6/,
    );
  });
});

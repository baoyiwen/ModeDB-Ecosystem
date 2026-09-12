import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  ModelRegistry,
  type DataReader,
  type IndexReader,
  type ModelRecord,
} from '@mode-db/common';
import {
  AnalysisResult,
  AuthoringEngine,
  QueryChain,
  executeDatabaseOperation,
  type HydratedEntity,
  type Paginated,
} from '@mode-db/core';
import { WireQueryChain } from '@mode-db/shared';

const rows: ModelRecord[] = [
  { _id: 'a', _createdAt: '2026-07-20T00:00:00.000Z', group: 'A', score: 2 },
  { _id: 'b', _createdAt: '2026-07-20T00:00:00.000Z', group: 'B', score: 10 },
  { _id: 'c', _createdAt: '2026-07-20T00:00:00.000Z', group: 'A', score: 1 },
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

function createChain(): QueryChain<Record<string, unknown>> {
  return new QueryChain(createRegistry(), indexReader, dataReader, 'Item', { kind: 'all' });
}

function createRegistry(): ModelRegistry {
  const registry = new ModelRegistry();
  registry.registerModel('Item', new Set(['group', 'score']));
  return registry;
}

describe('QueryChain ordering', () => {
  it('sorts rows before pagination and serializes the order into snapshots', async () => {
    const chain = createChain().orderBy('score', 'desc').limit(2);
    const snapshot = chain.getRemoteExecuteSnapshot();
    assert.equal(snapshot.plan.version, 3);
    assert.deepEqual(snapshot.execute.orderBy, [{ field: 'score', direction: 'desc' }]);

    const result = (await chain.execute()) as Paginated<HydratedEntity[]>;
    assert.equal(result.total, 3);
    assert.deepEqual(
      result.items.map((row) => row.getData().score),
      [10, 2],
    );
  });

  it('sorts aggregation buckets by metric values', async () => {
    const result = (await createChain()
      .groupBy(['group'])
      .compute({ score: 'sum' })
      .orderBy('score', 'desc')
      .execute()) as AnalysisResult;

    assert.deepEqual(
      result.asFlatTable().map((row) => [row.group, row.score]),
      [
        ['B', 10],
        ['A', 3],
      ],
    );
  });

  it('preserves ordering through the database operation wire result', async () => {
    const root = mkdtempSync(join(tmpdir(), 'modedb-query-order-'));
    const engine = new AuthoringEngine({
      atlas: 'query-order',
      storageRoot: root,
      connectToken: 'test-token',
    });
    try {
      engine.registerModel('Item', { name: 'String', score: 'Int' });
      await engine.insert('Item', { name: 'low', score: 1 }, { sync: true });
      await engine.insert('Item', { name: 'high', score: 9 }, { sync: true });
      await engine.insert('Item', { name: 'middle', score: 5 }, { sync: true });
      const snapshot = new WireQueryChain('Item', { kind: 'all' })
        .orderBy('score', 'desc')
        .getRemoteExecuteSnapshot({ limit: 2 });

      const result = await executeDatabaseOperation(
        { runtime: engine.createRuntime(), atlas: 'query-order' },
        { op: 'executeQuery', snapshot },
      );

      assert.equal(result.kind, 'paginated');
      if (result.kind !== 'paginated' || result.items.kind !== 'rows') {
        return;
      }
      assert.equal(result.total, 3);
      assert.deepEqual(
        result.items.rows.map((row) => row.data.score),
        [9, 5],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects malformed remote ordering entries', () => {
    const chain = createChain();
    assert.throws(
      () =>
        QueryChain.applyRemoteAnalysisSnapshot(
          chain,
          { groupBy: null, compute: null },
          {
            page: 0,
            orderBy: [{ field: 'score', direction: 'sideways' as 'asc' }],
          },
        ),
      /asc\/desc direction/,
    );
  });

  it('rejects ordering attached to a legacy version 2 plan', () => {
    const chain = QueryChain.fromWirePlan(createRegistry(), indexReader, dataReader, {
      version: 2,
      originModel: 'Item',
      start: { kind: 'all' },
      hops: [],
      trailing: { type: 'group', logic: 'AND', children: [] },
    });
    assert.throws(
      () =>
        QueryChain.applyRemoteAnalysisSnapshot(
          chain,
          { groupBy: null, compute: null },
          { page: 0, orderBy: [{ field: 'score', direction: 'desc' }] },
        ),
      /version 3/,
    );
  });
});

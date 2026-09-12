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
  type Paginated,
  type PredicateNode,
} from '@mode-db/core';
import { WireQueryChain } from '@mode-db/shared';

const rows: ModelRecord[] = [
  { _id: 'a1', _createdAt: '2026-07-21T00:00:00.000Z', group: 'A', score: 2 },
  { _id: 'a2', _createdAt: '2026-07-21T00:00:00.000Z', group: 'A', score: 1 },
  { _id: 'b1', _createdAt: '2026-07-21T00:00:00.000Z', group: 'B', score: 10 },
  { _id: 'c1', _createdAt: '2026-07-21T00:00:00.000Z', group: 'C', score: 6 },
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
  registry.registerModel('Item', new Set(['group', 'score']));
  return registry;
}

function createChain(): QueryChain<Record<string, unknown>> {
  return new QueryChain(createRegistry(), indexReader, dataReader, 'Item', { kind: 'all' });
}

describe('QueryChain HAVING', () => {
  it('filters aggregate buckets before sorting and pagination', async () => {
    const result = (await createChain()
      .groupBy(['group'])
      .compute({ score: 'sum' })
      .having({ type: 'atom', field: 'score', op: 'gt', value: 4 })
      .orderBy('score', 'desc')
      .limit(1)
      .execute()) as Paginated<AnalysisResult>;

    assert.equal(result.total, 2);
    assert.deepEqual(result.items.asFlatTable(), [{ group: 'B', score: 10 }]);
  });

  it('preserves nested AND/OR semantics', async () => {
    const having: PredicateNode = {
      type: 'group',
      logic: 'AND',
      children: [
        { type: 'atom', field: 'score', op: 'gte', value: 3 },
        {
          type: 'group',
          logic: 'OR',
          children: [
            { type: 'atom', field: 'score', op: 'lt', value: 5 },
            { type: 'atom', field: 'score', op: 'gt', value: 9 },
          ],
        },
      ],
    };
    const result = (await createChain()
      .groupBy(['group'])
      .compute({ score: 'sum' })
      .having(having)
      .orderBy('group', 'asc')
      .execute()) as AnalysisResult;

    assert.deepEqual(
      result.asFlatTable().map((row) => row.group),
      ['A', 'B'],
    );
  });

  it('serializes HAVING with protocol version 5', () => {
    const snapshot = new WireQueryChain('Item', { kind: 'all' })
      .groupBy(['group'])
      .compute({ score: 'sum' })
      .having({ type: 'atom', field: 'score', op: 'gt', value: 4 })
      .getRemoteExecuteSnapshot();

    assert.equal(snapshot.plan.version, 5);
    assert.deepEqual(snapshot.analysis.having, {
      type: 'atom',
      field: 'score',
      op: 'gt',
      value: 4,
    });
  });

  it('replays HAVING through the executeQuery wire operation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'modedb-query-having-'));
    const engine = new AuthoringEngine({
      atlas: 'query-having',
      storageRoot: root,
      connectToken: 'test-token',
    });
    try {
      engine.registerModel('Item', { group: 'String', score: 'Int' });
      await engine.insert('Item', { group: 'A', score: 2 }, { sync: true });
      await engine.insert('Item', { group: 'A', score: 1 }, { sync: true });
      await engine.insert('Item', { group: 'B', score: 10 }, { sync: true });
      const snapshot = new WireQueryChain('Item', { kind: 'all' })
        .groupBy(['group'])
        .compute({ score: 'sum' })
        .having({ type: 'atom', field: 'score', op: 'gt', value: 4 })
        .getRemoteExecuteSnapshot();

      const result = await executeDatabaseOperation(
        { runtime: engine.createRuntime(), atlas: 'query-having' },
        { op: 'executeQuery', snapshot },
      );

      assert.equal(result.kind, 'analysis');
      if (result.kind !== 'analysis') {
        return;
      }
      assert.deepEqual(result.rows, [{ group: 'B', score: 10 }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects HAVING attached to a legacy protocol plan', () => {
    const chain = QueryChain.fromWirePlan(createRegistry(), indexReader, dataReader, {
      version: 4,
      originModel: 'Item',
      start: { kind: 'all' },
      hops: [],
      trailing: { type: 'group', logic: 'AND', children: [] },
    });
    assert.throws(
      () =>
        QueryChain.applyRemoteAnalysisSnapshot(
          chain,
          {
            groupBy: ['group'],
            compute: { score: 'sum' },
            having: { type: 'atom', field: 'score', op: 'gt', value: 4 },
          },
          { page: 0 },
        ),
      /version 5/,
    );
  });

  it('rejects HAVING without an aggregation dimension', () => {
    assert.throws(
      () =>
        new WireQueryChain('Item', { kind: 'all' })
          .having({ type: 'atom', field: 'score', op: 'gt', value: 4 })
          .getRemoteExecuteSnapshot(),
      /requires groupBy/,
    );
  });
});

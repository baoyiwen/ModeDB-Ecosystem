import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ModelRegistry,
  type DataReader,
  type IndexReader,
  type ModelRecord,
} from '@mode-db/common';
import {
  AnalysisResult,
  QueryChain,
  serializeExecuteResultForWire,
  type HydratedEntity,
  type Paginated,
} from '@mode-db/core';
import { WireQueryChain } from '@mode-db/shared';

const initialRows: ModelRecord[] = [
  { _id: 'a', _createdAt: '2026-07-21T00:00:00.000Z', group: 'A', score: 2 },
  { _id: 'b', _createdAt: '2026-07-21T00:00:00.000Z', group: 'B', score: 10 },
  { _id: 'c', _createdAt: '2026-07-21T00:00:00.000Z', group: 'A', score: 1 },
];

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

function createReader(readRows: () => readonly ModelRecord[]): DataReader {
  return {
    async getByIds(_modelName, ids) {
      return readRows().filter((row) => ids.includes(row._id));
    },
    async getAll() {
      return [...readRows()];
    },
    async findFirstByFieldEq(_modelName, field, value) {
      return readRows().find((row) => row[field] === value);
    },
  };
}

function createChain(readRows: () => readonly ModelRecord[] = () => initialRows): QueryChain {
  return new QueryChain(createRegistry(), indexReader, createReader(readRows), 'Item', {
    kind: 'all',
  });
}

describe('QueryChain cursor pagination', () => {
  it('continues ordinary rows and carries the cursor through wire serialization', async () => {
    const first = (await createChain()
      .orderBy('score', 'desc')
      .cursor()
      .limit(2)
      .execute()) as Paginated<HydratedEntity[]>;

    assert.deepEqual(first.items.map((row) => row.getData()._id), ['b', 'a']);
    assert.equal(typeof first.nextCursor, 'string');

    const wire = serializeExecuteResultForWire(first);
    assert.equal(wire.kind, 'paginated');
    if (wire.kind === 'paginated') {
      assert.equal(wire.nextCursor, first.nextCursor);
    }

    const second = (await createChain()
      .orderBy('score', 'desc')
      .cursor(first.nextCursor!)
      .limit(2)
      .execute()) as Paginated<HydratedEntity[]>;

    assert.deepEqual(second.items.map((row) => row.getData()._id), ['c']);
    assert.equal(second.nextCursor, undefined);
  });

  it('continues aggregation buckets in their configured order', async () => {
    const first = (await createChain()
      .groupBy(['group'])
      .compute({ score: 'sum' })
      .orderBy('group', 'asc')
      .cursor()
      .limit(1)
      .execute()) as Paginated<AnalysisResult>;

    assert.deepEqual(first.items.asFlatTable(), [{ group: 'A', score: 3 }]);
    assert.equal(typeof first.nextCursor, 'string');

    const second = (await createChain()
      .groupBy(['group'])
      .compute({ score: 'sum' })
      .orderBy('group', 'asc')
      .cursor(first.nextCursor!)
      .limit(1)
      .execute()) as Paginated<AnalysisResult>;

    assert.deepEqual(second.items.asFlatTable(), [{ group: 'B', score: 10 }]);
    assert.equal(second.nextCursor, undefined);
  });

  it('rejects a cursor after the query ordering changes', async () => {
    const first = (await createChain()
      .orderBy('score', 'desc')
      .cursor()
      .limit(1)
      .execute()) as Paginated<HydratedEntity[]>;

    await assert.rejects(
      createChain().orderBy('score', 'asc').cursor(first.nextCursor!).limit(1).execute(),
      /query scope/,
    );
  });

  it('rejects a cursor when its anchor row no longer exists', async () => {
    let rows = [...initialRows];
    const first = (await createChain(() => rows)
      .orderBy('score', 'desc')
      .cursor()
      .limit(1)
      .execute()) as Paginated<HydratedEntity[]>;
    rows = rows.filter((row) => row._id !== 'b');

    await assert.rejects(
      createChain(() => rows)
        .orderBy('score', 'desc')
        .cursor(first.nextCursor!)
        .limit(1)
        .execute(),
      /anchor is no longer present/,
    );
  });

  it('requires protocol v7 for a remote cursor request', () => {
    const chain = QueryChain.fromWirePlan(createRegistry(), indexReader, createReader(() => initialRows), {
      version: 6,
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
          { cursor: null, limit: 10 },
        ),
      /version 7/,
    );
  });

  it('builds protocol v7 snapshots for cursor mode and clears page mode', () => {
    const snapshot = new WireQueryChain('Item', { kind: 'all' })
      .page(3)
      .cursor()
      .limit(10)
      .getRemoteExecuteSnapshot();

    assert.equal(snapshot.plan.version, 7);
    assert.deepEqual(snapshot.execute, { limit: 10, cursor: null });
  });
});

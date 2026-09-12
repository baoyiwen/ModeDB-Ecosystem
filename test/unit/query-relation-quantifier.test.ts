import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ModelRegistry,
  type DataReader,
  type IndexReader,
  type ModelRecord,
  type RelationDefinition,
} from '@mode-db/common';
import { QueryChain, type HydratedEntity } from '@mode-db/core';
import type { PredicateNode, RelationQuantifier } from '@mode-db/shared';

const parentRows: ModelRecord[] = [
  { _id: 'p1', _createdAt: '2026-07-21T00:00:00.000Z', name: 'mixed' },
  { _id: 'p2', _createdAt: '2026-07-21T00:00:00.000Z', name: 'all-active' },
  { _id: 'p3', _createdAt: '2026-07-21T00:00:00.000Z', name: 'empty' },
];
const childRows: ModelRecord[] = [
  { _id: 'c1', _createdAt: '2026-07-21T00:00:00.000Z', active: true },
  { _id: 'c2', _createdAt: '2026-07-21T00:00:00.000Z', active: false },
  { _id: 'c3', _createdAt: '2026-07-21T00:00:00.000Z', active: true },
];

const registry = new ModelRegistry();
registry.registerModel('Parent', new Set(['name']));
registry.registerModel('Child', new Set(['active']));
registry.registerRelation('Parent', 'Child', 'children', 'parent', 'one-to-many');

const dataReader: DataReader = {
  async getByIds(modelName, ids) {
    const rows = modelName === 'Parent' ? parentRows : childRows;
    return rows.filter((row) => ids.includes(row._id));
  },
  async getAll(modelName) {
    return [...(modelName === 'Parent' ? parentRows : childRows)];
  },
  async findFirstByFieldEq(modelName, field, value) {
    const rows = modelName === 'Parent' ? parentRows : childRows;
    return rows.find((row) => row[field] === value);
  },
};

const indexReader: IndexReader = {
  async getForward(_relation: RelationDefinition, sourceId: string) {
    if (sourceId === 'p1') return ['c1', 'c2'];
    if (sourceId === 'p2') return ['c3'];
    return [];
  },
  async getReverse() {
    return [];
  },
};

function relationPredicate(quantifier: RelationQuantifier): PredicateNode {
  return {
    type: 'relation',
    relationName: 'children',
    quantifier,
    target: { type: 'atom', field: 'active', op: 'eq', value: true },
  };
}

async function matchingNames(quantifier: RelationQuantifier): Promise<string[]> {
  const rows = (await new QueryChain(
    registry,
    indexReader,
    dataReader,
    'Parent',
    { kind: 'all' },
  )
    .matchAllNodes(() => [relationPredicate(quantifier)])
    .execute()) as HydratedEntity[];
  return rows.map((row) => String(row.getData().name));
}

describe('relation predicate quantifiers', () => {
  it('ANY keeps records with at least one matching related row', async () => {
    assert.deepEqual(await matchingNames('any'), ['mixed', 'all-active']);
  });

  it('ALL requires every related row and is true for an empty relation set', async () => {
    assert.deepEqual(await matchingNames('all'), ['all-active', 'empty']);
  });

  it('NONE keeps records without matching related rows', async () => {
    assert.deepEqual(await matchingNames('none'), ['empty']);
  });

  it('uses protocol version 4 when serialized', () => {
    const snapshot = new QueryChain(
      registry,
      indexReader,
      dataReader,
      'Parent',
      { kind: 'all' },
    )
      .matchAllNodes(() => [relationPredicate('any')])
      .getRemoteExecuteSnapshot();
    assert.equal(snapshot.plan.version, 4);
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DataType,
  ModelRegistry,
  type DataReader,
  type FieldTypeDef,
  type IndexReader,
  type ModelRecord,
} from '@mode-db/common';
import { QueryChain, QueryEngine, type HydratedEntity } from '@mode-db/core';

describe('core query predicates', () => {
  it('coerces eq/neq/in values using field type metadata', () => {
    const row = {
      _id: 'city-1',
      _createdAt: '2026-07-02T00:00:00.000Z',
      provinceCode: 110000,
      enabled: true,
      name: 'Beijing',
    } satisfies ModelRecord;
    const fieldTypes = new Map<string, FieldTypeDef>([
      ['provinceCode', { type: DataType.Int }],
      ['enabled', { type: DataType.Boolean }],
      ['name', { type: DataType.String }],
    ]);

    assert.equal(
      QueryEngine.matches(
        row,
        { type: 'atom', field: 'provinceCode', op: 'eq', value: '110000' },
        { fieldTypes },
      ),
      true,
    );
    assert.equal(
      QueryEngine.matches(
        row,
        { type: 'atom', field: 'enabled', op: 'in', value: ['false', 'true'] },
        { fieldTypes },
      ),
      true,
    );
    assert.equal(
      QueryEngine.matches(
        row,
        { type: 'atom', field: 'name', op: 'neq', value: 110000 },
        { fieldTypes },
      ),
      true,
    );
  });

  it('does not bypass typed matching through the business id fast path', async () => {
    const rows: ModelRecord[] = [
      { _id: 'row-a', _createdAt: '2026-07-02T00:00:00.000Z', id: 11, name: 'A' },
      { _id: 'row-b', _createdAt: '2026-07-02T00:00:00.000Z', id: 11, name: 'B' },
    ];
    const dataReader: DataReader = {
      async getByIds(_modelName, ids) {
        return rows.filter((row) => ids.includes(row._id));
      },
      async getAll() {
        return rows;
      },
      async findFirstByFieldEq() {
        throw new Error('business id optimization should not be used for query predicates');
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
    const fieldTypes = new Map<string, FieldTypeDef>([['id', { type: DataType.Int }]]);
    const chain = new QueryChain(
      new ModelRegistry(),
      indexReader,
      dataReader,
      'City',
      { kind: 'all' },
      { fieldTypes },
    );

    const result = (await chain.where('id', 'eq', '11').execute()) as HydratedEntity[];
    const data = result.map((row) => row.getData());
    assert.deepEqual(
      data.map((row) => row._id),
      ['row-a', 'row-b'],
    );
  });
});

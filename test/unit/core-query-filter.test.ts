import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  DataType,
  ModelRegistry,
  type DataReader,
  type FieldTypeDef,
  type IndexReader,
  type ModelRecord,
  type RelationDefinition,
} from '@mode-db/common';
import {
  AuthoringEngine,
  QueryChain,
  QueryEngine,
  executeDatabaseOperation,
  type HydratedEntity,
} from '@mode-db/core';
import { mergeDiskRowsWithAuthoringBuffer } from '../../packages/core/src/runtime/query-engine.js';

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

  it('collapses append-only duplicate ids to the latest live row', () => {
    const diskRows: ModelRecord[] = [
      {
        _id: 'asset-1',
        _createdAt: '2026-07-07T00:00:00.000Z',
        code: 'Test_DB',
        name: { zh: '测试数据库' },
      },
      {
        _id: 'asset-1',
        _createdAt: '2026-07-07T00:00:00.000Z',
        code: 'Test_DB',
        name: { zh: '测试数据库01' },
      },
    ];

    const rows = mergeDiskRowsWithAuthoringBuffer(diskRows, new Map());

    assert.equal(rows.length, 1);
    assert.deepEqual((rows[0] as Record<string, unknown>).name, { zh: '测试数据库01' });
  });

  it('resolves self-relation reverse labels through reverse indexes', async () => {
    const registry = new ModelRegistry();
    registry.registerModel('Division', new Set(['code', 'name']));
    registry.registerRelation('Division', 'Division', 'children', 'parent', 'one-to-many');

    const rows: ModelRecord[] = [
      { _id: 'parent-1', _createdAt: '2026-07-07T00:00:00.000Z', code: 'P', name: 'Parent' },
      { _id: 'child-1', _createdAt: '2026-07-07T00:00:00.000Z', code: 'C', name: 'Child' },
    ];
    const dataReader: DataReader = {
      async getByIds(_modelName, ids) {
        return rows.filter((row) => ids.includes(row._id));
      },
      async getAll() {
        return rows;
      },
      async findFirstByFieldEq(modelName, field, value) {
        return rows.find((row) => modelName === 'Division' && row[field] === value);
      },
    };
    const indexReader: IndexReader = {
      async getForward(_rel: RelationDefinition, sourceId: string) {
        return sourceId === 'parent-1' ? ['child-1'] : [];
      },
      async getReverse(_rel: RelationDefinition, targetId: string) {
        return targetId === 'child-1' ? ['parent-1'] : [];
      },
    };

    const result = (await new QueryChain(
      registry,
      indexReader,
      dataReader,
      'Division',
      { kind: 'ids', ids: ['child-1'] },
    )
      .relate('parent')
      .execute({ includeRelates: true })) as HydratedEntity[];

    const childData = result[0]?.getData(true) as
      | { relates?: Record<string, Array<Record<string, unknown>>> }
      | undefined;
    assert.equal(childData?.relates?.parent?.[0]?._id, 'parent-1');
  });

  it('skips self-loop pairs during self-relation import lookup binding', async () => {
    const root = mkdtempSync(join(tmpdir(), 'modedb-import-self-'));
    const engine = new AuthoringEngine({
      atlas: 'import-self',
      storageRoot: root,
      keyProvider: fixtureVaultKeys(root),
    });
    try {
      engine.registerModel('Division', { code: 'String', name: 'String' });
      engine.registerRelation('Division', 'Division', 'children', 'parent', 'one-to-many');
      const row = await engine.insert('Division', { code: 'SELF', name: 'Self' }, { sync: true });

      const result = await executeDatabaseOperation(
        { engine, atlas: 'import-self', flush: () => engine.flushAll() },
        {
          op: 'bindImportLookup',
          forward: 'children',
          reverse: 'parent',
          importModel: 'Division',
          peerModel: 'Division',
          importSide: 'target',
          peerMatchField: 'code',
          peerMatchFieldType: 'String',
          pairs: [{ importedId: row._id, lookupValue: 'SELF' }],
        },
      );

      assert.equal(result.kind, 'mutation');
      if (result.kind === 'mutation') {
        assert.equal(result.pairsCount, 0);
        assert.equal(result.skippedCount, 1);
      }
      const rel = engine.registry.getRelations()[0]!;
      assert.deepEqual(await engine.indexer.getForward(rel, row._id), []);
      assert.deepEqual(await engine.indexer.getReverse(rel, row._id), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows self-loop pairs when relation policy is allow', async () => {
    const root = mkdtempSync(join(tmpdir(), 'modedb-import-self-allow-'));
    const engine = new AuthoringEngine({
      atlas: 'import-self-allow',
      storageRoot: root,
      keyProvider: fixtureVaultKeys(root),
    });
    try {
      engine.registerModel('Division', { code: 'String', name: 'String' });
      engine.registerRelation(
        'Division',
        'Division',
        'children',
        'parent',
        'one-to-many',
        null,
        'allow',
      );
      const row = await engine.insert('Division', { code: 'SELF', name: 'Self' }, { sync: true });

      const result = await executeDatabaseOperation(
        { engine, atlas: 'import-self-allow', flush: () => engine.flushAll() },
        {
          op: 'bindImportLookup',
          forward: 'children',
          reverse: 'parent',
          importModel: 'Division',
          peerModel: 'Division',
          importSide: 'target',
          peerMatchField: 'code',
          peerMatchFieldType: 'String',
          pairs: [{ importedId: row._id, lookupValue: 'SELF' }],
        },
      );

      assert.equal(result.kind, 'mutation');
      if (result.kind === 'mutation') {
        assert.equal(result.pairsCount, 1);
        assert.equal(result.skippedCount, 0);
      }
      const rel = engine.registry.getRelations()[0]!;
      assert.deepEqual(await engine.indexer.getForward(rel, row._id), [row._id]);
      assert.deepEqual(await engine.indexer.getReverse(rel, row._id), [row._id]);

      const treeRows = (await engine
        .model('Division')
        .query()
        .children('children')
        .execute({ includeRelates: true })) as HydratedEntity[];
      assert.equal(treeRows.length, 1);
      const treeData = treeRows[0]?.getData(true) as
        | { relates?: Record<string, Array<Record<string, unknown>>> }
        | undefined;
      assert.equal(treeData?.relates?.children?.[0]?._id, row._id);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
import { fixtureVaultKeys } from '../vault-keys.js';

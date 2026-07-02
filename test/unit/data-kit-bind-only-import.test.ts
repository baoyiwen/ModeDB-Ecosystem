import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { importLookupCanonicalKey } from '@mode-db/common';
import {
  buildImportInsertOps,
  buildBindImportLookupOps,
  isBindOnlyRelationRule,
  normalizeImportLookupKey,
  coerceImportLookupKey,
} from '@mode-db/data-kit';

const PROVINCE_CITY = {
  forward: 'cities',
  reverse: 'province',
  source: 'Province',
  target: 'City',
};

const PROVINCE_CATALOG = {
  name: 'Province',
  fields: ['id', 'name'],
  fieldTypes: { id: 'Int', name: 'String' },
};

describe('isBindOnlyRelationRule', () => {
  it('defaults to bind-only when CSV column is not in column mapping', () => {
    assert.equal(
      isBindOnlyRelationRule(
        {
          relation: 'cities',
          sourceColumn: 'provinceCode',
          targetModel: 'Province',
          targetMatchColumn: 'id',
        },
        { code: 'code', name: 'name' },
      ),
      true,
    );
  });

  it('is not bind-only when column is mapped to a model prop', () => {
    assert.equal(
      isBindOnlyRelationRule(
        {
          relation: 'cities',
          sourceColumn: 'provinceCode',
          targetModel: 'Province',
          targetMatchColumn: 'id',
        },
        { provinceCode: 'provinceCode', code: 'code' },
      ),
      false,
    );
  });
});

describe('buildImportInsertOps bind-only', () => {
  it('does not persist bind-only columns but stages join values', () => {
    const result = buildImportInsertOps(
      {
        id: 'p1',
        sourceFingerprint: 'fp',
        targetModel: 'City',
        columnMapping: { code: 'code', name: 'name' },
        relationBindings: [
          {
            relation: 'cities',
            sourceColumn: 'provinceCode',
            targetModel: 'Province',
            targetMatchColumn: 'id',
          },
        ],
      },
      [{ code: 'c1', name: 'Tokyo', provinceCode: 'P01' }],
      { relations: [PROVINCE_CITY], targetFields: ['code', 'name'] },
    );

    assert.equal(result.importedRowCount, 1);
    assert.ok(result.bindOnlyStaging);
    const insert = result.ops.find((o) => o.op === 'insertMany');
    assert.ok(insert && insert.op === 'insertMany');
    assert.deepEqual(insert.rows[0], { code: 'c1', name: 'Tokyo' });
    assert.equal(insert.returning, true);
    assert.equal(result.ops.some((o) => o.op === 'bind'), false);

    const joinValues = result.bindOnlyStaging!.chunks[0]!.joinValues[0]!;
    assert.equal(joinValues.values[0], 'P01');
  });

  it('coerces bind-only join values to peer match field type', () => {
    const result = buildImportInsertOps(
      {
        id: 'p1',
        sourceFingerprint: 'fp',
        targetModel: 'City',
        columnMapping: { code: 'code', name: 'name' },
        relationBindings: [
          {
            relation: 'cities',
            sourceColumn: 'provinceCode',
            targetModel: 'Province',
            targetMatchColumn: 'id',
          },
        ],
      },
      [{ code: 'c1', name: 'Tokyo', provinceCode: '11' }],
      {
        relations: [PROVINCE_CITY],
        targetFields: ['code', 'name'],
        catalogModels: [PROVINCE_CATALOG],
      },
    );

    const joinValues = result.bindOnlyStaging!.chunks[0]!.joinValues[0]!;
    assert.equal(joinValues.values[0], 11);
  });
});

describe('buildBindImportLookupOps', () => {
  it('builds lookup bind op from insertMany returning + join values', () => {
    const staging = {
      targetModel: 'City',
      relations: [PROVINCE_CITY],
      catalogModels: [PROVINCE_CATALOG],
      chunks: [
        {
          joinValues: [
            {
              rule: {
                relation: 'cities',
                sourceColumn: 'provinceCode',
                targetModel: 'Province',
                targetMatchColumn: 'id',
              },
              values: [11],
            },
          ],
        },
      ],
    };
    const ops = buildBindImportLookupOps(staging, [
      {
        op: 'insertMany',
        model: 'City',
        records: [{ _id: 'city-1', code: 'c1', name: 'Tokyo' }],
      },
    ]);
    assert.equal(ops.length, 1);
    assert.equal(ops[0]?.op, 'bindImportLookup');
    if (ops[0]?.op === 'bindImportLookup') {
      assert.equal(ops[0].peerMatchField, 'id');
      assert.equal(ops[0].peerMatchFieldType, 'Int');
      assert.deepEqual(ops[0].pairs, [{ importedId: 'city-1', lookupValue: 11 }]);
    }
  });
});

describe('import lookup key coercion', () => {
  it('normalizeImportLookupKey stringifies numbers for tolerant peer lookup', () => {
    assert.equal(normalizeImportLookupKey(11), '11');
    assert.equal(normalizeImportLookupKey('11'), '11');
  });

  it('coerceImportLookupKey matches CSV string to peer Int field', () => {
    assert.equal(coerceImportLookupKey('11', 'Int'), '11');
    assert.equal(coerceImportLookupKey(11, 'Int'), '11');
    assert.equal(importLookupCanonicalKey('11', 'Int'), '11');
    assert.equal(importLookupCanonicalKey(11, 'String'), '11');
  });

  it('coerceImportLookupKey matches CSV number to peer String field', () => {
    assert.equal(coerceImportLookupKey(11, 'String'), '11');
    assert.equal(importLookupCanonicalKey('11', 'String'), '11');
  });
});

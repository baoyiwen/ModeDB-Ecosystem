import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildImportInsertOps,
  buildRelationBindOps,
  createImportProfile,
  resolveProtocolBindMatch,
  suggestRelationBindings,
} from '@mode-db/data-kit';

const COUNTRY_PROVINCE = {
  forward: 'provinces',
  reverse: 'country',
  source: 'Country',
  target: 'Province',
};

describe('resolveProtocolBindMatch', () => {
  it('maps import on relation target to PROTOCOL source/target fields', () => {
    const rule = {
      relation: 'provinces',
      sourceColumn: 'country_code',
      targetModel: 'Country',
      targetMatchColumn: 'code',
    };
    const match = resolveProtocolBindMatch(rule, COUNTRY_PROVINCE, 'Province', 'countryCode');
    assert.deepEqual(match, {
      forward: 'provinces',
      reverse: 'country',
      sourceField: 'code',
      targetField: 'countryCode',
    });
  });

  it('maps import on relation source when peer is target', () => {
    const rule = {
      relation: 'provinces',
      sourceColumn: 'region_code',
      targetModel: 'Province',
      targetMatchColumn: 'code',
    };
    const match = resolveProtocolBindMatch(rule, COUNTRY_PROVINCE, 'Country', 'regionCode');
    assert.deepEqual(match, {
      forward: 'provinces',
      reverse: 'country',
      sourceField: 'regionCode',
      targetField: 'code',
    });
  });
});

describe('buildRelationBindOps', () => {
  it('appends PROTOCOL bind after insertMany profile', () => {
    const profile = createImportProfile(
      'Province',
      { country_code: 'countryCode', name: 'name' },
      'fp',
      {
        relationBindings: [
          {
            relation: 'provinces',
            sourceColumn: 'country_code',
            targetModel: 'Country',
            targetMatchColumn: 'code',
          },
        ],
      },
    );
    const insert = buildImportInsertOps(profile, [{ country_code: 11, name: '北京' }], {
      relations: [COUNTRY_PROVINCE],
    });
    assert.equal(insert.ops.length, 2);
    assert.equal(insert.ops[0]?.op, 'insertMany');
    assert.equal(insert.ops[1]?.op, 'bind');
    if (insert.ops[1]?.op === 'bind') {
      assert.equal(insert.ops[1].strategy, 'PROTOCOL');
      assert.deepEqual(insert.ops[1].matchOn, {
        sourceField: 'code',
        targetField: 'countryCode',
      });
    }
  });
});

describe('suggestRelationBindings', () => {
  it('suggests when CSV column normalizes to peer model field', () => {
    const rules = suggestRelationBindings(
      [{ name: 'code' }],
      'Province',
      [COUNTRY_PROVINCE],
      [{ name: 'Country', fields: ['code', 'name'] }],
    );
    assert.equal(rules.length, 1);
    assert.equal(rules[0]?.targetModel, 'Country');
    assert.equal(rules[0]?.targetMatchColumn, 'code');
  });
});

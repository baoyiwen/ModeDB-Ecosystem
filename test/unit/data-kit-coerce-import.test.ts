import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  coerceImportRow,
  coerceImportValue,
  importFieldTypesForProps,
} from '@mode-db/data-kit';

test('coerceImportValue stringifies numbers for String fields', () => {
  assert.equal(coerceImportValue(11, 'String'), '11');
  assert.equal(coerceImportValue('hello', 'String'), 'hello');
});

test('coerceImportValue parses numbers for Int fields', () => {
  assert.equal(coerceImportValue('11', 'Int'), 11);
  assert.equal(coerceImportValue(11.9, 'Int'), 11);
});

test('coerceImportRow applies catalog field types', () => {
  const row = coerceImportRow({ code: 11, name: 'Beijing' }, { code: 'String', name: 'String' });
  assert.equal(row.code, '11');
  assert.equal(row.name, 'Beijing');
});

test('importFieldTypesForProps defaults missing fields to String', () => {
  const map = importFieldTypesForProps(['code', 'name'], { code: 'Int' });
  assert.equal(map.code, 'Int');
  assert.equal(map.name, 'String');
});

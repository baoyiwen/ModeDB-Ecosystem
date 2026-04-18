/**
 * Unit tests: pure helpers from `@mode-db/common` (no engine I/O).
 * Run: **`pnpm run test:unit`**
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DataType, normalizeFieldDef, normalizeFieldDefs } from '@mode-db/common';

test('normalizeFieldDef accepts shorthand DataType', () => {
  const d = normalizeFieldDef(DataType.String);
  assert.equal(d.type, 'String');
});

test('normalizeFieldDefs builds field + type map', () => {
  const { fields, fieldTypes } = normalizeFieldDefs({
    id: DataType.String,
    note: { type: DataType.String, required: false },
  });
  assert.equal(fields.has('id'), true);
  assert.equal(fieldTypes.get('note')?.required, false);
});

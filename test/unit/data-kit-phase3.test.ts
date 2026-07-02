import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  autoMapIngestColumns,
  buildImportInsertOps,
  createImportProfile,
  normalizeColumnKey,
} from '@mode-db/data-kit';

describe('autoMapIngestColumns', () => {
  it('maps exact and normalized column names', () => {
    const result = autoMapIngestColumns(
      [{ name: 'user_name' }, { name: 'Email' }],
      { targetFields: ['userName', 'email'] },
    );
    assert.equal(normalizeColumnKey('user_name'), normalizeColumnKey('userName'));
    assert.equal(result.mappedColumns.user_name, 'userName');
    assert.equal(result.mappedColumns.Email, 'email');
    assert.equal(result.ambiguities.length, 0);
  });

  it('reports ambiguous fuzzy matches', () => {
    const result = autoMapIngestColumns([{ name: 'name' }], {
      targetFields: ['firstName', 'lastName'],
    });
    assert.equal(Object.keys(result.mappedColumns).length, 0);
    assert.ok(result.ambiguities.some((a) => a.kind === 'column_mapping'));
  });
});

describe('buildImportInsertOps', () => {
  it('chunks rows into insertMany operations', () => {
    const profile = createImportProfile(
      'Item',
      { id: 'code', title: 'name' },
      'test-fp',
      { chunkSize: 2 },
    );
    const built = buildImportInsertOps(profile, [
      { id: 1, title: 'A' },
      { id: 2, title: 'B' },
      { id: 3, title: 'C' },
    ]);

    assert.equal(built.importedRowCount, 3);
    assert.equal(built.ops.length, 2);
    assert.equal(built.ops[0]?.op, 'insertMany');
    if (built.ops[0]?.op === 'insertMany') {
      assert.equal(built.ops[0].model, 'Item');
      assert.equal(built.ops[0].rows.length, 2);
      assert.deepEqual(built.ops[0].rows[0], { code: 1, name: 'A' });
    }
  });

  it('skips empty rows when drop_empty_rows rule is enabled', () => {
    const profile = createImportProfile('Item', { a: 'a' }, 'fp');
    const built = buildImportInsertOps(profile, [{ a: '' }, { a: 'ok' }]);
    assert.equal(built.importedRowCount, 1);
    assert.equal(built.skippedRowCount, 1);
  });
});

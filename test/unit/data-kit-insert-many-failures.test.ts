import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { EngineApplyOutcome, EngineOperation } from '@mode-db/shared';
import {
  extractInsertManyFailures,
  rebuildPendingAfterInsertManyFailures,
} from '@mode-db/data-kit';

describe('insert-many-failures', () => {
  it('extracts row failures with diagnostics', () => {
    const batch: EngineOperation[] = [
      {
        op: 'insertMany',
        model: 'Province',
        rows: [{ code: 11, name: 'A' }, { code: 12, name: 'B' }],
      },
    ];
    const outcomes: EngineApplyOutcome[] = [
      {
        ok: true,
        result: {
          kind: 'mutation',
          op: 'insertMany',
          model: 'Province',
          record: null,
          successCount: 0,
          failureCount: 2,
          rowFailures: [
            {
              index: 0,
              diagnostics: [
                {
                  code: 'E1003',
                  severity: 'ERROR',
                  message: 'Field "code" expects String but received number.',
                },
              ],
            },
            {
              index: 1,
              diagnostics: [
                {
                  code: 'E1003',
                  severity: 'ERROR',
                  message: 'Field "code" expects String but received number.',
                },
              ],
            },
          ],
        },
      },
    ];
    const failures = extractInsertManyFailures(batch, outcomes);
    assert.equal(failures.length, 2);
    assert.ok(failures[0]?.reasons[0]?.includes('String'));
  });

  it('rebuilds pending ops with only failed rows', () => {
    const batch: EngineOperation[] = [
      {
        op: 'insertMany',
        model: 'Province',
        rows: [{ code: 1 }, { code: 2 }, { code: 3 }],
      },
    ];
    const outcomes: EngineApplyOutcome[] = [
      {
        ok: true,
        result: {
          kind: 'mutation',
          op: 'insertMany',
          model: 'Province',
          record: null,
          successCount: 1,
          failureCount: 2,
          rowFailures: [
            { index: 1, diagnostics: [{ code: 'E1003', severity: 'ERROR', message: 'bad' }] },
            { index: 2, diagnostics: [{ code: 'E1003', severity: 'ERROR', message: 'bad' }] },
          ],
        },
      },
    ];
    const next = rebuildPendingAfterInsertManyFailures(batch, outcomes);
    assert.equal(next.length, 1);
    const op = next[0];
    assert.ok(op && op.op === 'insertMany');
    if (op.op === 'insertMany') {
      assert.equal(op.rows.length, 2);
      assert.deepEqual(op.rows[0], { code: 2 });
    }
  });
});

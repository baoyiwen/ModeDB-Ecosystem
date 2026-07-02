import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  firstApplyOutcomeError,
  mutationOutcomeError,
  pickPropFields,
} from '@mode-db/data-kit';

describe('apply-outcome', () => {
  it('pickPropFields keeps only schema keys', () => {
    assert.deepEqual(pickPropFields({ a: 1, b: 2, _id: 'x' }, ['a']), { a: 1 });
  });

  it('detects insertMany validation failure', () => {
    const err = mutationOutcomeError({
      op: 'insertMany',
      model: 'Province',
      successCount: 0,
      failureCount: 3,
    });
    assert.ok(err?.includes('Province'));
    assert.ok(err?.includes('validation'));
  });

  it('firstApplyOutcomeError surfaces mutation errors', () => {
    const err = firstApplyOutcomeError([
      {
        ok: true,
        result: { op: 'insertMany', model: 'X', successCount: 0, failureCount: 1 } as any,
      },
    ]);
    assert.ok(err);
  });
});

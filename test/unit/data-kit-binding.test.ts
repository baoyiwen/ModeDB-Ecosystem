import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createBindingSession, overlayPendingEdits } from '@mode-db/data-kit';
import type { BindingExecutor } from '@mode-db/data-kit';
import type { RemoteExecuteSnapshot } from '@mode-db/shared';

const SNAPSHOT: RemoteExecuteSnapshot = {
  plan: {
    version: 2,
    originModel: 'Item',
    start: { kind: 'all' },
    hops: [],
    trailing: { type: 'group', logic: 'AND', children: [] },
  },
  execute: { page: 0, limit: 10 },
  analysis: { groupBy: null, compute: null },
};

function stubExecutor(): BindingExecutor {
  return {
    async executeQuery() {
      return { kind: 'rows', rows: [] };
    },
    async applyAll(ops) {
      return ops.map(() => ({ ok: true }));
    },
  };
}

describe('BindingSession stageCellUpdate', () => {
  it('deduplicates pending updates for the same cell', () => {
    const session = createBindingSession({
      querySnapshot: SNAPSHOT,
      executor: stubExecutor(),
    });
    const ref = { model: 'Item', id: 'a1' };
    const rev0 = session.revision;
    session.stageCellUpdate(ref, 'name', 'first', 'edit');
    assert.ok(session.revision > rev0);
    session.stageCellUpdate(ref, 'name', 'second', 'edit');
    assert.equal(session.pendingCount, 1);
    const op = session.pendingOps[0];
    assert.equal(op?.op, 'update');
    if (op?.op === 'update') {
      assert.equal(op.partial.name, 'second');
    }
  });

  it('bumps revision when staging row delete', () => {
    const session = createBindingSession({
      querySnapshot: SNAPSHOT,
      executor: stubExecutor(),
    });
    const rev0 = session.revision;
    session.stageRowDelete({ model: 'Item', id: 'a1' });
    assert.ok(session.revision > rev0);
    assert.equal(session.pendingCount, 1);
  });
});

describe('overlayPendingEdits', () => {
  it('merges staged partials onto display rows', () => {
    const rows = [{ _id: 'a1', name: 'Old' }];
    const refs = [{ model: 'Item', id: 'a1' }];
    const pending = [{ op: 'update' as const, model: 'Item', id: 'a1', partial: { name: 'New' } }];
    const out = overlayPendingEdits(rows, refs, pending);
    assert.equal(out[0]?.name, 'New');
  });
});

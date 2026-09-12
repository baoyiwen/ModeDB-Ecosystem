import assert from 'node:assert/strict';
import test from 'node:test';

import {
  directedPairedCurvedSegment,
  relationPairDefaultAnchor,
  RELATION_INTRA_PAIR_GAP,
} from '../../apps/model-designer/src/canvas/relation-geometry.js';

const source = { x: 0, y: 0 };
const target = { x: 320, y: 0 };

test('a relation pair returns to parallel lines at its default anchor', () => {
  const anchor = relationPairDefaultAnchor(source, target);
  const forward = directedPairedCurvedSegment(
    source,
    target,
    RELATION_INTRA_PAIR_GAP,
    anchor,
  );
  const reverse = directedPairedCurvedSegment(
    target,
    source,
    RELATION_INTRA_PAIR_GAP,
    anchor,
  );

  assert.equal(forward.bent, false);
  assert.equal(reverse.bent, false);
  assert.equal(forward.cpy, anchor.y + RELATION_INTRA_PAIR_GAP);
  assert.equal(reverse.cpy, anchor.y - RELATION_INTRA_PAIR_GAP);
});

test('both directions stay symmetric around one dragged pair anchor', () => {
  const base = relationPairDefaultAnchor(source, target);
  const anchor = { x: base.x + 36, y: base.y + 72 };
  const forward = directedPairedCurvedSegment(
    source,
    target,
    RELATION_INTRA_PAIR_GAP,
    anchor,
  );
  const reverse = directedPairedCurvedSegment(
    target,
    source,
    RELATION_INTRA_PAIR_GAP,
    anchor,
  );

  assert.equal(forward.bent, true);
  assert.equal(reverse.bent, true);
  assert.equal((forward.cpx + reverse.cpx) / 2, anchor.x);
  assert.equal((forward.cpy + reverse.cpy) / 2, anchor.y);
  assert.equal(forward.cpy - reverse.cpy, RELATION_INTRA_PAIR_GAP * 2);
});

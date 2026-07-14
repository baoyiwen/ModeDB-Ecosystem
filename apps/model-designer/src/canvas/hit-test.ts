import type { EngineModelNode, EngineRelationEdge } from '../types/engine-schema.js';
import type { RelationCanvasMeta } from '../types/relation-canvas-meta.js';
import {
  directedCurvedSegment,
  distancePointToQuadraticBezier,
  distancePointToSegment,
  distancePointToSelfLoopArc,
  edgePerpOffsetById,
  edgeSelfLoopSlotById,
  RELATION_INTRA_PAIR_GAP,
  segmentLabelPlacement,
  selfLoopGeometry,
} from './relation-geometry.js';
import { isInheritRelation } from '../config/graph-edge-kinds.js';
import { computeNodeHeight, NODE_RADIUS } from './node-geometry.js';

export interface PlacedNode {
  model: EngineModelNode;
  x: number;
  y: number;
}

export type RelationHitDirection = 'forward' | 'reverse' | 'inherit' | 'self';

export interface RelationHit {
  id: string;
  direction: RelationHitDirection;
}

export function buildPlacedNodes(
  models: readonly EngineModelNode[],
  getPos: (id: string) => { x: number; y: number } | undefined,
): PlacedNode[] {
  return models.map((m) => {
    const p = getPos(m.id) ?? { x: 0, y: 0 };
    return { model: m, x: p.x, y: p.y };
  });
}

export function hitTestNode(
  px: number,
  py: number,
  placed: readonly PlacedNode[],
  getZIndex: (id: string) => number,
  hiddenIds?: ReadonlySet<string>,
): string | undefined {
  const sorted = [...placed]
    .filter((p) => !hiddenIds?.has(p.model.id))
    .sort((a, b) => getZIndex(b.model.id) - getZIndex(a.model.id));
  const r = NODE_RADIUS;
  const r2 = r * r;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const { model, x, y } = sorted[i];
    const cx = x + r;
    const cy = y + r;
    const dx = px - cx;
    const dy = py - cy;
    if (dx * dx + dy * dy <= r2) {
      return model.id;
    }
  }
  return undefined;
}

export function anchorRightCenter(placed: PlacedNode): { x: number; y: number } {
  const h = computeNodeHeight(placed.model);
  const r = NODE_RADIUS;
  const cx = placed.x + r;
  const cy = placed.y + h / 2;
  return { x: cx + r, y: cy };
}

export function anchorLeftCenter(placed: PlacedNode): { x: number; y: number } {
  const h = computeNodeHeight(placed.model);
  const r = NODE_RADIUS;
  const cx = placed.x + r;
  const cy = placed.y + h / 2;
  return { x: cx - r, y: cy };
}

function segmentHitDistance(
  px: number,
  py: number,
  seg: ReturnType<typeof directedCurvedSegment>,
): number {
  if (seg.bent) {
    return distancePointToQuadraticBezier(px, py, seg.x1, seg.y1, seg.cpx, seg.cpy, seg.x2, seg.y2);
  }
  return distancePointToSegment(px, py, seg.x1, seg.y1, seg.x2, seg.y2);
}

function pointDistance(px: number, py: number, x: number, y: number): number {
  return Math.hypot(px - x, py - y);
}

/**
 * 世界坐标下命中关系边；`threshold` 为最大可点击距离（px）。
 */
export function hitTestRelation(
  px: number,
  py: number,
  relations: readonly EngineRelationEdge[],
  placed: readonly PlacedNode[],
  hiddenIds: ReadonlySet<string> | undefined,
  threshold: number,
  getMeta?: (relationId: string) => RelationCanvasMeta,
  hiddenRelationIds?: ReadonlySet<string>,
): RelationHit | undefined {
  const byId = new Map<string, PlacedNode>();
  for (const p of placed) {
    byId.set(p.model.id, p);
  }
  const offMap = edgePerpOffsetById(relations);
  const loopSlotMap = edgeSelfLoopSlotById(relations);
  let best: RelationHit | undefined;
  let bestD = Infinity;
  for (const r of relations) {
    if (hiddenRelationIds?.has(r.id)) {
      continue;
    }
    if (hiddenIds?.has(r.source_model_id) || hiddenIds?.has(r.target_model_id)) {
      continue;
    }
    const a = byId.get(r.source_model_id);
    const b = byId.get(r.target_model_id);
    if (!a || !b) {
      continue;
    }
    const meta = getMeta?.(r.id) ?? {};
    if (r.source_model_id === r.target_model_id) {
      const slot = loopSlotMap.get(r.id) ?? 0;
      const loop = selfLoopGeometry(a, slot, meta.self_loop_anchor);
      const d = Math.min(
        distancePointToSelfLoopArc(px, py, loop.forward),
        distancePointToSelfLoopArc(px, py, loop.reverse),
        pointDistance(px, py, loop.forward.labelX, loop.forward.labelY),
        pointDistance(px, py, loop.reverse.labelX, loop.reverse.labelY),
      );
      if (d <= threshold * 1.45 && d < bestD) {
        bestD = d;
        best = { id: r.id, direction: 'self' };
      }
      continue;
    }
    const slotOff = offMap.get(r.id) ?? 0;
    if (isInheritRelation(r.kind)) {
      const seg = directedCurvedSegment(a, b, slotOff, meta.forward_bend);
      const label = segmentLabelPlacement(seg);
      const d = Math.min(segmentHitDistance(px, py, seg), pointDistance(px, py, label.x, label.y));
      if (d <= threshold * 1.35 && d < bestD) {
        bestD = d;
        best = { id: r.id, direction: 'inherit' };
      }
      continue;
    }
    const fwd = directedCurvedSegment(a, b, slotOff + RELATION_INTRA_PAIR_GAP, meta.forward_bend);
    const rev = directedCurvedSegment(
      b,
      a,
      -(slotOff - RELATION_INTRA_PAIR_GAP),
      meta.reverse_bend,
    );
    const fwdLabel = segmentLabelPlacement(fwd);
    const revLabel = segmentLabelPlacement(rev);
    const dFwd = Math.min(
      segmentHitDistance(px, py, fwd),
      pointDistance(px, py, fwdLabel.x, fwdLabel.y),
    );
    const dRev = Math.min(
      segmentHitDistance(px, py, rev),
      pointDistance(px, py, revLabel.x, revLabel.y),
    );
    if (dFwd <= dRev) {
      if (dFwd <= threshold * 1.35 && dFwd < bestD) {
        bestD = dFwd;
        best = { id: r.id, direction: 'forward' };
      }
    } else if (dRev <= threshold * 1.35 && dRev < bestD) {
      bestD = dRev;
      best = { id: r.id, direction: 'reverse' };
    }
  }
  return best;
}

/** @deprecated 使用 {@link RelationHit.id} */
export function hitTestRelationId(
  px: number,
  py: number,
  relations: readonly EngineRelationEdge[],
  placed: readonly PlacedNode[],
  hiddenIds: ReadonlySet<string> | undefined,
  threshold: number,
  getMeta?: (relationId: string) => RelationCanvasMeta,
  hiddenRelationIds?: ReadonlySet<string>,
): string | undefined {
  return hitTestRelation(
    px,
    py,
    relations,
    placed,
    hiddenIds,
    threshold,
    getMeta,
    hiddenRelationIds,
  )?.id;
}

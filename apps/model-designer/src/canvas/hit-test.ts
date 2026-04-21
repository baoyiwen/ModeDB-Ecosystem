import type { EngineModelNode, EngineRelationEdge } from '../types/engine-schema.js';
import {
  directedShortestSegment,
  distancePointToSegment,
  edgePerpOffsetById,
} from './relation-geometry.js';
import { computeNodeHeight, NODE_RADIUS } from './node-geometry.js';

export interface PlacedNode {
  model: EngineModelNode;
  x: number;
  y: number;
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

/**
 * 世界坐标下命中关系边（与绘制一致的有向最短平行线段）；`threshold` 为最大可点击距离（px）。
 */
export function hitTestRelation(
  px: number,
  py: number,
  relations: readonly EngineRelationEdge[],
  placed: readonly PlacedNode[],
  hiddenIds: ReadonlySet<string> | undefined,
  threshold: number,
): string | undefined {
  const byId = new Map<string, PlacedNode>();
  for (const p of placed) {
    byId.set(p.model.id, p);
  }
  const offMap = edgePerpOffsetById(relations);
  let bestId: string | undefined;
  let bestD = Infinity;
  for (const r of relations) {
    if (hiddenIds?.has(r.source_model_id) || hiddenIds?.has(r.target_model_id)) {
      continue;
    }
    const a = byId.get(r.source_model_id);
    const b = byId.get(r.target_model_id);
    if (!a || !b) {
      continue;
    }
    const off = offMap.get(r.id) ?? 0;
    const seg = directedShortestSegment(a, b, off);
    const d = distancePointToSegment(px, py, seg.x1, seg.y1, seg.x2, seg.y2);
    if (d <= threshold && d < bestD) {
      bestD = d;
      bestId = r.id;
    }
  }
  return bestId;
}

import type { EngineRelationEdge } from '../types/engine-schema.js';
import { NODE_RADIUS } from './node-geometry.js';

/** 与 {@link hit-test.PlacedNode} 布局一致即可 */
export type PlacedLike = { x: number; y: number };

const PAIR_GAP = 12;

/** 圆形节点几何中心（与 draw-node / hit-test 一致）。 */
export function nodeCircleCenter(p: PlacedLike): { x: number; y: number } {
  return { x: p.x + NODE_RADIUS, y: p.y + NODE_RADIUS };
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\n${b}` : `${b}\n${a}`;
}

/**
 * 为共享同一对端点的多条有向边分配垂直于弦的偏移索引（平行线）。
 */
export function edgePerpOffsetById(relations: readonly EngineRelationEdge[]): Map<string, number> {
  const groups = new Map<string, EngineRelationEdge[]>();
  for (const r of relations) {
    const k = pairKey(r.source_model_id, r.target_model_id);
    const list = groups.get(k);
    if (list) {
      list.push(r);
    } else {
      groups.set(k, [r]);
    }
  }
  const out = new Map<string, number>();
  for (const [, list] of groups) {
    const sorted = [...list].sort((a, b) => a.id.localeCompare(b.id));
    const n = sorted.length;
    for (let i = 0; i < n; i++) {
      const slot = i - (n - 1) / 2;
      out.set(sorted[i].id, slot * PAIR_GAP);
    }
  }
  return out;
}

export interface DirectedSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** 指向 target 的单位向量（数据查询方向 target 端箭头） */
  ux: number;
  uy: number;
  midX: number;
  midY: number;
}

/**
 * 两圆间最短连线：从 source 圆边界沿指向 target 圆心方向，到 target 圆边界（可垂直偏移以区分重边）。
 */
export function directedShortestSegment(
  source: PlacedLike,
  target: PlacedLike,
  perpOffset: number,
): DirectedSegment {
  const cs = nodeCircleCenter(source);
  const ct = nodeCircleCenter(target);
  let dx = ct.x - cs.x;
  let dy = ct.y - cs.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) {
    return {
      x1: cs.x + NODE_RADIUS,
      y1: cs.y,
      x2: ct.x - NODE_RADIUS,
      y2: ct.y,
      ux: 1,
      uy: 0,
      midX: (cs.x + ct.x) / 2,
      midY: (cs.y + ct.y) / 2,
    };
  }
  const ux0 = dx / len;
  const uy0 = dy / len;
  const px = -uy0;
  const py = ux0;
  const ox = px * perpOffset;
  const oy = py * perpOffset;
  const x1 = cs.x + ux0 * NODE_RADIUS + ox;
  const y1 = cs.y + uy0 * NODE_RADIUS + oy;
  const x2 = ct.x - ux0 * NODE_RADIUS + ox;
  const y2 = ct.y - uy0 * NODE_RADIUS + oy;
  const ux = ux0;
  const uy = uy0;
  return {
    x1,
    y1,
    x2,
    y2,
    ux,
    uy,
    midX: (x1 + x2) / 2,
    midY: (y1 + y2) / 2,
  };
}

/** 预览：从源节点圆上指向世界点的一条射线（到鼠标）。 */
export function segmentFromNodeTowardPoint(
  source: PlacedLike,
  worldX: number,
  worldY: number,
): DirectedSegment {
  const cs = nodeCircleCenter(source);
  const dx0 = worldX - cs.x;
  const dy0 = worldY - cs.y;
  const len = Math.hypot(dx0, dy0);
  const ux = len < 1e-6 ? 1 : dx0 / len;
  const uy = len < 1e-6 ? 0 : dy0 / len;
  const x1 = cs.x + ux * NODE_RADIUS;
  const y1 = cs.y + uy * NODE_RADIUS;
  return {
    x1,
    y1,
    x2: worldX,
    y2: worldY,
    ux,
    uy,
    midX: (x1 + worldX) / 2,
    midY: (y1 + worldY) / 2,
  };
}

export function distancePointToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) {
    return Math.hypot(px - x1, py - y1);
  }
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const nx = x1 + t * dx;
  const ny = y1 + t * dy;
  return Math.hypot(px - nx, py - ny);
}

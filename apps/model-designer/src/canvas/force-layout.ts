import { NODE_RADIUS } from './node-geometry.js';
import { nodeCircleCenter } from './relation-geometry.js';

export interface ForceLayoutNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fixed: boolean;
}

export interface ForceLayoutEdge {
  source: string;
  target: string;
}

/** 两圆最小圆心距（含间隙）。 */
const MIN_CENTER_DIST = NODE_RADIUS * 2 + 12;
/** 单帧最大分离步长（世界 px），防止数值发散。 */
const MAX_SEPARATION_STEP = 1.2;

/**
 * 仅处理重叠：将相交的圆轻轻推开，无弹簧、无向心力、不累积速度。
 * 返回本帧是否发生了位置修正。
 */
export function tickForceLayout(
  nodes: ForceLayoutNode[],
  _edges: readonly ForceLayoutEdge[],
  _center: { x: number; y: number },
): boolean {
  let changed = false;

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!;
      const b = nodes[j]!;
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let dist = Math.hypot(dx, dy);
      if (dist < 1e-4) {
        dx = 1;
        dy = 0;
        dist = 1;
      }
      if (dist >= MIN_CENTER_DIST) {
        continue;
      }
      const overlap = MIN_CENTER_DIST - dist;
      const push = Math.min(overlap * 0.5, MAX_SEPARATION_STEP);
      const ux = dx / dist;
      const uy = dy / dist;
      const ax = ux * push;
      const ay = uy * push;
      if (!a.fixed) {
        a.x -= ax;
        a.y -= ay;
        changed = true;
      }
      if (!b.fixed) {
        b.x += ax;
        b.y += ay;
        changed = true;
      }
    }
  }

  for (const n of nodes) {
    n.vx = 0;
    n.vy = 0;
  }
  return changed;
}

export function buildForceNodes(
  modelIds: readonly string[],
  getPos: (id: string) => { x: number; y: number } | undefined,
  isFixed: (id: string) => boolean,
): ForceLayoutNode[] {
  return modelIds.map((id) => {
    const p = getPos(id) ?? { x: 0, y: 0 };
    const c = nodeCircleCenter(p);
    return { id, x: c.x, y: c.y, vx: 0, vy: 0, fixed: isFixed(id) };
  });
}

export function centerToTopLeft(cx: number, cy: number): { x: number; y: number } {
  return { x: cx - NODE_RADIUS, y: cy - NODE_RADIUS };
}

export function syncForceNodesFromLayout(
  nodes: ForceLayoutNode[],
  getPos: (id: string) => { x: number; y: number } | undefined,
): void {
  for (const n of nodes) {
    const p = getPos(n.id);
    if (!p) {
      continue;
    }
    const c = nodeCircleCenter(p);
    n.x = c.x;
    n.y = c.y;
    n.vx = 0;
    n.vy = 0;
  }
}

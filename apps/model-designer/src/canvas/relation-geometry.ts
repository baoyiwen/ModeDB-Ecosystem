import type { EngineRelationEdge } from '../types/engine-schema.js';
import { NODE_RADIUS } from './node-geometry.js';

/** 与 {@link hit-test.PlacedNode} 布局一致即可 */
export type PlacedLike = { x: number; y: number };

/** 多条平行关系（同一对端点）之间的槽位间距，单位：世界坐标像素。 */
const PAIR_GAP = 18;
/**
 * **同一关系**的正/逆向两条线在其 slot 内的左右偏移；为避免两条线视觉合并，必须 < `PAIR_GAP / 2`。
 * 用于 `paint-scene` 渲染时 forward 取 `slot + INTRA_PAIR_GAP`、reverse 取 `slot - INTRA_PAIR_GAP`。
 */
export const RELATION_INTRA_PAIR_GAP = 6;

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

/**
 * 自关联「帽子」的一圈檐带：**纯圆弧**，两端 `(x1,y1)`、`(x2,y2)` 均在节点圆边上，
 * 劣弧经过 slot 方向外侧顶点（无径向直线）。圆心 `(cx,cy)`、半径 `radius` 由三点外接圆决定。
 */
export interface SelfLoopArc {
  /** 弧所在圆的圆心。 */
  cx: number;
  cy: number;
  /** 弧所在圆的半径。 */
  radius: number;
  startAngle: number;
  endAngle: number;
  counterclockwise: boolean;
  /** 起点（节点圆边）。 */
  x1: number;
  y1: number;
  /** 终点（节点圆边）。 */
  x2: number;
  y2: number;
  arrowX: number;
  arrowY: number;
  ux: number;
  uy: number;
  labelX: number;
  labelY: number;
}

/**
 * 自关联「帽子」：内檐（reverse）+ 外顶（forward）两圈同向纯圆弧，
 * 正/逆在节点圆边上错开落点，箭头分置帽檐两侧。
 */
export interface SelfLoopGeometry {
  forward: SelfLoopArc;
  reverse: SelfLoopArc;
}

/** 同一节点上多条自关联在节点四周均匀分布；slot 0 = 帽子扣在节点正上方。 */
const HAT_SLOT_STEP = Math.PI / 3;
/** 帽檐在节点圆上的半张角（总张角 ≈ 120°）。 */
const HAT_ATTACH_HALF = Math.PI / 3;
/** 内檐相对节点圆边的径向外扩（px）。 */
const HAT_INNER_LIFT = 28;
/** 内外两圈檐带的径向间距（px）。 */
const HAT_BAND_GAP = 20;
/** 外顶相对节点圆边的径向外扩（px）。 */
const HAT_OUTER_LIFT = HAT_INNER_LIFT + HAT_BAND_GAP;
/** 外顶标签沿弧鼓出方向的额外偏移（px）。 */
const HAT_OUTER_LABEL_PAD = 10;

/** 弧段中点角度（与 Canvas `ctx.arc` 的 anticlockwise 参数同约定）。 */
function arcMidAngle(startAngle: number, endAngle: number, anticlockwise: boolean): number {
  if (!anticlockwise) {
    let span = endAngle - startAngle;
    if (span <= 0) span += Math.PI * 2;
    return startAngle + span / 2;
  }
  let span = startAngle - endAngle;
  if (span <= 0) span += Math.PI * 2;
  return startAngle - span / 2;
}

function arcPeakPoint(arc: SelfLoopArc): { x: number; y: number } {
  const mid = arcMidAngle(arc.startAngle, arc.endAngle, arc.counterclockwise);
  return {
    x: arc.cx + arc.radius * Math.cos(mid),
    y: arc.cy + arc.radius * Math.sin(mid),
  };
}

/** 判断角度是否落在弧段内（与 Canvas `ctx.arc` 同约定）。 */
function angleInArcSweep(
  angle: number,
  startAngle: number,
  endAngle: number,
  anticlockwise: boolean,
): boolean {
  const norm = (t: number): number => {
    let x = t;
    while (x <= -Math.PI) x += Math.PI * 2;
    while (x > Math.PI) x -= Math.PI * 2;
    return x;
  };
  const na = norm(angle);
  const n1 = norm(startAngle);
  const n2 = norm(endAngle);
  if (!anticlockwise) {
    if (n1 <= n2) return na >= n1 && na <= n2;
    return na >= n1 || na <= n2;
  }
  if (n1 >= n2) return na <= n1 && na >= n2;
  return na <= n1 || na >= n2;
}

/**
 * p1→p2 有两条弧，取弧顶离节点中心更远的那条（外檐，鼓向 slot 外侧而非圆心）。
 */
function pickOutwardArcSweep(
  c: { x: number; y: number },
  acx: number,
  acy: number,
  radius: number,
  startAngle: number,
  endAngle: number,
): boolean {
  let bestAnticlockwise = false;
  let bestPeakDist = -Infinity;
  for (const anticlockwise of [false, true]) {
    const mid = arcMidAngle(startAngle, endAngle, anticlockwise);
    const peakDist = Math.hypot(
      acx + radius * Math.cos(mid) - c.x,
      acy + radius * Math.sin(mid) - c.y,
    );
    if (peakDist > bestPeakDist) {
      bestPeakDist = peakDist;
      bestAnticlockwise = anticlockwise;
    }
  }
  return bestAnticlockwise;
}

/** 对称帽檐：圆心在 slot 轴上、位于节点内侧，弧顶在 slot 外侧。 */
function hatArcCenter(
  c: { x: number; y: number },
  phi: number,
  lift: number,
): { x: number; y: number; r: number } {
  const cosHalf = Math.cos(HAT_ATTACH_HALF);
  const d =
    (lift * lift + 2 * NODE_RADIUS * lift) / (2 * (NODE_RADIUS + lift - NODE_RADIUS * cosHalf));
  const acx = c.x + d * Math.cos(phi);
  const acy = c.y + d * Math.sin(phi);
  const r = NODE_RADIUS + lift - d;
  return { x: acx, y: acy, r };
}

/** 弧顶 + 沿节点中心→弧顶方向外推，标签与帽檐同侧。 */
function labelOnHatBulge(
  arc: SelfLoopArc,
  c: { x: number; y: number },
  extraOffset: number,
): { x: number; y: number } {
  const peak = arcPeakPoint(arc);
  const dx = peak.x - c.x;
  const dy = peak.y - c.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) {
    return peak;
  }
  const scale = (len + extraOffset) / len;
  return { x: c.x + dx * scale, y: c.y + dy * scale };
}

/**
 * 帽子的一圈檐带：端点落在节点圆边 `startBrimAngle` → `endBrimAngle`，弧顶在 slot 外侧。
 * `lift` 为檐顶相对节点圆边的径向外扩（内檐 / 外顶仅改此值，间距 ≈ `HAT_BAND_GAP`）。
 */
function buildHatBand(
  c: { x: number; y: number },
  phi: number,
  lift: number,
  labelOffset: number,
  startBrimAngle: number,
  endBrimAngle: number,
): SelfLoopArc {
  const x1 = c.x + NODE_RADIUS * Math.cos(startBrimAngle);
  const y1 = c.y + NODE_RADIUS * Math.sin(startBrimAngle);
  const x2 = c.x + NODE_RADIUS * Math.cos(endBrimAngle);
  const y2 = c.y + NODE_RADIUS * Math.sin(endBrimAngle);

  const { x: acx, y: acy, r } = hatArcCenter(c, phi, lift);

  const startAngle = Math.atan2(y1 - acy, x1 - acx);
  const endAngle = Math.atan2(y2 - acy, x2 - acx);
  const counterclockwise = pickOutwardArcSweep(c, acx, acy, r, startAngle, endAngle);

  // 箭头切线沿帽檐弧；箭尖落在节点圆 attach 点（与弧终点同一点）。
  const ux = counterclockwise ? Math.sin(endAngle) : -Math.sin(endAngle);
  const uy = counterclockwise ? -Math.cos(endAngle) : Math.cos(endAngle);

  const arc: SelfLoopArc = {
    cx: acx,
    cy: acy,
    radius: r,
    startAngle,
    endAngle,
    counterclockwise,
    x1,
    y1,
    x2,
    y2,
    arrowX: x2,
    arrowY: y2,
    ux,
    uy,
    labelX: 0,
    labelY: 0,
  };
  const label = labelOnHatBulge(arc, c, labelOffset);
  arc.labelX = label.x;
  arc.labelY = label.y;
  return arc;
}

/** 点到自关联纯圆弧的最近距离。 */
export function distancePointToSelfLoopArc(px: number, py: number, arc: SelfLoopArc): number {
  const ang = Math.atan2(py - arc.cy, px - arc.cx);
  const radial = Math.hypot(px - arc.cx, py - arc.cy);
  if (angleInArcSweep(ang, arc.startAngle, arc.endAngle, arc.counterclockwise)) {
    return Math.abs(radial - arc.radius);
  }
  return Math.min(Math.hypot(px - arc.x1, py - arc.y1), Math.hypot(px - arc.x2, py - arc.y2));
}

/** @deprecated 使用 {@link distancePointToSelfLoopArc} */
export const distancePointToSelfLoopRing = distancePointToSelfLoopArc;

/** 自关联「帽子」几何：slot 决定帽子扣在节点哪一侧（0 = 正上方）。 */
export function selfLoopGeometry(node: PlacedLike, slotIndex: number): SelfLoopGeometry {
  const c = nodeCircleCenter(node);
  const phi = -Math.PI / 2 + slotIndex * HAT_SLOT_STEP;
  const a1 = phi - HAT_ATTACH_HALF;
  const a2 = phi + HAT_ATTACH_HALF;
  // forward：左檐→右檐；reverse：右檐→左檐。attach 角精确落在节点圆上，箭头分置两侧。
  const forward = buildHatBand(c, phi, HAT_OUTER_LIFT, HAT_OUTER_LABEL_PAD, a1, a2);
  const reverse = buildHatBand(c, phi, HAT_INNER_LIFT, 0, a2, a1);
  // 内檐标签：内外檐顶连线中点（与帽檐同侧、位于两圈之间）。
  const innerLabel = labelOnHatBulge(reverse, c, 0);
  const outerLabel = labelOnHatBulge(forward, c, 0);
  reverse.labelX = (innerLabel.x + outerLabel.x) / 2;
  reverse.labelY = (innerLabel.y + outerLabel.y) / 2;
  return { forward, reverse };
}

/** 同一节点上的多条自关联按 id 字典序分配槽位（与 `edgePerpOffsetById` 平行的稳定排序）。 */
export function edgeSelfLoopSlotById(
  relations: readonly EngineRelationEdge[],
): Map<string, number> {
  const groups = new Map<string, EngineRelationEdge[]>();
  for (const r of relations) {
    if (r.source_model_id !== r.target_model_id) {
      continue;
    }
    const k = r.source_model_id;
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
    for (let i = 0; i < sorted.length; i++) {
      out.set(sorted[i].id, i);
    }
  }
  return out;
}

/**
 * 三次贝塞尔曲线上"点到曲线"的近似距离：把曲线均匀采样为多个线段，逐段调用
 * {@link distancePointToSegment} 取最小值。采样数足够大时与解析解视觉等价。
 */
export function distancePointToCubicBezier(
  px: number,
  py: number,
  x1: number,
  y1: number,
  cpx1: number,
  cpy1: number,
  cpx2: number,
  cpy2: number,
  x2: number,
  y2: number,
  samples = 14,
): number {
  let prevX = x1;
  let prevY = y1;
  let best = Infinity;
  for (let i = 1; i <= samples; i++) {
    const t = i / samples;
    const u = 1 - t;
    const tt = t * t;
    const uu = u * u;
    const uuu = uu * u;
    const ttt = tt * t;
    const x = uuu * x1 + 3 * uu * t * cpx1 + 3 * u * tt * cpx2 + ttt * x2;
    const y = uuu * y1 + 3 * uu * t * cpy1 + 3 * u * tt * cpy2 + ttt * y2;
    const d = distancePointToSegment(px, py, prevX, prevY, x, y);
    if (d < best) {
      best = d;
    }
    prevX = x;
    prevY = y;
  }
  return best;
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

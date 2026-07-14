import type { EngineRelationEdge } from '../types/engine-schema.js';
import { NODE_RADIUS } from './node-geometry.js';

/** 与 {@link hit-test.PlacedNode} 布局一致即可 */
export type PlacedLike = { x: number; y: number };

/** 多条平行关系（同一对端点）之间的槽位间距，单位：世界坐标像素。 */
const PAIR_GAP = 32;
/**
 * **同一关系**的正/逆向两条线在其 slot 内的左右偏移；为避免两条线视觉合并，必须 < `PAIR_GAP / 2`。
 * 用于 `paint-scene` 渲染时 forward 取 `slot + INTRA_PAIR_GAP`、reverse 取 `slot - INTRA_PAIR_GAP`。
 */
export const RELATION_INTRA_PAIR_GAP = 10;

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

/** 带可选二次贝塞尔弯曲的有向线段。 */
export interface CurvedDirectedSegment extends DirectedSegment {
  cpx: number;
  cpy: number;
  bent: boolean;
}

const BEND_EPS = 4;

export interface RelationLabelPlacement {
  x: number;
  y: number;
  /** 弧度；标签沿连线切线方向，且已校正为可读朝向。 */
  angle: number;
}

/** 使标签沿切线方向且文字不倒置。 */
export function normalizeLabelAngle(angle: number): number {
  if (angle > Math.PI / 2) {
    return angle - Math.PI;
  }
  if (angle < -Math.PI / 2) {
    return angle + Math.PI;
  }
  return angle;
}

/** 直线关系标签：落在线段中点，沿连线方向；弯曲时沿曲线 t=0.5 切线。 */
export function segmentLabelPlacement(
  seg: DirectedSegment | CurvedDirectedSegment,
): RelationLabelPlacement {
  if ('bent' in seg && seg.bent) {
    return curvedLabelPlacement(seg);
  }
  return {
    x: seg.midX,
    y: seg.midY,
    angle: normalizeLabelAngle(Math.atan2(seg.uy, seg.ux)),
  };
}

/** 弯曲关系标签：曲线中点 + 切线方向。 */
export function curvedLabelPlacement(seg: CurvedDirectedSegment): RelationLabelPlacement {
  const pt = quadraticPointAt(0.5, seg.x1, seg.y1, seg.cpx, seg.cpy, seg.x2, seg.y2);
  const tan = quadraticTangentAt(0.5, seg.x1, seg.y1, seg.cpx, seg.cpy, seg.x2, seg.y2);
  const len = Math.hypot(tan.x, tan.y);
  const ux = len < 1e-6 ? seg.ux : tan.x / len;
  const uy = len < 1e-6 ? seg.uy : tan.y / len;
  return {
    x: pt.x,
    y: pt.y,
    angle: normalizeLabelAngle(Math.atan2(uy, ux)),
  };
}

/** 自关联弧标签：沿弧在 (x,y) 处的切线方向。 */
export function arcLabelPlacement(arc: SelfLoopArc, x: number, y: number): RelationLabelPlacement {
  if (arc.cpx !== undefined && arc.cpy !== undefined) {
    const tan = quadraticTangentAt(0.5, arc.x1, arc.y1, arc.cpx, arc.cpy, arc.x2, arc.y2);
    return { x, y, angle: normalizeLabelAngle(Math.atan2(tan.y, tan.x)) };
  }
  const radial = Math.atan2(y - arc.cy, x - arc.cx);
  const tangent = arc.counterclockwise ? radial + Math.PI / 2 : radial - Math.PI / 2;
  return { x, y, angle: normalizeLabelAngle(tangent) };
}

/**
 * 圆上离世界点最近的一点（在圆边界上）。
 */
export function circlePointClosestTo(
  cx: number,
  cy: number,
  radius: number,
  px: number,
  py: number,
): { x: number; y: number } {
  const dx = px - cx;
  const dy = py - cy;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) {
    return { x: cx + radius, y: cy };
  }
  const s = radius / len;
  return { x: cx + dx * s, y: cy + dy * s };
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

/** 带可选二次贝塞尔弯曲的有向线段（`bend` 为锚点/控制点，端点贴在圆上离锚点最近处）。 */
export function directedCurvedSegment(
  source: PlacedLike,
  target: PlacedLike,
  perpOffset: number,
  bend?: { x: number; y: number } | null,
): CurvedDirectedSegment {
  const base = directedShortestSegment(source, target, perpOffset);
  if (!bend) {
    return { ...base, cpx: base.midX, cpy: base.midY, bent: false };
  }
  const dist = Math.hypot(bend.x - base.midX, bend.y - base.midY);
  return buildCurvedSegmentToAnchor(source, target, perpOffset, bend, dist >= BEND_EPS);
}

function buildCurvedSegmentToAnchor(
  source: PlacedLike,
  target: PlacedLike,
  perpOffset: number,
  anchor: { x: number; y: number },
  bent: boolean,
): CurvedDirectedSegment {
  const cs = nodeCircleCenter(source);
  const ct = nodeCircleCenter(target);
  let dx = ct.x - cs.x;
  let dy = ct.y - cs.y;
  const len = Math.hypot(dx, dy);
  const ux0 = len < 1e-6 ? 1 : dx / len;
  const uy0 = len < 1e-6 ? 0 : dy / len;
  const px = -uy0;
  const py = ux0;
  const ax = anchor.x + px * perpOffset;
  const ay = anchor.y + py * perpOffset;
  const p1 = circlePointClosestTo(cs.x, cs.y, NODE_RADIUS, ax, ay);
  const p2 = circlePointClosestTo(ct.x, ct.y, NODE_RADIUS, ax, ay);
  const x1 = p1.x;
  const y1 = p1.y;
  const x2 = p2.x;
  const y2 = p2.y;
  const cpx = ax;
  const cpy = ay;
  const mid = bent
    ? quadraticPointAt(0.5, x1, y1, cpx, cpy, x2, y2)
    : { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
  const tEnd = bent ? quadraticTangentAt(1, x1, y1, cpx, cpy, x2, y2) : { x: x2 - x1, y: y2 - y1 };
  const tLen = Math.hypot(tEnd.x, tEnd.y);
  const ux = tLen < 1e-6 ? ux0 : tEnd.x / tLen;
  const uy = tLen < 1e-6 ? uy0 : tEnd.y / tLen;
  return {
    x1,
    y1,
    x2,
    y2,
    ux,
    uy,
    midX: mid.x,
    midY: mid.y,
    cpx,
    cpy,
    bent,
  };
}

export function quadraticPointAt(
  t: number,
  x1: number,
  y1: number,
  cpx: number,
  cpy: number,
  x2: number,
  y2: number,
): { x: number; y: number } {
  const u = 1 - t;
  return {
    x: u * u * x1 + 2 * u * t * cpx + t * t * x2,
    y: u * u * y1 + 2 * u * t * cpy + t * t * y2,
  };
}

export function quadraticTangentAt(
  t: number,
  x1: number,
  y1: number,
  cpx: number,
  cpy: number,
  x2: number,
  y2: number,
): { x: number; y: number } {
  return {
    x: 2 * (1 - t) * (cpx - x1) + 2 * t * (x2 - cpx),
    y: 2 * (1 - t) * (cpy - y1) + 2 * t * (y2 - cpy),
  };
}

/** 二次贝塞尔曲线到点的近似距离。 */
export function distancePointToQuadraticBezier(
  px: number,
  py: number,
  x1: number,
  y1: number,
  cpx: number,
  cpy: number,
  x2: number,
  y2: number,
  samples = 14,
): number {
  let prevX = x1;
  let prevY = y1;
  let best = Infinity;
  for (let i = 1; i <= samples; i++) {
    const t = i / samples;
    const pt = quadraticPointAt(t, x1, y1, cpx, cpy, x2, y2);
    const d = distancePointToSegment(px, py, prevX, prevY, pt.x, pt.y);
    if (d < best) {
      best = d;
    }
    prevX = pt.x;
    prevY = pt.y;
  }
  return best;
}

/** 预览：从源节点圆上指向世界点的一条射线（到鼠标）。 */
export function segmentFromNodeTowardPoint(
  source: PlacedLike,
  worldX: number,
  worldY: number,
): DirectedSegment {
  const cs = nodeCircleCenter(source);
  const p1 = circlePointClosestTo(cs.x, cs.y, NODE_RADIUS, worldX, worldY);
  const dx0 = worldX - p1.x;
  const dy0 = worldY - p1.y;
  const len = Math.hypot(dx0, dy0);
  const ux = len < 1e-6 ? 1 : dx0 / len;
  const uy = len < 1e-6 ? 0 : dy0 / len;
  return {
    x1: p1.x,
    y1: p1.y,
    x2: worldX,
    y2: worldY,
    ux,
    uy,
    midX: (p1.x + worldX) / 2,
    midY: (p1.y + worldY) / 2,
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
  cpx?: number;
  cpy?: number;
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
function buildBezierLoopBand(
  c: { x: number; y: number },
  startBrimAngle: number,
  endBrimAngle: number,
  control: { x: number; y: number },
): SelfLoopArc {
  const x1 = c.x + NODE_RADIUS * Math.cos(startBrimAngle);
  const y1 = c.y + NODE_RADIUS * Math.sin(startBrimAngle);
  const x2 = c.x + NODE_RADIUS * Math.cos(endBrimAngle);
  const y2 = c.y + NODE_RADIUS * Math.sin(endBrimAngle);
  const tan = quadraticTangentAt(1, x1, y1, control.x, control.y, x2, y2);
  const len = Math.hypot(tan.x, tan.y);
  const ux = len < 1e-6 ? Math.cos(endBrimAngle) : tan.x / len;
  const uy = len < 1e-6 ? Math.sin(endBrimAngle) : tan.y / len;
  const label = quadraticPointAt(0.5, x1, y1, control.x, control.y, x2, y2);
  return {
    cx: control.x,
    cy: control.y,
    radius: 0,
    startAngle: 0,
    endAngle: 0,
    counterclockwise: false,
    x1,
    y1,
    x2,
    y2,
    arrowX: x2,
    arrowY: y2,
    ux,
    uy,
    labelX: label.x,
    labelY: label.y,
    cpx: control.x,
    cpy: control.y,
  };
}

export function distancePointToSelfLoopArc(px: number, py: number, arc: SelfLoopArc): number {
  if (arc.cpx !== undefined && arc.cpy !== undefined) {
    return distancePointToQuadraticBezier(px, py, arc.x1, arc.y1, arc.cpx, arc.cpy, arc.x2, arc.y2);
  }
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
export function selfLoopDefaultAnchor(
  node: PlacedLike,
  slotIndex: number,
): { x: number; y: number } {
  const c = nodeCircleCenter(node);
  const phi = -Math.PI / 2 + slotIndex * HAT_SLOT_STEP;
  const distance = NODE_RADIUS + HAT_OUTER_LIFT + 22;
  return {
    x: c.x + Math.cos(phi) * distance,
    y: c.y + Math.sin(phi) * distance,
  };
}

export function selfLoopGeometry(
  node: PlacedLike,
  slotIndex: number,
  anchor?: { x: number; y: number } | null,
): SelfLoopGeometry {
  const c = nodeCircleCenter(node);
  const defaultAnchor = selfLoopDefaultAnchor(node, slotIndex);
  const anchorDx = (anchor ?? defaultAnchor).x - c.x;
  const anchorDy = (anchor ?? defaultAnchor).y - c.y;
  const anchorDistance = Math.hypot(anchorDx, anchorDy);
  const phi =
    anchor && anchorDistance > 1e-6
      ? Math.atan2(anchorDy, anchorDx)
      : Math.atan2(defaultAnchor.y - c.y, defaultAnchor.x - c.x);
  const outerLift = Math.max(HAT_OUTER_LIFT, Math.min(360, anchorDistance - NODE_RADIUS - 22));
  const innerLift = Math.max(HAT_INNER_LIFT, outerLift - HAT_BAND_GAP);
  const a1 = phi - HAT_ATTACH_HALF;
  const a2 = phi + HAT_ATTACH_HALF;
  if (anchor && anchorDistance > 1e-6) {
    const ux = Math.cos(phi);
    const uy = Math.sin(phi);
    const outerDistance = Math.max(NODE_RADIUS + HAT_OUTER_LIFT + 22, anchorDistance);
    const innerDistance = Math.max(
      NODE_RADIUS + HAT_INNER_LIFT + 14,
      outerDistance - HAT_BAND_GAP * 1.8,
    );
    const forward = buildBezierLoopBand(c, a1, a2, {
      x: c.x + ux * outerDistance,
      y: c.y + uy * outerDistance,
    });
    const reverse = buildBezierLoopBand(c, a2, a1, {
      x: c.x + ux * innerDistance,
      y: c.y + uy * innerDistance,
    });
    return { forward, reverse };
  }
  // forward：左檐→右檐；reverse：右檐→左檐。attach 角精确落在节点圆上，箭头分置两侧。
  const forward = buildHatBand(c, phi, outerLift, HAT_OUTER_LABEL_PAD, a1, a2);
  const reverse = buildHatBand(c, phi, innerLift, 0, a2, a1);
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

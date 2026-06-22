import { NODE_RADIUS } from './node-geometry.js';
import { nodeCircleCenter } from './relation-geometry.js';

/** 对齐线：圆切线 / 圆心线 / 等距段。 */
export type SnapGuideKind = 'tangent-min' | 'tangent-max' | 'center' | 'equal-gap';

export interface SnapGuide {
  axis: 'x' | 'y';
  value: number;
  kind: SnapGuideKind;
  active?: boolean;
  segMin?: number;
  segMax?: number;
  /** 等距段：相邻圆在底线上的投影净间距（世界 px）。 */
  gapSize?: number;
}

export interface SnapPeer {
  id: string;
  cx: number;
  cy: number;
}

export interface SnapWorldPointOptions {
  gridSize: number;
  snapGrid: boolean;
  snapAlign: boolean;
  showTripleLineGuides: boolean;
  threshold: number;
  /** 圆心视为「在同一条线」上的容差（世界 px）。 */
  lineThreshold: number;
  gapEqualEps: number;
}

export interface SnapWorldPointResult {
  x: number;
  y: number;
  guides: SnapGuide[];
}

interface AxisSnapCandidate {
  center: number;
  dist: number;
  guides: SnapGuide[];
}

interface Point2 {
  cx: number;
  cy: number;
}

function quantizeGuideValue(v: number): string {
  return (Math.round(v * 1000) / 1000).toString();
}

/** 同一轴、同一世界坐标只保留一根线（圆心线优先于切线）。 */
function guideDisplayKey(g: SnapGuide): string {
  if (g.kind === 'equal-gap') {
    return `eq:${g.axis}:${quantizeGuideValue(g.value)}:${g.segMin}:${g.segMax}`;
  }
  return `${g.axis}:${quantizeGuideValue(g.value)}`;
}

function guideDisplayPriority(g: SnapGuide): number {
  let score = 0;
  if (g.active) {
    score += 100;
  }
  if (g.kind === 'center') {
    score += 30;
  } else if (g.kind === 'equal-gap') {
    score += 20;
  }
  return score;
}

function mergeGuides(...lists: SnapGuide[][]): SnapGuide[] {
  const map = new Map<string, SnapGuide>();
  for (const list of lists) {
    for (const g of list) {
      const k = guideDisplayKey(g);
      const prev = map.get(k);
      if (!prev || guideDisplayPriority(g) > guideDisplayPriority(prev)) {
        map.set(k, g);
      }
    }
  }
  return [...map.values()];
}

/** 每个轴最多一根圆心线；水平+垂直同时对齐时全局只保留最近的一根。 */
function retainCenterGuides(
  guides: SnapGuide[],
  cx: number,
  cy: number,
  crossAxisAligned: boolean,
): SnapGuide[] {
  const rest = guides.filter((g) => g.kind !== 'center');
  const centers = guides.filter((g) => g.kind === 'center');
  if (centers.length === 0) {
    return guides;
  }
  if (crossAxisAligned) {
    let best = centers[0]!;
    let bestD = best.axis === 'y' ? Math.abs(best.value - cy) : Math.abs(best.value - cx);
    for (let i = 1; i < centers.length; i++) {
      const g = centers[i]!;
      const d = g.axis === 'y' ? Math.abs(g.value - cy) : Math.abs(g.value - cx);
      if (d < bestD) {
        best = g;
        bestD = d;
      }
    }
    return [...rest, best];
  }
  let bestY: SnapGuide | undefined;
  let bestX: SnapGuide | undefined;
  for (const g of centers) {
    if (g.axis === 'y') {
      const d = Math.abs(g.value - cy);
      if (!bestY || d < Math.abs(bestY.value - cy)) {
        bestY = g;
      }
    } else {
      const d = Math.abs(g.value - cx);
      if (!bestX || d < Math.abs(bestX.value - cx)) {
        bestX = g;
      }
    }
  }
  return [...rest, ...(bestY ? [bestY] : []), ...(bestX ? [bestX] : [])];
}

function pickBestCandidate(
  rawCenter: number,
  candidates: AxisSnapCandidate[],
  threshold: number,
): { center: number; guides: SnapGuide[] } {
  let best: AxisSnapCandidate | undefined;
  for (const c of candidates) {
    if (c.dist > threshold) {
      continue;
    }
    if (
      !best ||
      c.dist < best.dist ||
      (c.dist === best.dist && c.guides.length > best.guides.length)
    ) {
      best = c;
    }
  }
  if (!best) {
    return { center: rawCenter, guides: [] };
  }
  return {
    center: best.center,
    guides: best.guides.map((g) => ({ ...g, active: true })),
  };
}

function interval(min: number, max: number): { min: number; max: number } {
  return { min, max };
}

function projX(p: Point2 | SnapPeer): { min: number; max: number } {
  return interval(p.cx - NODE_RADIUS, p.cx + NODE_RADIUS);
}

function projY(p: Point2 | SnapPeer): { min: number; max: number } {
  return interval(p.cy - NODE_RADIUS, p.cy + NODE_RADIUS);
}

/** 两区间在轴上的投影是否相交。 */
function projectionsOverlap(
  a: { min: number; max: number },
  b: { min: number; max: number },
): boolean {
  return a.min <= b.max && b.min <= a.max;
}

/** 圆心在同一条水平/垂直线上（含小容差）。 */
function onSameHorizontalLine(cy: number, pcy: number, lineThreshold: number): boolean {
  return Math.abs(cy - pcy) <= lineThreshold;
}

function onSameVerticalLine(cx: number, pcx: number, lineThreshold: number): boolean {
  return Math.abs(cx - pcx) <= lineThreshold;
}

/**
 * 水平方向共线：Y 轴投影相交，或圆心在同一水平线上。
 * 满足则显示该参照节点的横向三线（水平定位线）。
 */
function horizontallyAligned(cy: number, peer: SnapPeer, lineThreshold: number): boolean {
  return (
    projectionsOverlap(projY({ cx: 0, cy }), projY(peer)) ||
    onSameHorizontalLine(cy, peer.cy, lineThreshold)
  );
}

/**
 * 垂直方向共线：X 轴投影相交，或圆心在同一垂直线上。
 * 满足则显示该参照节点的竖向三线（垂直定位线）。
 */
function verticallyAligned(cx: number, peer: SnapPeer, lineThreshold: number): boolean {
  return (
    projectionsOverlap(projX({ cx, cy: 0 }), projX(peer)) ||
    onSameVerticalLine(cx, peer.cx, lineThreshold)
  );
}

function filterPeersExcluding(
  peers: readonly SnapPeer[],
  excludeId: string | undefined,
): SnapPeer[] {
  return peers.filter((p) => !excludeId || p.id !== excludeId);
}

function peersForHorizontalGuides(
  cy: number,
  peers: readonly SnapPeer[],
  excludeId: string | undefined,
  lineThreshold: number,
): SnapPeer[] {
  return filterPeersExcluding(peers, excludeId).filter((p) =>
    horizontallyAligned(cy, p, lineThreshold),
  );
}

function peersForVerticalGuides(
  cx: number,
  peers: readonly SnapPeer[],
  excludeId: string | undefined,
  lineThreshold: number,
): SnapPeer[] {
  return filterPeersExcluding(peers, excludeId).filter((p) =>
    verticallyAligned(cx, p, lineThreshold),
  );
}

function peerTripleLines(peer: SnapPeer, axis: 'x' | 'y', active: boolean): SnapGuide[] {
  const c = axis === 'x' ? peer.cx : peer.cy;
  const r = NODE_RADIUS;
  return [
    { axis, value: c - r, kind: 'tangent-min', active },
    { axis, value: c, kind: 'center', active },
    { axis, value: c + r, kind: 'tangent-max', active },
  ];
}

/** 水平对齐：上/下切线与圆心的三条水平线（axis=y）。 */
function collectHorizontalTripleGuides(aligned: readonly SnapPeer[]): SnapGuide[] {
  const out: SnapGuide[] = [];
  for (const p of aligned) {
    out.push(...peerTripleLines(p, 'y', false));
  }
  return out;
}

/** 垂直对齐：左/右切线与圆心的三条垂直线（axis=x）。 */
function collectVerticalTripleGuides(aligned: readonly SnapPeer[]): SnapGuide[] {
  const out: SnapGuide[] = [];
  for (const p of aligned) {
    out.push(...peerTripleLines(p, 'x', false));
  }
  return out;
}

function snapCenterOnAxis(
  center: number,
  radius: number,
  peers: readonly SnapPeer[],
  threshold: number,
  axis: 'x' | 'y',
): { center: number; guides: SnapGuide[] } {
  const coord = axis === 'x' ? (p: SnapPeer) => p.cx : (p: SnapPeer) => p.cy;
  const candidates: AxisSnapCandidate[] = [];

  for (const p of peers) {
    const P = coord(p);
    const peerMin = P - radius;
    const peerMax = P + radius;
    const selfMin = center - radius;
    const selfMax = center + radius;

    const pushTangent = (
      targetCenter: number,
      edgeDist: number,
      lineValue: number,
      kind: SnapGuideKind,
    ): void => {
      candidates.push({
        center: targetCenter,
        dist: edgeDist,
        guides: [{ axis, value: lineValue, kind, active: true }],
      });
    };

    pushTangent(P, Math.abs(selfMin - peerMin), peerMin, 'tangent-min');
    pushTangent(P, Math.abs(selfMax - peerMax), peerMax, 'tangent-max');
    pushTangent(P + 2 * radius, Math.abs(selfMin - peerMax), peerMax, 'tangent-max');
    pushTangent(P - 2 * radius, Math.abs(selfMax - peerMin), peerMin, 'tangent-min');

    const dMin = Math.abs(selfMin - peerMin);
    const dMid = Math.abs(center - P);
    const dMax = Math.abs(selfMax - peerMax);

    if (dMid <= threshold) {
      candidates.push({
        center: P,
        dist: dMid,
        guides: [{ axis, value: P, kind: 'center', active: true }],
      });
    }

    if (dMin <= threshold && dMid <= threshold && dMax <= threshold) {
      candidates.push({
        center: P,
        dist: dMid,
        guides: [
          { axis, value: peerMin, kind: 'tangent-min', active: true },
          { axis, value: P, kind: 'center', active: true },
          { axis, value: peerMax, kind: 'tangent-max', active: true },
        ],
      });
    }
  }

  return pickBestCandidate(center, candidates, threshold);
}

function gapsAreUniform(gaps: number[], eps: number): boolean {
  if (gaps.length < 2) {
    return false;
  }
  const g0 = gaps[0]!;
  const scale = Math.max(Math.abs(g0), 1);
  return gaps.every((g) => Math.abs(g - g0) <= eps || Math.abs(g - g0) / scale <= 0.04);
}

/** 水平底线：相邻圆在 X 轴投影之间的净间距。 */
function projectionGapsX(sorted: readonly Point2[]): number[] {
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const left = sorted[i - 1]!;
    const right = sorted[i]!;
    gaps.push(projX(right).min - projX(left).max);
  }
  return gaps;
}

/** 垂直底线：相邻圆在 Y 轴投影之间的净间距。 */
function projectionGapsY(sorted: readonly Point2[]): number[] {
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const top = sorted[i - 1]!;
    const bottom = sorted[i]!;
    gaps.push(projY(bottom).min - projY(top).max);
  }
  return gaps;
}

function gapSegment(
  axis: 'x' | 'y',
  lineValue: number,
  a: Point2,
  b: Point2,
  gapSize: number,
): SnapGuide {
  if (axis === 'y') {
    let segMin = a.cx + NODE_RADIUS;
    let segMax = b.cx - NODE_RADIUS;
    if (segMax <= segMin) {
      const mid = (a.cx + b.cx) / 2;
      segMin = mid - 12;
      segMax = mid + 12;
    }
    return {
      axis: 'y',
      value: lineValue,
      kind: 'equal-gap',
      segMin,
      segMax,
      gapSize,
      active: true,
    };
  }
  let segMin = a.cy + NODE_RADIUS;
  let segMax = b.cy - NODE_RADIUS;
  if (segMax <= segMin) {
    const mid = (a.cy + b.cy) / 2;
    segMin = mid - 12;
    segMax = mid + 12;
  }
  return {
    axis: 'x',
    value: lineValue,
    kind: 'equal-gap',
    segMin,
    segMax,
    gapSize,
    active: true,
  };
}

function equalSpacingForRow(row: Point2[], lineY: number, gapEps: number): SnapGuide[] {
  if (row.length < 3) {
    return [];
  }
  const sorted = [...row].sort((a, b) => a.cx - b.cx);
  const gaps = projectionGapsX(sorted);
  if (gaps.length < 2 || gaps.some((g) => g < -gapEps)) {
    return [];
  }
  if (!gapsAreUniform(gaps, gapEps)) {
    return [];
  }
  const out: SnapGuide[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    out.push(gapSegment('y', lineY, sorted[i]!, sorted[i + 1]!, gaps[i]!));
  }
  return out;
}

function equalSpacingForCol(col: Point2[], lineX: number, gapEps: number): SnapGuide[] {
  if (col.length < 3) {
    return [];
  }
  const sorted = [...col].sort((a, b) => a.cy - b.cy);
  const gaps = projectionGapsY(sorted);
  if (gaps.length < 2 || gaps.some((g) => g < -gapEps)) {
    return [];
  }
  if (!gapsAreUniform(gaps, gapEps)) {
    return [];
  }
  const out: SnapGuide[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    out.push(gapSegment('x', lineX, sorted[i]!, sorted[i + 1]!, gaps[i]!));
  }
  return out;
}

/** 按投影相交聚类（并查集）。 */
function clusterByProjectionOverlap(
  points: Point2[],
  overlap: (a: Point2, b: Point2) => boolean,
): Point2[][] {
  const n = points.length;
  if (n === 0) {
    return [];
  }
  const parent = points.map((_, i) => i);
  const find = (i: number): number => {
    if (parent[i] !== i) {
      parent[i] = find(parent[i]!);
    }
    return parent[i]!;
  };
  const unite = (i: number, j: number): void => {
    const ri = find(i);
    const rj = find(j);
    if (ri !== rj) {
      parent[ri] = rj;
    }
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (overlap(points[i]!, points[j]!)) {
        unite(i, j);
      }
    }
  }
  const groups = new Map<number, Point2[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const list = groups.get(r);
    if (list) {
      list.push(points[i]!);
    } else {
      groups.set(r, [points[i]!]);
    }
  }
  return [...groups.values()];
}

function yStripOverlap(a: Point2, b: Point2): boolean {
  return projectionsOverlap(projY(a), projY(b));
}

function xStripOverlap(a: Point2, b: Point2): boolean {
  return projectionsOverlap(projX(a), projX(b));
}

function collectEqualSpacingGuides(
  cx: number,
  cy: number,
  peers: readonly SnapPeer[],
  excludeId: string | undefined,
  gapEps: number,
): SnapGuide[] {
  const points: Point2[] = [{ cx, cy }];
  for (const p of filterPeersExcluding(peers, excludeId)) {
    points.push({ cx: p.cx, cy: p.cy });
  }
  if (points.length < 3) {
    return [];
  }

  const out: SnapGuide[] = [];
  const rowClusters = clusterByProjectionOverlap(points, yStripOverlap);
  for (const cluster of rowClusters) {
    if (cluster.length >= 3) {
      out.push(...equalSpacingForRow(cluster, cy, gapEps));
    }
  }
  const colClusters = clusterByProjectionOverlap(points, xStripOverlap);
  for (const cluster of colClusters) {
    if (cluster.length >= 3) {
      out.push(...equalSpacingForCol(cluster, cx, gapEps));
    }
  }
  return out;
}

export function snapWorldPoint(
  x: number,
  y: number,
  peers: readonly SnapPeer[],
  excludeId: string | undefined,
  opts: SnapWorldPointOptions,
): SnapWorldPointResult {
  const lineThreshold = opts.lineThreshold;
  const hAligned = peersForHorizontalGuides(y, peers, excludeId, lineThreshold);
  const vAligned = peersForVerticalGuides(x, peers, excludeId, lineThreshold);
  const hasAlignment = hAligned.length > 0 || vAligned.length > 0;

  let preview: SnapGuide[] = [];
  let equalGuides: SnapGuide[] = [];
  if (opts.showTripleLineGuides) {
    if (hasAlignment) {
      preview = mergeGuides(
        collectHorizontalTripleGuides(hAligned),
        collectVerticalTripleGuides(vAligned),
      );
    }
    equalGuides = collectEqualSpacingGuides(x, y, peers, excludeId, opts.gapEqualEps);
  }

  let cx = x;
  let cy = y;
  const snapGuides: SnapGuide[] = [];

  if (opts.snapGrid && opts.gridSize > 0) {
    const gx = Math.round(x / opts.gridSize) * opts.gridSize;
    const gy = Math.round(y / opts.gridSize) * opts.gridSize;
    if (Math.abs(gx - x) <= opts.threshold) {
      cx = gx;
      snapGuides.push({ axis: 'x', value: gx, kind: 'center', active: true });
    }
    if (Math.abs(gy - y) <= opts.threshold) {
      cy = gy;
      snapGuides.push({ axis: 'y', value: gy, kind: 'center', active: true });
    }
  }

  if (opts.snapAlign && hasAlignment) {
    const sy = snapCenterOnAxis(cy, NODE_RADIUS, hAligned, opts.threshold, 'y');
    const sx = snapCenterOnAxis(cx, NODE_RADIUS, vAligned, opts.threshold, 'x');
    cx = sx.center;
    cy = sy.center;
    snapGuides.push(...sy.guides, ...sx.guides);
  }

  const merged = mergeGuides(preview, equalGuides, snapGuides);
  const centers = merged.filter((g) => g.kind === 'center');
  const crossCenter = centers.some((g) => g.axis === 'y') && centers.some((g) => g.axis === 'x');
  return {
    x: cx,
    y: cy,
    guides: retainCenterGuides(merged, cx, cy, crossCenter),
  };
}

export function collectSnapPeers(
  modelIds: readonly string[],
  getPos: (id: string) => { x: number; y: number } | undefined,
): SnapPeer[] {
  const out: SnapPeer[] = [];
  for (const id of modelIds) {
    const p = getPos(id);
    if (!p) {
      continue;
    }
    const c = nodeCircleCenter(p);
    out.push({ id, cx: c.x, cy: c.y });
  }
  return out;
}

export function snapNodeTopLeft(
  modelId: string,
  proposedCenterX: number,
  proposedCenterY: number,
  peers: readonly SnapPeer[],
  opts: SnapWorldPointOptions,
): { position: { x: number; y: number }; guides: SnapGuide[] } {
  const snapped = snapWorldPoint(proposedCenterX, proposedCenterY, peers, modelId, opts);
  return {
    position: { x: snapped.x - NODE_RADIUS, y: snapped.y - NODE_RADIUS },
    guides: snapped.guides,
  };
}

export interface PaintSnapGuidesParams {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  panX: number;
  panY: number;
  zoom: number;
  guides: readonly SnapGuide[];
  tangentColor?: string;
  centerColor?: string;
  previewTangentColor?: string;
  equalGapColor?: string;
  dash?: number[];
}

function paintEqualGapGuide(
  ctx: CanvasRenderingContext2D,
  g: SnapGuide,
  zoom: number,
  strokeColor: string,
  fillColor: string,
): void {
  if (g.segMin == null || g.segMax == null) {
    return;
  }
  const segMin = g.segMin;
  const segMax = g.segMax;
  const cap = Math.max(7 / zoom, 5);
  const band = Math.max(10 / zoom, 7);
  const lw = Math.max(3 / zoom, 2);
  const mid = g.axis === 'y' ? (segMin + segMax) / 2 : (segMin + segMax) / 2;

  ctx.save();
  ctx.setLineDash([]);

  if (g.axis === 'y') {
    ctx.fillStyle = fillColor;
    ctx.fillRect(segMin, g.value - band / 2, segMax - segMin, band);
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(segMin, g.value);
    ctx.lineTo(segMax, g.value);
    ctx.stroke();
    ctx.lineWidth = Math.max(2 / zoom, 1.4);
    ctx.beginPath();
    ctx.moveTo(segMin, g.value - cap);
    ctx.lineTo(segMin, g.value + cap);
    ctx.moveTo(segMax, g.value - cap);
    ctx.lineTo(segMax, g.value + cap);
    ctx.moveTo(mid, g.value - cap * 0.65);
    ctx.lineTo(mid, g.value + cap * 0.65);
    ctx.stroke();
    if (g.gapSize != null && zoom >= 0.35) {
      const label = `${Math.round(g.gapSize)}`;
      const fontPx = Math.max(10 / zoom, 9);
      ctx.font = `600 ${fontPx}px system-ui, sans-serif`;
      ctx.fillStyle = strokeColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(label, mid, g.value - band / 2 - 2 / zoom);
    }
  } else {
    ctx.fillStyle = fillColor;
    ctx.fillRect(g.value - band / 2, segMin, band, segMax - segMin);
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(g.value, segMin);
    ctx.lineTo(g.value, segMax);
    ctx.stroke();
    ctx.lineWidth = Math.max(2 / zoom, 1.4);
    ctx.beginPath();
    ctx.moveTo(g.value - cap, segMin);
    ctx.lineTo(g.value + cap, segMin);
    ctx.moveTo(g.value - cap, segMax);
    ctx.lineTo(g.value + cap, segMax);
    ctx.moveTo(g.value - cap * 0.65, mid);
    ctx.lineTo(g.value + cap * 0.65, mid);
    ctx.stroke();
    if (g.gapSize != null && zoom >= 0.35) {
      const label = `${Math.round(g.gapSize)}`;
      const fontPx = Math.max(10 / zoom, 9);
      ctx.font = `600 ${fontPx}px system-ui, sans-serif`;
      ctx.fillStyle = strokeColor;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, g.value + band / 2 + 3 / zoom, mid);
    }
  }
  ctx.restore();
}

export function paintSnapGuides(params: PaintSnapGuidesParams): void {
  const { ctx, width, height, panX, panY, zoom, guides } = params;
  if (guides.length === 0) {
    return;
  }
  const wx0 = -panX / zoom;
  const wx1 = (width - panX) / zoom;
  const wy0 = -panY / zoom;
  const wy1 = (height - panY) / zoom;
  const xMin = Math.min(wx0, wx1);
  const xMax = Math.max(wx0, wx1);
  const yMin = Math.min(wy0, wy1);
  const yMax = Math.max(wy0, wy1);
  const tangentActive = params.tangentColor ?? 'rgba(37, 99, 235, 0.95)';
  const centerActive = params.centerColor ?? 'rgba(236, 72, 153, 0.95)';
  const tangentPreview = params.previewTangentColor ?? 'rgba(59, 130, 246, 0.42)';
  const equalGapColor = params.equalGapColor ?? 'rgba(5, 150, 105, 1)';
  const equalGapFill = 'rgba(16, 185, 129, 0.28)';
  const dashActive = params.dash ?? [5 / zoom, 4 / zoom];
  const dashPreview = [3 / zoom, 5 / zoom];
  const lwActive = Math.max(1.25 / zoom, 0.9);
  const lwPreview = Math.max(0.85 / zoom, 0.55);

  ctx.save();
  for (const g of guides) {
    if (g.kind === 'equal-gap' && g.segMin != null && g.segMax != null) {
      paintEqualGapGuide(ctx, g, zoom, equalGapColor, equalGapFill);
      continue;
    }

    const isCenter = g.kind === 'center';
    const active = g.active === true;
    ctx.strokeStyle = active ? (isCenter ? centerActive : tangentActive) : tangentPreview;
    ctx.lineWidth = active ? lwActive : lwPreview;
    ctx.setLineDash(active ? dashActive : dashPreview);
    ctx.beginPath();
    if (g.axis === 'x') {
      ctx.moveTo(g.value, yMin);
      ctx.lineTo(g.value, yMax);
    } else {
      ctx.moveTo(xMin, g.value);
      ctx.lineTo(xMax, g.value);
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.restore();
}

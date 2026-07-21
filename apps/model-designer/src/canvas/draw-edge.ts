import type {
  CurvedDirectedSegment,
  DirectedSegment,
  SelfLoopGeometry,
} from './relation-geometry.js';
import { quadraticTangentAt } from './relation-geometry.js';

/**
 * 有向边：直线或二次贝塞尔 + 终点箭头（查询方向指向 target）。
 */
export function drawDirectedRelation(
  ctx: CanvasRenderingContext2D,
  seg: DirectedSegment | CurvedDirectedSegment,
  color: string,
  lineWidth: number,
  arrowSize: number,
  dashed: boolean,
): void {
  if ('bent' in seg && seg.bent) {
    drawCurvedDirectedRelation(ctx, seg, color, lineWidth, arrowSize, dashed);
    return;
  }
  drawStraightDirectedRelation(ctx, seg, color, lineWidth, arrowSize, dashed);
}

function drawStraightDirectedRelation(
  ctx: CanvasRenderingContext2D,
  seg: DirectedSegment,
  color: string,
  lineWidth: number,
  arrowSize: number,
  dashed: boolean,
): void {
  const { x1, y1, x2, y2, ux, uy } = seg;
  const shorten = arrowSize * 1.05;
  const lx = x2 - ux * shorten;
  const ly = y2 - uy * shorten;
  // dash 也按 arrowSize 派生，与线宽 / 箭头共用同一套屏幕像素基准，保证虚线节拍恒定。
  const dash = arrowSize * 0.5;
  if (dashed) {
    drawStraightLineDashed(ctx, x1, y1, lx, ly, color, lineWidth, [dash, dash]);
  } else {
    drawStraightLine(ctx, x1, y1, lx, ly, color, lineWidth);
  }
  const px = -uy;
  const py = ux;
  const hw = arrowSize * 0.48;
  const bx = x2 - ux * arrowSize;
  const by = y2 - uy * arrowSize;
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(bx + px * hw, by + py * hw);
  ctx.lineTo(bx - px * hw, by - py * hw);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawCurvedDirectedRelation(
  ctx: CanvasRenderingContext2D,
  seg: CurvedDirectedSegment,
  color: string,
  lineWidth: number,
  arrowSize: number,
  dashed: boolean,
): void {
  const { x1, y1, x2, y2, cpx, cpy } = seg;
  const tan = quadraticTangentAt(1, x1, y1, cpx, cpy, x2, y2);
  const tLen = Math.hypot(tan.x, tan.y);
  const ux = tLen < 1e-6 ? seg.ux : tan.x / tLen;
  const uy = tLen < 1e-6 ? seg.uy : tan.y / tLen;
  const shorten = arrowSize * 1.05;
  const lx = x2 - ux * shorten;
  const ly = y2 - uy * shorten;
  const dash = arrowSize * 0.5;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.setLineDash(dashed ? [dash, dash] : []);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.quadraticCurveTo(cpx, cpy, lx, ly);
  ctx.stroke();
  ctx.setLineDash([]);

  const px = -uy;
  const py = ux;
  const hw = arrowSize * 0.48;
  const bx = x2 - ux * arrowSize;
  const by = y2 - uy * arrowSize;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(bx + px * hw, by + py * hw);
  ctx.lineTo(bx - px * hw, by - py * hw);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/**
 * 自关联「帽子」：内檐 + 外顶两圈纯圆弧，从节点圆边 p1 画到 p2。
 */
export function drawSelfLoop(
  ctx: CanvasRenderingContext2D,
  loop: SelfLoopGeometry,
  color: string,
  lineWidth: number,
  arrowSize: number,
  dashed: boolean,
): void {
  drawHatBand(ctx, loop.reverse, color, lineWidth, arrowSize, dashed);
  drawHatBand(ctx, loop.forward, color, lineWidth, arrowSize, dashed);
}

function drawHatBand(
  ctx: CanvasRenderingContext2D,
  band: SelfLoopGeometry['forward'],
  color: string,
  lineWidth: number,
  arrowSize: number,
  dashed: boolean,
): void {
  const { cx, cy, radius, startAngle, endAngle, counterclockwise, x1, y1, arrowX, arrowY, ux, uy } =
    band;
  const dash = arrowSize * 0.5;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.setLineDash(dashed ? [dash, dash] : []);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  if (band.cpx !== undefined && band.cpy !== undefined) {
    ctx.quadraticCurveTo(band.cpx, band.cpy, arrowX, arrowY);
  } else {
    ctx.arc(cx, cy, radius, startAngle, endAngle, counterclockwise);
  }
  // 弧一直画到节点圆 attach 点（与箭尖同位置），避免线与箭头脱节。
  ctx.stroke();
  ctx.setLineDash([]);

  const px = -uy;
  const py = ux;
  const hw = arrowSize * 0.48;
  const bx = arrowX - ux * arrowSize;
  const by = arrowY - uy * arrowSize;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(arrowX, arrowY);
  ctx.lineTo(bx + px * hw, by + py * hw);
  ctx.lineTo(bx - px * hw, by - py * hw);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/**
 * 画布关系边：一律使用**直线**（起点到终点）。
 */
export function drawStraightLine(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
  lineWidth = 2,
): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.restore();
}

export function drawStraightLineDashed(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
  lineWidth = 2,
  dash: number[] = [6, 6],
): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.restore();
}

/** @deprecated 贝塞尔，仅保留兼容；关系绘制请用 {@link drawStraightLine} */
export function drawEdge(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
  lineWidth = 2,
): void {
  drawStraightLine(ctx, x1, y1, x2, y2, color, lineWidth);
}

export function drawEdgeDashed(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
): void {
  drawStraightLineDashed(ctx, x1, y1, x2, y2, color, 2);
}

import type { DirectedSegment } from './relation-geometry.js';

const ARROW_WORLD = 12;

/**
 * 有向边：线段 + 终点箭头（查询方向指向 target）。
 */
export function drawDirectedRelation(
  ctx: CanvasRenderingContext2D,
  seg: DirectedSegment,
  color: string,
  lineWidth: number,
  dashed: boolean,
): void {
  const { x1, y1, x2, y2, ux, uy } = seg;
  const shorten = ARROW_WORLD * 1.05;
  const lx = x2 - ux * shorten;
  const ly = y2 - uy * shorten;
  if (dashed) {
    drawStraightLineDashed(ctx, x1, y1, lx, ly, color, lineWidth);
  } else {
    drawStraightLine(ctx, x1, y1, lx, ly, color, lineWidth);
  }
  const px = -uy;
  const py = ux;
  const hw = ARROW_WORLD * 0.48;
  const bx = x2 - ux * ARROW_WORLD;
  const by = y2 - uy * ARROW_WORLD;
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

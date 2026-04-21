/**
 * 原子绘制：关系边（贝塞尔）。
 */
export function drawEdge(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
): void {
  const cx1 = x1 + (x2 - x1) * 0.45;
  const cy1 = y1;
  const cx2 = x1 + (x2 - x1) * 0.55;
  const cy2 = y2;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.bezierCurveTo(cx1, cy1, cx2, cy2, x2, y2);
  ctx.stroke();
  ctx.restore();
}

export function drawEdgeDashed(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
): void {
  ctx.save();
  ctx.setLineDash([6, 6]);
  drawEdge(ctx, x1, y1, x2, y2, color);
  ctx.restore();
}

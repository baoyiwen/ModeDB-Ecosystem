import { CANVAS_VISUAL } from '../config/canvas-visual.js';
import type { RelationLabelPlacement } from './relation-geometry.js';

const LABEL_FONT = '600 11px system-ui, "Segoe UI", sans-serif';
const LABEL_LINE_HEIGHT = 11;

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

/** 在世界坐标绘制沿连线方向的关系标签（屏幕像素恒定尺寸 + 圆角矩形底）。 */
export function drawRelationLabel(
  ctx: CanvasRenderingContext2D,
  placement: RelationLabelPlacement,
  text: string,
  zoom: number,
): void {
  const vis = CANVAS_VISUAL.label;
  ctx.save();
  ctx.translate(placement.x, placement.y);
  ctx.scale(1 / zoom, 1 / zoom);
  ctx.rotate(placement.angle);

  ctx.font = LABEL_FONT;
  const textW = ctx.measureText(text).width;
  const boxW = textW + vis.paddingX * 2;
  const boxH = LABEL_LINE_HEIGHT + vis.paddingY * 2;
  const left = -boxW / 2;
  const top = -boxH / 2;

  roundRectPath(ctx, left, top, boxW, boxH, vis.radius);
  ctx.fillStyle = vis.bgColor;
  ctx.fill();
  ctx.strokeStyle = vis.borderColor;
  ctx.lineWidth = vis.borderWidth;
  ctx.stroke();

  ctx.fillStyle = vis.color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

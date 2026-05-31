import type { ThemePalette } from '../managers/config-manager.js';
import { CANVAS_VISUAL } from '../config/canvas-visual.js';
import { contrastTextOnHex } from '../utils/color-utils.js';
import { NODE_RADIUS } from './node-geometry.js';

export interface DrawNodeCircleParams {
  ctx: CanvasRenderingContext2D;
  /** 外接正方形左上角 */
  x: number;
  y: number;
  title: string;
  theme: ThemePalette;
  selected: boolean;
  hovered?: boolean;
  /** 若设置则覆盖 `theme.header` 作为节点填充（`sys_model.color`） */
  nodeFillHex?: string;
}

/**
 * 原子绘制：圆形模型节点（仅 Canvas，无 DOM 块）。
 */
export function drawNodeCircle(params: DrawNodeCircleParams): void {
  const { ctx, x, y, title, theme, selected, hovered = false, nodeFillHex } = params;
  const r = NODE_RADIUS;
  const cx = x + r;
  const cy = y + r;
  const fill = nodeFillHex ?? theme.header;
  const labelColor = nodeFillHex ? contrastTextOnHex(nodeFillHex) : '#ffffff';
  const vis = CANVAS_VISUAL.node;

  ctx.save();
  ctx.shadowBlur = selected
    ? vis.shadowBlurSelected
    : hovered
      ? vis.shadowBlurHover
      : vis.shadowBlur;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 4;
  ctx.shadowColor = vis.shadowColor;
  ctx.beginPath();
  ctx.arc(cx, cy, r - 1.5, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.shadowBlur = 0;

  if (selected) {
    ctx.strokeStyle = vis.selectedRingColor;
    ctx.lineWidth = vis.selectedRingWidth;
    ctx.beginPath();
    ctx.arc(cx, cy, r + 2, 0, Math.PI * 2);
    ctx.stroke();
  } else if (hovered) {
    ctx.strokeStyle = vis.hoverRingColor;
    ctx.lineWidth = vis.hoverRingWidth;
    ctx.beginPath();
    ctx.arc(cx, cy, r + 1.5, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.fillStyle = labelColor;
  ctx.font = '600 13px system-ui, "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const maxW = (r - 10) * 2;
  let text = title;
  while (text.length > 1 && ctx.measureText(text).width > maxW) {
    text = text.slice(0, -1);
  }
  if (text !== title && text.length > 0) {
    text = `${text.slice(0, -1)}…`;
  }
  ctx.fillText(text, cx, cy);
  ctx.restore();
}

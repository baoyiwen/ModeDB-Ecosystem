import type { ThemePalette } from '../managers/config-manager.js';
import { NODE_RADIUS } from './node-geometry.js';

export interface DrawNodeCircleParams {
  ctx: CanvasRenderingContext2D;
  /** 外接正方形左上角 */
  x: number;
  y: number;
  title: string;
  theme: ThemePalette;
  selected: boolean;
}

/**
 * 原子绘制：圆形模型节点（仅 Canvas，无 DOM 块）。
 */
export function drawNodeCircle(params: DrawNodeCircleParams): void {
  const { ctx, x, y, title, theme, selected } = params;
  const r = NODE_RADIUS;
  const cx = x + r;
  const cy = y + r;
  const fill = theme.header;

  ctx.save();
  ctx.shadowBlur = selected ? 18 : 14;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 4;
  ctx.shadowColor = 'rgba(15, 23, 42, 0.18)';
  ctx.beginPath();
  ctx.arc(cx, cy, r - 1.5, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.shadowBlur = 0;

  if (selected) {
    ctx.strokeStyle = '#7c3aed';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, cy, r + 2, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.fillStyle = '#ffffff';
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

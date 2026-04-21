import type { ThemePalette } from '../managers/config-manager.js';
import type { PropObject } from '../types/prop-object.js';

export interface DrawPropRowParams {
  ctx: CanvasRenderingContext2D;
  x: number;
  y: number;
  width: number;
  prop: PropObject;
  theme: ThemePalette;
}

/**
 * 原子绘制：模型内单行 Prop 缩略。
 */
export function drawPropRow(params: DrawPropRowParams): void {
  const { ctx, x, y, width, prop, theme } = params;
  ctx.save();
  ctx.fillStyle = theme.text;
  ctx.font = '12px ui-monospace, monospace';
  const primary = prop.is_primary ? ' *' : '';
  const label = `${prop.name}: ${prop.type}${primary}`;
  const maxW = Math.max(0, width - 16);
  ctx.fillText(label.slice(0, 42), x + 8, y + 12, maxW);
  ctx.restore();
}

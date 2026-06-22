import { normalizeHex, parseFillHex } from './color-utils.js';
import type { EngineModelNode } from '../types/engine-schema.js';

/** 与 ConfigManager 主题 header 对齐并扩展的节点色板。 */
export const MODEL_COLOR_PALETTE: readonly string[] = [
  '#2563eb',
  '#22c55e',
  '#ec4899',
  '#f97316',
  '#06b6d4',
  '#7c3aed',
  '#6366f1',
  '#14b8a6',
  '#f59e0b',
  '#f43f5e',
  '#475569',
  '#84cc16',
] as const;

const THEME_HEADER_BY_ID: Record<string, string> = {
  default: '#2563eb',
  green: '#22c55e',
  pink: '#ec4899',
  coral: '#f97316',
  cyan: '#06b6d4',
  accent: '#7c3aed',
};

const DEFAULT_DISPLAY_HEX = MODEL_COLOR_PALETTE[0]!;

function resolveModelDisplayHex(
  model: EngineModelNode,
  layout: { color_theme?: string } | undefined,
): string {
  const custom = parseFillHex(model.color_value);
  if (custom) {
    return custom;
  }
  const themeId = layout?.color_theme ?? 'default';
  const header = THEME_HEADER_BY_ID[themeId];
  return normalizeHex(header, DEFAULT_DISPLAY_HEX);
}

/**
 * 从已占用颜色集合中随机挑选新色：优先选色板内未使用的颜色；
 * 若色板已用尽则随机复用（不保证修改后的唯一性）。
 */
export function pickNewModelColorFromUsed(usedHex: Iterable<string | undefined>): string {
  const used = new Set<string>();
  for (const raw of usedHex) {
    const hex = parseFillHex(raw);
    if (hex) {
      used.add(hex);
    }
  }

  const available = MODEL_COLOR_PALETTE.filter((c) => !used.has(normalizeHex(c, c)));
  const pool = available.length > 0 ? [...available] : [...MODEL_COLOR_PALETTE];
  const idx = Math.floor(Math.random() * pool.length);
  return normalizeHex(pool[idx], DEFAULT_DISPLAY_HEX);
}

/**
 * 根据当前画布模型及其布局，为新模型挑选尽量不重复的颜色。
 */
export function pickNewModelColor(
  models: readonly EngineModelNode[],
  getLayout: (modelId: string) => { color_theme?: string } | undefined,
): string {
  const used = models.map((m) => resolveModelDisplayHex(m, getLayout(m.id)));
  return pickNewModelColorFromUsed(used);
}

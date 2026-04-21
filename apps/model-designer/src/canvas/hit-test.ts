import type { EngineModelNode } from '../types/engine-schema.js';
import { computeNodeHeight, NODE_RADIUS } from './node-geometry.js';

export interface PlacedNode {
  model: EngineModelNode;
  x: number;
  y: number;
}

export function buildPlacedNodes(
  models: readonly EngineModelNode[],
  getPos: (id: string) => { x: number; y: number } | undefined,
): PlacedNode[] {
  return models.map((m) => {
    const p = getPos(m.id) ?? { x: 0, y: 0 };
    return { model: m, x: p.x, y: p.y };
  });
}

export function hitTestNode(
  px: number,
  py: number,
  placed: readonly PlacedNode[],
  getZIndex: (id: string) => number,
  hiddenIds?: ReadonlySet<string>,
): string | undefined {
  const sorted = [...placed]
    .filter((p) => !hiddenIds?.has(p.model.id))
    .sort((a, b) => getZIndex(b.model.id) - getZIndex(a.model.id));
  const r = NODE_RADIUS;
  const r2 = r * r;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const { model, x, y } = sorted[i];
    const cx = x + r;
    const cy = y + r;
    const dx = px - cx;
    const dy = py - cy;
    if (dx * dx + dy * dy <= r2) {
      return model.id;
    }
  }
  return undefined;
}

export function anchorRightCenter(placed: PlacedNode): { x: number; y: number } {
  const h = computeNodeHeight(placed.model);
  const r = NODE_RADIUS;
  const cx = placed.x + r;
  const cy = placed.y + h / 2;
  return { x: cx + r, y: cy };
}

export function anchorLeftCenter(placed: PlacedNode): { x: number; y: number } {
  const h = computeNodeHeight(placed.model);
  const r = NODE_RADIUS;
  const cx = placed.x + r;
  const cy = placed.y + h / 2;
  return { x: cx - r, y: cy };
}

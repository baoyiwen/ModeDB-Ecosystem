import { drawEdge } from './draw-edge.js';
import { drawNodeCircle } from './draw-node.js';
import type { ConfigManager } from '../managers/config-manager.js';
import type { DataManager } from '../managers/data-manager.js';
import type { EngineRelationEdge } from '../types/engine-schema.js';
import {
  anchorLeftCenter,
  anchorRightCenter,
  buildPlacedNodes,
  type PlacedNode,
} from './hit-test.js';
import { computeNodeHeight } from './node-geometry.js';

export interface PaintSceneParams {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  data: DataManager;
  config: ConfigManager;
  selectedId: string | undefined;
  /** 因图层隐藏而不绘制的节点 id；其作为端点的关系一并跳过。 */
  hiddenNodeIds?: ReadonlySet<string>;
  linkPreview: { x1: number; y1: number; x2: number; y2: number } | null;
  inheritPreview: { x1: number; y1: number; x2: number; y2: number } | null;
}

/** 浅色点阵背景（与参考图一致）。 */
export function paintDotGrid(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  step: number,
  enabled: boolean,
): void {
  if (!enabled) {
    return;
  }
  ctx.save();
  ctx.fillStyle = 'rgba(148, 163, 184, 0.45)';
  for (let x = step; x < width; x += step) {
    for (let y = step; y < height; y += step) {
      ctx.beginPath();
      ctx.arc(x, y, 1.1, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

export function paintScene(params: PaintSceneParams): void {
  const {
    ctx,
    width,
    height,
    data,
    config,
    selectedId,
    hiddenNodeIds,
    linkPreview,
    inheritPreview,
  } = params;
  const hide = hiddenNodeIds;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#f1f5f9';
  ctx.fillRect(0, 0, width, height);

  const snap = config.snapshot();
  paintDotGrid(ctx, width, height, snap.gridSize, snap.gridEnabled);

  const placed = buildPlacedNodes(data.models, (id) => data.getLayout(id)?.position);
  const byId = new Map<string, PlacedNode>();
  for (const p of placed) {
    byId.set(p.model.id, p);
  }

  const drawRelation = (r: EngineRelationEdge): void => {
    if (hide?.has(r.source_model_id) || hide?.has(r.target_model_id)) {
      return;
    }
    const a = byId.get(r.source_model_id);
    const b = byId.get(r.target_model_id);
    if (!a || !b) {
      return;
    }
    const p1 = anchorRightCenter(a);
    const p2 = anchorLeftCenter(b);
    drawEdge(ctx, p1.x, p1.y, p2.x, p2.y, '#94a3b8');
  };

  for (const r of data.relations) {
    drawRelation(r);
  }

  if (linkPreview) {
    drawEdge(ctx, linkPreview.x1, linkPreview.y1, linkPreview.x2, linkPreview.y2, '#2563eb');
  }
  if (inheritPreview) {
    ctx.setLineDash([6, 6]);
    drawEdge(
      ctx,
      inheritPreview.x1,
      inheritPreview.y1,
      inheritPreview.x2,
      inheritPreview.y2,
      '#7c3aed',
    );
    ctx.setLineDash([]);
  }

  const sorted = [...placed].sort(
    (a, b) =>
      (data.getLayout(a.model.id)?.z_index ?? 0) - (data.getLayout(b.model.id)?.z_index ?? 0),
  );

  for (const p of sorted) {
    if (hide?.has(p.model.id)) {
      continue;
    }
    const layout = data.getLayout(p.model.id);
    const themeId = layout?.color_theme ?? 'default';
    const theme = config.getTheme(themeId) ?? config.getThemes()[0];
    computeNodeHeight(p.model);
    drawNodeCircle({
      ctx,
      x: p.x,
      y: p.y,
      title: p.model.model_name,
      theme,
      selected: p.model.id === selectedId,
    });
  }
}

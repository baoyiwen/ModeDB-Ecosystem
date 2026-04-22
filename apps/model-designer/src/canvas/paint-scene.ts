import { GRAPH_INHERIT_KIND } from '../config/graph-edge-kinds.js';
import { drawDirectedRelation } from './draw-edge.js';
import { drawNodeCircle } from './draw-node.js';
import type { ConfigManager } from '../managers/config-manager.js';
import type { DataManager } from '../managers/data-manager.js';
import type { EngineRelationEdge } from '../types/engine-schema.js';
import { buildPlacedNodes, type PlacedNode } from './hit-test.js';
import {
  directedShortestSegment,
  edgePerpOffsetById,
  type DirectedSegment,
} from './relation-geometry.js';
import { computeNodeHeight } from './node-geometry.js';
import { parseFillHex } from '../utils/color-utils.js';
import { resolveModelDisplayName } from '../utils/i18n-resolve.js';

export interface PaintSceneParams {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  data: DataManager;
  config: ConfigManager;
  selectedModelId: string | undefined;
  selectedRelationId: string | undefined;
  hiddenNodeIds?: ReadonlySet<string>;
  linkPreview: DirectedSegment | null;
  inheritPreview: DirectedSegment | null;
  /** 关系 kind → 当前语言下的名称 */
  getRelationKindLabel: (kind: string) => string;
  /** 界面语言（`en` | `zh` | `ja`），用于节点标题自 `name_i18n` 解析 */
  uiLocale: string;
}

/**
 * 在当前视口对应的世界坐标矩形内铺点阵（与 translate(pan)+scale(zoom) 后的可见区域一致）。
 * `gridStepWorld` 为世界单位步长；点半径随 zoom 调整以保持约 1px 屏上大小。
 */
export function paintVisibleWorldDotGrid(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  panX: number,
  panY: number,
  zoom: number,
  gridStepWorld: number,
  enabled: boolean,
): void {
  if (!enabled || gridStepWorld <= 0) {
    return;
  }
  const wx0 = -panX / zoom;
  const wx1 = (width - panX) / zoom;
  const wy0 = -panY / zoom;
  const wy1 = (height - panY) / zoom;
  const xMin = Math.min(wx0, wx1) - gridStepWorld;
  const xMax = Math.max(wx0, wx1) + gridStepWorld;
  const yMin = Math.min(wy0, wy1) - gridStepWorld;
  const yMax = Math.max(wy0, wy1) + gridStepWorld;
  const step = gridStepWorld;
  const dotR = Math.max(0.75 / zoom, 0.4);
  ctx.save();
  ctx.fillStyle = 'rgba(100, 116, 139, 0.35)';
  for (let x = Math.floor(xMin / step) * step; x <= xMax + 1e-6; x += step) {
    for (let y = Math.floor(yMin / step) * step; y <= yMax + 1e-6; y += step) {
      ctx.beginPath();
      ctx.arc(x, y, dotR, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawRelationLabel(
  ctx: CanvasRenderingContext2D,
  seg: DirectedSegment,
  label: string,
  zoom: number,
): void {
  const px = -seg.uy;
  const py = seg.ux;
  const ox = px * 18;
  const oy = py * 18;
  ctx.save();
  ctx.translate(seg.midX + ox, seg.midY + oy);
  ctx.scale(1 / zoom, 1 / zoom);
  ctx.font = '600 11px system-ui, "Segoe UI", sans-serif';
  ctx.fillStyle = '#334155';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 0, 0);
  ctx.restore();
}

export function paintScene(params: PaintSceneParams): void {
  const {
    ctx,
    width,
    height,
    data,
    config,
    selectedModelId,
    selectedRelationId,
    hiddenNodeIds,
    linkPreview,
    inheritPreview,
    getRelationKindLabel,
    uiLocale,
  } = params;
  const hide = hiddenNodeIds;
  ctx.clearRect(0, 0, width, height);

  const snap = config.snapshot();
  const panX = config.viewportPanX;
  const panY = config.viewportPanY;
  const zoom = config.viewportZoom;
  ctx.save();
  ctx.translate(panX, panY);
  ctx.scale(zoom, zoom);

  paintVisibleWorldDotGrid(ctx, width, height, panX, panY, zoom, snap.gridSize, snap.gridEnabled);

  const placed = buildPlacedNodes(data.models, (id) => data.getLayout(id)?.position);
  const byId = new Map<string, PlacedNode>();
  for (const p of placed) {
    byId.set(p.model.id, p);
  }

  const offMap = edgePerpOffsetById(data.relations);

  const drawEdgeStroke = (r: EngineRelationEdge, emphasize: boolean): DirectedSegment | null => {
    if (hide?.has(r.source_model_id) || hide?.has(r.target_model_id)) {
      return null;
    }
    const a = byId.get(r.source_model_id);
    const b = byId.get(r.target_model_id);
    if (!a || !b) {
      return null;
    }
    const off = offMap.get(r.id) ?? 0;
    const seg = directedShortestSegment(a, b, off);
    const color = r.kind === GRAPH_INHERIT_KIND ? '#64748b' : '#94a3b8';
    const lw = emphasize ? 4 : 2;
    drawDirectedRelation(ctx, seg, color, lw, r.kind === GRAPH_INHERIT_KIND);
    return seg;
  };

  const selRel = selectedRelationId;
  const labelEntries: { seg: DirectedSegment; kind: string }[] = [];

  for (const r of data.relations) {
    if (r.id === selRel) {
      continue;
    }
    const seg = drawEdgeStroke(r, false);
    if (seg) {
      labelEntries.push({ seg, kind: r.kind });
    }
  }

  if (linkPreview) {
    drawDirectedRelation(ctx, linkPreview, '#2563eb', 2, false);
  }
  if (inheritPreview) {
    drawDirectedRelation(ctx, inheritPreview, '#7c3aed', 2, true);
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
      title: resolveModelDisplayName(p.model, uiLocale),
      theme,
      selected: p.model.id === selectedModelId,
      nodeFillHex: parseFillHex(p.model.color_value),
    });
  }

  if (selRel) {
    const r = data.relations.find((x) => x.id === selRel);
    if (r && !hide?.has(r.source_model_id) && !hide?.has(r.target_model_id)) {
      const seg = drawEdgeStroke(r, true);
      if (seg) {
        labelEntries.push({ seg, kind: r.kind });
      }
    }
  }

  for (const { seg, kind } of labelEntries) {
    drawRelationLabel(ctx, seg, getRelationKindLabel(kind), zoom);
  }

  ctx.restore();
}

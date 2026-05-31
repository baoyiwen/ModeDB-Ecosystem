import { isInheritRelation } from '../config/graph-edge-kinds.js';
import { CANVAS_VISUAL } from '../config/canvas-visual.js';
import { drawDirectedRelation, drawSelfLoop } from './draw-edge.js';
import { drawNodeCircle } from './draw-node.js';
import type { ConfigManager } from '../managers/config-manager.js';
import type { DataManager } from '../managers/data-manager.js';
import type { EngineRelationEdge } from '../types/engine-schema.js';
import { buildPlacedNodes, type PlacedNode } from './hit-test.js';
import {
  directedShortestSegment,
  edgePerpOffsetById,
  edgeSelfLoopSlotById,
  RELATION_INTRA_PAIR_GAP,
  selfLoopGeometry,
  type DirectedSegment,
} from './relation-geometry.js';
import { computeNodeHeight } from './node-geometry.js';
import { parseFillHex } from '../utils/color-utils.js';
import {
  resolveModelDisplayName,
  resolveRelationForwardLabel,
  resolveRelationReverseLabel,
  resolveInheritRelationLabel,
} from '../utils/i18n-resolve.js';

export interface PaintSceneParams {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  data: DataManager;
  config: ConfigManager;
  selectedModelId: string | undefined;
  selectedRelationId: string | undefined;
  hoveredModelId?: string | undefined;
  hoveredRelationId?: string | undefined;
  hiddenNodeIds?: ReadonlySet<string>;
  linkPreview: DirectedSegment | null;
  inheritPreview?: DirectedSegment | null;
  /** 界面语言（`en` | `zh` | `ja`），用于节点标题与正/逆向关系标签按 i18n 解析 */
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
  ctx.fillStyle = CANVAS_VISUAL.grid.dotColor;
  for (let x = Math.floor(xMin / step) * step; x <= xMax + 1e-6; x += step) {
    for (let y = Math.floor(yMin / step) * step; y <= yMax + 1e-6; y += step) {
      ctx.beginPath();
      ctx.arc(x, y, dotR, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

/** 在世界坐标 (worldX, worldY) 处绘制关系标签；标签自身按屏幕像素恒定渲染（`1 / zoom`）。 */
function drawRelationLabel(
  ctx: CanvasRenderingContext2D,
  worldX: number,
  worldY: number,
  label: string,
  zoom: number,
): void {
  ctx.save();
  ctx.translate(worldX, worldY);
  ctx.scale(1 / zoom, 1 / zoom);
  ctx.font = '600 11px system-ui, "Segoe UI", sans-serif';
  ctx.fillStyle = CANVAS_VISUAL.label.color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 0, 0);
  ctx.restore();
}

/** 由有向线段计算"沿垂直方向 18 世界单位"的标签锚点；与原有标签摆放语义一致。 */
function segmentLabelAnchor(seg: DirectedSegment): { x: number; y: number } {
  return { x: seg.midX + -seg.uy * 18, y: seg.midY + seg.ux * 18 };
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
    hoveredModelId,
    hoveredRelationId,
    hiddenNodeIds,
    linkPreview,
    inheritPreview,
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
  const loopSlotMap = edgeSelfLoopSlotById(data.relations);

  const vis = CANVAS_VISUAL.relation;
  const baseLw = vis.strokePx / zoom;
  const hoverLw = vis.strokeHoverPx / zoom;
  const empLw = vis.strokeSelectedPx / zoom;
  const arrow = vis.arrowPx / zoom;

  type EdgeDrawKind = 'normal' | 'hover' | 'selected';
  const relationColor = (r: EngineRelationEdge, kind: EdgeDrawKind): string => {
    const inherit = isInheritRelation(r.kind);
    if (kind === 'selected') {
      return inherit ? vis.inheritSelectedColor : vis.selectedColor;
    }
    if (kind === 'hover') {
      return inherit ? vis.inheritHoverColor : vis.hoverColor;
    }
    return inherit ? vis.inheritColor : vis.normalColor;
  };
  const relationWidth = (kind: EdgeDrawKind): number => {
    if (kind === 'selected') return empLw;
    if (kind === 'hover') return hoverLw;
    return baseLw;
  };

  /**
   * 每条关系绘制策略：
   *
   * - **继承**（`modelInherits`）：单条虚线，parent → child，仅一个标签。
   * - **普通关系**：两条平行直线（正/逆）。
   * - **自关联**：「帽子」两圈弧（内檐 reverse + 外顶 forward）扣在节点 slot 方向。
   */
  type EdgeLabelAnchors = {
    forward: { x: number; y: number };
    reverse?: { x: number; y: number };
  };
  const drawEdgeStroke = (
    r: EngineRelationEdge,
    drawKind: EdgeDrawKind,
  ): EdgeLabelAnchors | null => {
    if (hide?.has(r.source_model_id) || hide?.has(r.target_model_id)) {
      return null;
    }
    const a = byId.get(r.source_model_id);
    const b = byId.get(r.target_model_id);
    if (!a || !b) {
      return null;
    }
    const color = relationColor(r, drawKind);
    const lw = relationWidth(drawKind);
    const isInherit = isInheritRelation(r.kind);
    if (r.source_model_id === r.target_model_id) {
      const slot = loopSlotMap.get(r.id) ?? 0;
      const loop = selfLoopGeometry(a, slot);
      drawSelfLoop(ctx, loop, color, lw, arrow, isInherit);
      return {
        forward: { x: loop.forward.labelX, y: loop.forward.labelY },
        reverse: { x: loop.reverse.labelX, y: loop.reverse.labelY },
      };
    }
    const slotOff = offMap.get(r.id) ?? 0;
    if (isInherit) {
      const seg = directedShortestSegment(a, b, slotOff);
      drawDirectedRelation(ctx, seg, color, lw, arrow, true);
      return { forward: segmentLabelAnchor(seg) };
    }
    const forward = directedShortestSegment(a, b, slotOff + RELATION_INTRA_PAIR_GAP);
    const reverse = directedShortestSegment(b, a, -(slotOff - RELATION_INTRA_PAIR_GAP));
    drawDirectedRelation(ctx, forward, color, lw, arrow, false);
    drawDirectedRelation(ctx, reverse, color, lw, arrow, false);
    return {
      forward: segmentLabelAnchor(forward),
      reverse: segmentLabelAnchor(reverse),
    };
  };

  const selRel = selectedRelationId;
  const hovRel = hoveredRelationId;
  const labelEntries: { x: number; y: number; text: string }[] = [];

  const pushLabels = (r: EngineRelationEdge, anchors: EdgeLabelAnchors): void => {
    if (isInheritRelation(r.kind)) {
      labelEntries.push({
        x: anchors.forward.x,
        y: anchors.forward.y,
        text: resolveInheritRelationLabel(r, uiLocale),
      });
      return;
    }
    const fwdText = resolveRelationForwardLabel(r, uiLocale);
    const revText = resolveRelationReverseLabel(r, uiLocale);
    labelEntries.push({ x: anchors.forward.x, y: anchors.forward.y, text: fwdText });
    if (anchors.reverse) {
      labelEntries.push({ x: anchors.reverse.x, y: anchors.reverse.y, text: revText });
    }
  };

  const edgeDrawKind = (relId: string): EdgeDrawKind => {
    if (relId === selRel) return 'selected';
    if (relId === hovRel) return 'hover';
    return 'normal';
  };

  for (const r of data.relations) {
    if (r.id === selRel) {
      continue;
    }
    const anchors = drawEdgeStroke(r, edgeDrawKind(r.id));
    if (anchors) {
      pushLabels(r, anchors);
    }
  }

  if (linkPreview) {
    drawDirectedRelation(ctx, linkPreview, CANVAS_VISUAL.preview.linkColor, baseLw, arrow, false);
  }
  if (inheritPreview) {
    drawDirectedRelation(
      ctx,
      inheritPreview,
      CANVAS_VISUAL.preview.inheritColor,
      baseLw,
      arrow,
      true,
    );
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
      hovered: p.model.id === hoveredModelId && p.model.id !== selectedModelId,
      nodeFillHex: parseFillHex(p.model.color_value),
    });
  }

  if (selRel) {
    const r = data.relations.find((x) => x.id === selRel);
    if (r && !hide?.has(r.source_model_id) && !hide?.has(r.target_model_id)) {
      const anchors = drawEdgeStroke(r, 'selected');
      if (anchors) {
        pushLabels(r, anchors);
      }
    }
  }

  for (const { x, y, text } of labelEntries) {
    drawRelationLabel(ctx, x, y, text, zoom);
  }

  ctx.restore();
}

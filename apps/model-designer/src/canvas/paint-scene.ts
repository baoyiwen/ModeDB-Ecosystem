import { isInheritRelation } from '../config/graph-edge-kinds.js';
import { CANVAS_VISUAL } from '../config/canvas-visual.js';
import { drawDirectedRelation, drawSelfLoop } from './draw-edge.js';
import { drawRelationLabel } from './draw-relation-label.js';
import { drawNodeCircle } from './draw-node.js';
import type { ConfigManager } from '../managers/config-manager.js';
import type { DataManager } from '../managers/data-manager.js';
import type { EngineRelationEdge } from '../types/engine-schema.js';
import { buildPlacedNodes, type PlacedNode } from './hit-test.js';
import {
  directedCurvedSegment,
  edgePerpOffsetById,
  edgeSelfLoopSlotById,
  RELATION_INTRA_PAIR_GAP,
  arcLabelPlacement,
  selfLoopGeometry,
  segmentLabelPlacement,
  type CurvedDirectedSegment,
  type DirectedSegment,
  type RelationLabelPlacement,
} from './relation-geometry.js';
import { computeNodeHeight } from './node-geometry.js';
import { paintSnapGuides, type SnapGuide } from './snap-guides.js';
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
  hiddenRelationIds?: ReadonlySet<string>;
  mutedNodeIds?: ReadonlySet<string>;
  mutedRelationIds?: ReadonlySet<string>;
  highlightNodeIds?: ReadonlySet<string>;
  highlightRelationIds?: ReadonlySet<string>;
  linkPreview: DirectedSegment | null;
  inheritPreview?: DirectedSegment | null;
  /** 界面语言（`en` | `zh` | `ja`），用于节点标题与正/逆向关系标签按 i18n 解析 */
  uiLocale: string;
  /** 拖拽吸附时显示的对齐标线（世界坐标）。 */
  snapGuides?: readonly SnapGuide[];
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

/** 由有向线段计算标签锚点（沿连线中点 + 切线方向）。 */
function segmentLabelAnchor(seg: DirectedSegment | CurvedDirectedSegment): RelationLabelPlacement {
  return segmentLabelPlacement(seg);
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
    hiddenRelationIds,
    mutedNodeIds,
    mutedRelationIds,
    highlightNodeIds,
    highlightRelationIds,
    linkPreview,
    inheritPreview,
    uiLocale,
    snapGuides,
  } = params;
  const hide = hiddenNodeIds;
  const hideRelation = hiddenRelationIds;
  ctx.clearRect(0, 0, width, height);

  const snap = config.snapshot();
  const panX = config.viewportPanX;
  const panY = config.viewportPanY;
  const zoom = config.viewportZoom;
  ctx.save();
  ctx.translate(panX, panY);
  ctx.scale(zoom, zoom);

  paintVisibleWorldDotGrid(ctx, width, height, panX, panY, zoom, snap.gridSize, snap.gridEnabled);

  if (snapGuides && snapGuides.length > 0) {
    paintSnapGuides({
      ctx,
      width,
      height,
      panX,
      panY,
      zoom,
      guides: snapGuides,
      tangentColor: CANVAS_VISUAL.snapGuide.tangentColor,
      centerColor: CANVAS_VISUAL.snapGuide.centerColor,
      previewTangentColor: CANVAS_VISUAL.snapGuide.previewTangentColor,
      equalGapColor: CANVAS_VISUAL.snapGuide.equalGapColor,
    });
  }

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

  type EdgeDrawKind = 'normal' | 'hover' | 'selected' | 'muted' | 'highlight';
  const relationColor = (r: EngineRelationEdge, kind: EdgeDrawKind): string => {
    const inherit = isInheritRelation(r.kind);
    if (kind === 'selected') {
      return inherit ? vis.inheritSelectedColor : vis.selectedColor;
    }
    if (kind === 'hover') {
      return inherit ? vis.inheritHoverColor : vis.hoverColor;
    }
    if (kind === 'highlight') {
      return '#f59e0b';
    }
    if (kind === 'muted') {
      return '#cbd5e1';
    }
    return inherit ? vis.inheritColor : vis.normalColor;
  };
  const relationWidth = (kind: EdgeDrawKind): number => {
    if (kind === 'selected') return empLw;
    if (kind === 'highlight') return hoverLw;
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
    forward: RelationLabelPlacement;
    reverse?: RelationLabelPlacement;
  };
  const drawEdgeStroke = (
    r: EngineRelationEdge,
    drawKind: EdgeDrawKind,
  ): EdgeLabelAnchors | null => {
    if (hideRelation?.has(r.id)) {
      return null;
    }
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
        forward: arcLabelPlacement(loop.forward, loop.forward.labelX, loop.forward.labelY),
        reverse: arcLabelPlacement(loop.reverse, loop.reverse.labelX, loop.reverse.labelY),
      };
    }
    const meta = data.getRelationCanvasMeta(r.id);
    const slotOff = offMap.get(r.id) ?? 0;
    if (isInherit) {
      const seg = directedCurvedSegment(a, b, slotOff, meta.forward_bend);
      drawDirectedRelation(ctx, seg, color, lw, arrow, true);
      return { forward: segmentLabelAnchor(seg) };
    }
    const forward = directedCurvedSegment(
      a,
      b,
      slotOff + RELATION_INTRA_PAIR_GAP,
      meta.forward_bend,
    );
    const reverse = directedCurvedSegment(
      b,
      a,
      -(slotOff - RELATION_INTRA_PAIR_GAP),
      meta.reverse_bend,
    );
    drawDirectedRelation(ctx, forward, color, lw, arrow, false);
    drawDirectedRelation(ctx, reverse, color, lw, arrow, false);
    return {
      forward: segmentLabelAnchor(forward),
      reverse: segmentLabelAnchor(reverse),
    };
  };

  const selRel = selectedRelationId;
  const hovRel = hoveredRelationId;
  const labelEntries: { placement: RelationLabelPlacement; text: string }[] = [];

  const pushLabels = (r: EngineRelationEdge, anchors: EdgeLabelAnchors): void => {
    if (isInheritRelation(r.kind)) {
      labelEntries.push({
        placement: anchors.forward,
        text: resolveInheritRelationLabel(r, uiLocale),
      });
      return;
    }
    const fwdText = resolveRelationForwardLabel(r, uiLocale);
    const revText = resolveRelationReverseLabel(r, uiLocale);
    labelEntries.push({ placement: anchors.forward, text: fwdText });
    if (anchors.reverse) {
      labelEntries.push({ placement: anchors.reverse, text: revText });
    }
  };

  const edgeDrawKind = (relId: string): EdgeDrawKind => {
    if (relId === selRel) return 'selected';
    if (relId === hovRel) return 'hover';
    if (highlightRelationIds?.has(relId)) return 'highlight';
    if (mutedRelationIds?.has(relId)) return 'muted';
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
    const highlighted = highlightNodeIds?.has(p.model.id) === true;
    const muted = !highlighted && mutedNodeIds?.has(p.model.id) === true;
    drawNodeCircle({
      ctx,
      x: p.x,
      y: p.y,
      title: resolveModelDisplayName(p.model, uiLocale),
      theme,
      selected: p.model.id === selectedModelId,
      hovered: p.model.id === hoveredModelId && p.model.id !== selectedModelId,
      muted,
      highlighted,
      nodeFillHex: parseFillHex(p.model.color_value),
    });
  }

  if (selRel) {
    const r = data.relations.find((x) => x.id === selRel);
    if (
      r &&
      !hideRelation?.has(r.id) &&
      !hide?.has(r.source_model_id) &&
      !hide?.has(r.target_model_id)
    ) {
      const anchors = drawEdgeStroke(r, 'selected');
      if (anchors) {
        pushLabels(r, anchors);
      }
    }
  }

  for (const { placement, text } of labelEntries) {
    drawRelationLabel(ctx, placement, text, zoom);
  }

  ctx.restore();
}

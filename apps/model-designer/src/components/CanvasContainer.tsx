import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { useDesigner } from '../context/designer-context.js';
import {
  buildPlacedNodes,
  hitTestNode,
  hitTestRelation,
  type RelationHit,
} from '../canvas/hit-test.js';
import { NODE_RADIUS } from '../canvas/node-geometry.js';
import {
  buildForceNodes,
  centerToTopLeft,
  tickForceLayout as simulateForceLayout,
  type ForceLayoutNode,
} from '../canvas/force-layout.js';
import {
  collectSnapPeers,
  snapWorldPoint,
  snapNodeTopLeft,
  type SnapGuide,
} from '../canvas/snap-guides.js';
import {
  directedCurvedSegment,
  edgePerpOffsetById,
  edgeSelfLoopSlotById,
  RELATION_INTRA_PAIR_GAP,
  relationPairDefaultAnchor,
  segmentFromNodeTowardPoint,
  selfLoopDefaultAnchor,
} from '../canvas/relation-geometry.js';
import { paintScene } from '../canvas/paint-scene.js';
import { CANVAS_VISUAL } from '../config/canvas-visual.js';
import { LAYER_DEFAULT_PAGE_ID } from '../config/layer-tree-defaults.js';
import { isInheritRelation } from '../config/graph-edge-kinds.js';
import { isQueryDesignerMode } from '../managers/mode-manager.js';
import { pickNewModelColor } from '../utils/model-color-pick.js';
import { createUuid } from '../utils/random-id.js';
import type { GestureKind } from '../managers/event-manager.js';
import type { InteractionState } from '../managers/state-manager.js';
import {
  canStartLinkGesture,
  interactionStateForToolMode,
  isIdleCanvasInteractionState,
} from '../utils/tool-mode-state.js';

/**
 * 把鼠标 `clientX/clientY`（视口 CSS 像素）转换为画布**局部 CSS 像素**坐标。
 *
 * 绘制端通过 `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)` 把 user-space 锁定为 CSS px，
 * 因此 `panX/panY/zoom` 与 `pointer.x/y` **都必须**统一在 CSS-px 量纲下，否则在
 * `devicePixelRatio ≠ 1` 的环境（Win 125%/150%、HiDPI、浏览器 Ctrl-滚轮缩放）下，
 * 命中测试、连线、新建节点的坐标会偏移 `dpr×`。**不要**再把 `canvas.width/rect.width`
 * （= dpr）乘进去 —— 那是 backing-pixel 量纲。
 */
function clientToCanvas(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: clientX - rect.left,
    y: clientY - rect.top,
  };
}

const REL_HIT_THRESHOLD = CANVAS_VISUAL.hit.relationThresholdPx;
/** 画布像素：超过则视为拖动节点，不触发「点选」 */
const DRAG_THRESHOLD_CANVAS = 14;
const RELATION_PAIR_RESET_THRESHOLD_CANVAS = 14;

export function CanvasContainer(props: {
  selectedModelId: string | undefined;
  selectedRelationId: string | undefined;
  queryMode?: boolean;
  queryModelIds?: ReadonlySet<string>;
  queryRelationIds?: ReadonlySet<string>;
  queryConstraintRelationIds?: ReadonlySet<string>;
  queryCandidateRelationIds?: ReadonlySet<string>;
  onSelectModel: (id: string | undefined) => void;
  onSelectRelation: (id: string | undefined) => void;
}): ReactElement {
  const { state, events, config, data, graphLink, modes, layers, i18n, graphSync } = useDesigner();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);
  /** 画布当前 CSS 像素尺寸；由 resize 写入，paint 读取 —— 与绘制 ctx 的 `setTransform(dpr,…)` 配套。 */
  const cssSizeRef = useRef<{ width: number; height: number }>({ width: 0, height: 0 });
  const [, bump] = useState(0);
  const [hoveredModelId, setHoveredModelId] = useState<string | undefined>(undefined);
  const [hoveredRelationId, setHoveredRelationId] = useState<string | undefined>(undefined);
  const [snapGuides, setSnapGuides] = useState<SnapGuide[]>([]);
  const {
    selectedModelId,
    selectedRelationId,
    queryMode = false,
    queryModelIds,
    queryRelationIds,
    queryConstraintRelationIds,
    queryCandidateRelationIds,
    onSelectModel,
    onSelectRelation,
  } = props;

  const interactionRef = useRef<InteractionState>('SELECT');
  const linkSourceRef = useRef<string | undefined>(undefined);
  const pointerRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const panDragRef = useRef<{
    lastX: number;
    lastY: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  const nodeDragRef = useRef<{
    id: string;
    startCenterX: number;
    startCenterY: number;
    relationStates: {
      relationId: string;
      forwardBend?: { x: number; y: number };
      reverseBend?: { x: number; y: number };
      pairBend?: { x: number; y: number };
      selfAnchor?: { x: number; y: number };
    }[];
    startWorldX: number;
    startWorldY: number;
    startCanvasX: number;
    startCanvasY: number;
    moved: boolean;
  } | null>(null);
  const relationDragRef = useRef<{
    relationId: string;
    dragKind: 'pair' | 'inherit' | 'self';
    startForwardBend?: { x: number; y: number };
    startPairBend?: { x: number; y: number };
    defaultPairBend?: { x: number; y: number };
    startSelfAnchor?: { x: number; y: number };
    startSnapX: number;
    startSnapY: number;
    startWorldX: number;
    startWorldY: number;
    startCanvasX: number;
    startCanvasY: number;
    moved: boolean;
  } | null>(null);
  const forceNodesRef = useRef<ForceLayoutNode[] | null>(null);
  const forceMovedRef = useRef<Set<string>>(new Set());
  const forceWasEnabledRef = useRef(false);
  const linkClickRef = useRef<string | undefined>(undefined);
  const spaceDownRef = useRef(false);
  const modesRef = useRef(modes.mode);
  modesRef.current = modes.mode;
  const [spacePan, setSpacePan] = useState(false);

  const linkingFromAddCtrlRef = useRef(false);

  const toWorld = useCallback(
    (screenX: number, screenY: number) => {
      return {
        x: (screenX - config.viewportPanX) / config.viewportZoom,
        y: (screenY - config.viewportPanY) / config.viewportZoom,
      };
    },
    [config],
  );

  useEffect(() => {
    return data.subscribe(() => bump((n) => n + 1));
  }, [data]);

  useEffect(() => {
    return config.subscribeViewport(() => bump((n) => n + 1));
  }, [config]);

  useEffect(() => {
    return state.subscribe((s) => {
      interactionRef.current = s;
    });
  }, [state]);

  useEffect(() => {
    return modes.subscribe(() => bump((n) => n + 1));
  }, [modes]);

  useEffect(() => {
    return i18n.subscribe(() => bump((n) => n + 1));
  }, [i18n]);

  useEffect(() => {
    events.setTiming(config.longPressMs);
  }, [events, config]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const editable =
        e.target instanceof HTMLElement &&
        (e.target.isContentEditable ||
          e.target.closest('input, textarea, select, [contenteditable="true"]'));
      if (e.code === 'Space') {
        if (editable) {
          return;
        }
        const down = e.type === 'keydown';
        spaceDownRef.current = down;
        setSpacePan(down);
        e.preventDefault();
      }
      if (e.key === 'Escape') {
        linkingFromAddCtrlRef.current = false;
        modes.setMode('select');
        state.transition(interactionStateForToolMode('select'));
        linkSourceRef.current = undefined;
        linkClickRef.current = undefined;
        onSelectModel(undefined);
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
    };
  }, [state, modes, onSelectModel, onSelectRelation]);

  const getZIndex = useCallback((id: string) => data.getLayout(id)?.z_index ?? 0, [data]);

  const placed = useCallback(() => {
    return buildPlacedNodes(data.models, (id) => data.getLayout(id)?.position);
  }, [data]);

  const layerVisibility = useCallback(() => data.getLayerVisibilitySnapshot(), [data]);

  const hiddenIds = useCallback(() => layerVisibility().hiddenNodeIds, [layerVisibility]);

  const snapPeers = useCallback(() => {
    const hidden = hiddenIds();
    return collectSnapPeers(
      data.models.filter((m) => !hidden.has(m.id)).map((m) => m.id),
      (id) => data.getLayout(id)?.position,
    );
  }, [data, hiddenIds]);

  const snapDragOptions = useCallback(
    () => ({
      gridSize: config.gridSize,
      snapGrid: config.snapToGrid,
      snapAlign: config.snapToGrid,
      showTripleLineGuides: true,
      threshold: 16 / config.viewportZoom,
      lineThreshold: 12 / config.viewportZoom,
      gapEqualEps: Math.max(14, 18 / config.viewportZoom),
    }),
    [config.gridSize, config.snapToGrid, config.viewportZoom],
  );

  useEffect(() => {
    if (!config.forceLayoutEnabled) {
      forceNodesRef.current = null;
      return;
    }
    const visibility = layerVisibility();
    const hidden = visibility.hiddenNodeIds;
    const visible = data.models.filter((m) => !hidden.has(m.id));
    forceNodesRef.current = buildForceNodes(
      visible.map((m) => m.id),
      (id) => data.getLayout(id)?.position,
      (id) => data.isModelPositionLocked(id),
    );
  }, [config.forceLayoutEnabled, data, layerVisibility]);

  const hitAt = useCallback(
    (screenX: number, screenY: number) => {
      const w = toWorld(screenX, screenY);
      return hitTestNode(w.x, w.y, placed(), getZIndex, hiddenIds());
    },
    [placed, getZIndex, hiddenIds, toWorld],
  );

  const hitRelationAt = useCallback(
    (screenX: number, screenY: number): RelationHit | undefined => {
      const w = toWorld(screenX, screenY);
      const thresholdWorld = REL_HIT_THRESHOLD / config.viewportZoom;
      const visibility = layerVisibility();
      return hitTestRelation(
        w.x,
        w.y,
        data.relations,
        placed(),
        visibility.hiddenNodeIds,
        thresholdWorld,
        (id) => data.getRelationCanvasMeta(id),
        visibility.hiddenRelationIds,
      );
    },
    [data, placed, layerVisibility, config.viewportZoom, toWorld],
  );

  const applyCanvasPick = useCallback(
    (sx: number, sy: number): void => {
      const st = interactionRef.current;
      const mode = modesRef.current;
      const w = toWorld(sx, sy);
      const nodeId = hitAt(sx, sy);
      const relHit = nodeId ? undefined : hitRelationAt(sx, sy);
      const relId = relHit?.id;
      if (st === 'LINKING') {
        return;
      }
      if (isQueryDesignerMode(mode)) {
        if (nodeId) {
          onSelectModel(nodeId);
          return;
        }
        if (relId) {
          onSelectRelation(relId);
          return;
        }
        return;
      }
      if (mode === 'page') {
        const pageId = layers.activeLayerId;
        const canEditPage = data.layerTreePanelOpen && pageId && pageId !== LAYER_DEFAULT_PAGE_ID;
        if (nodeId) {
          onSelectModel(nodeId);
          onSelectRelation(undefined);
          if (canEditPage) {
            data.toggleModelPageMembership(nodeId, pageId);
          }
          return;
        }
        if (relId) {
          onSelectModel(undefined);
          onSelectRelation(relId);
          if (canEditPage) {
            data.toggleRelationPageMembership(relId, pageId);
          }
          return;
        }
        onSelectModel(undefined);
        onSelectRelation(undefined);
        return;
      }
      if (mode === 'delete') {
        if (nodeId) {
          data.removeModel(nodeId);
          onSelectModel(undefined);
          return;
        }
        if (relId) {
          data.removeRelation(relId);
          onSelectModel(undefined);
        }
        return;
      }
      if (mode === 'add' && !nodeId && !relId) {
        const nid = createUuid();
        const color_value = pickNewModelColor(data.models, (id) => data.getLayout(id));
        // 用户期望「点击位置 = 节点中心」；存储约定 `position` 为外接正方形左上角，故减去半径。
        data.upsertModel(
          {
            id: nid,
            model_name: `model_${Date.now()}`,
            parent_id: null,
            // 新建模型：默认不带任何字段（由 Props 面板手动添加）。
            props_objects_array: [],
            name_i18n: { zh: '新模型', en: 'NewModel', ja: '新規モデル' },
            color_value,
          },
          {
            position: { x: w.x - NODE_RADIUS, y: w.y - NODE_RADIUS },
            color_theme: 'default',
            z_index: 1,
          },
        );
        data.assignNodeToLayers(nid, [data.defaultPageLayerId]);
        onSelectModel(nid);
        return;
      }
      if (mode === 'link') {
        if (nodeId) {
          const first = linkClickRef.current;
          if (!first) {
            linkClickRef.current = nodeId;
            onSelectModel(nodeId);
          } else {
            // 允许 first === nodeId（自关联）：自关联在视觉上是节点旁边的贝塞尔环。
            const edgeId = graphLink.linkNodes(first, nodeId);
            linkClickRef.current = undefined;
            if (edgeId) {
              onSelectRelation(edgeId);
            } else {
              onSelectModel(nodeId);
            }
          }
        }
        return;
      }
      if (nodeId) {
        onSelectModel(nodeId);
      } else if (relId) {
        const rel = data.relations.find((r) => r.id === relId);
        if (rel && isInheritRelation(rel.kind)) {
          // 继承线：选中子模型，不打开关系编辑面板。
          onSelectModel(rel.target_model_id);
        } else {
          onSelectRelation(relId);
        }
      } else {
        onSelectModel(undefined);
        onSelectRelation(undefined);
      }
    },
    [
      hitAt,
      hitRelationAt,
      toWorld,
      data,
      config,
      graphLink,
      layers,
      onSelectModel,
      onSelectRelation,
    ],
  );

  const updateHoverAt = useCallback(
    (screenX: number, screenY: number): void => {
      const st = interactionRef.current;
      if (
        st === 'LINKING' ||
        panDragRef.current ||
        nodeDragRef.current ||
        relationDragRef.current
      ) {
        setHoveredModelId(undefined);
        setHoveredRelationId(undefined);
        return;
      }
      const nodeId = hitAt(screenX, screenY);
      let relId = nodeId ? undefined : hitRelationAt(screenX, screenY)?.id;
      if (relId) {
        const rel = data.relations.find((r) => r.id === relId);
        if (rel && isInheritRelation(rel.kind)) {
          relId = undefined;
        }
      }
      setHoveredModelId(nodeId);
      setHoveredRelationId(relId);
    },
    [hitAt, hitRelationAt, data.relations],
  );

  const tickForceLayout = useCallback((): void => {
    if (!config.forceLayoutEnabled || nodeDragRef.current || relationDragRef.current) {
      return;
    }
    const visibility = layerVisibility();
    const hidden = visibility.hiddenNodeIds;
    const visible = data.models.filter((m) => !hidden.has(m.id));
    if (visible.length === 0) {
      return;
    }
    const ids = visible
      .map((m) => m.id)
      .sort()
      .join('\n');
    const prevIds = forceNodesRef.current
      ?.map((n) => n.id)
      .sort()
      .join('\n');
    if (!forceNodesRef.current || ids !== prevIds) {
      forceNodesRef.current = buildForceNodes(
        visible.map((m) => m.id),
        (id) => data.getLayout(id)?.position,
        (id) => data.isModelPositionLocked(id),
      );
    }
    const nodes = forceNodesRef.current;
    const edges = data.relations
      .filter(
        (r) =>
          !visibility.hiddenRelationIds.has(r.id) &&
          !hidden.has(r.source_model_id) &&
          !hidden.has(r.target_model_id),
      )
      .map((r) => ({ source: r.source_model_id, target: r.target_model_id }));
    const cx = (cssSizeRef.current.width / 2 - config.viewportPanX) / config.viewportZoom;
    const cy = (cssSizeRef.current.height / 2 - config.viewportPanY) / config.viewportZoom;
    const changed = simulateForceLayout(nodes, edges, { x: cx, y: cy });
    if (!changed) {
      return;
    }
    for (const n of nodes) {
      if (n.fixed) {
        continue;
      }
      const layout = data.getLayout(n.id);
      if (!layout) {
        continue;
      }
      const pos = centerToTopLeft(n.x, n.y);
      if (layout.position.x !== pos.x || layout.position.y !== pos.y) {
        data.setLayout({ ...layout, position: pos });
        forceMovedRef.current.add(n.id);
      }
    }
  }, [config, data, layerVisibility]);

  const flushForceLayoutDirty = useCallback((): void => {
    if (forceWasEnabledRef.current && !config.forceLayoutEnabled) {
      for (const id of forceMovedRef.current) {
        graphSync.markModelDirty(id);
      }
      forceMovedRef.current.clear();
      forceNodesRef.current = null;
    }
    forceWasEnabledRef.current = config.forceLayoutEnabled;
  }, [config.forceLayoutEnabled, graphSync]);

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }
    const st = interactionRef.current;
    const pW = toWorld(pointerRef.current.x, pointerRef.current.y);
    let linkPreview: ReturnType<typeof segmentFromNodeTowardPoint> | null = null;
    if (st === 'LINKING' && linkSourceRef.current) {
      const src = placed().find((p) => p.model.id === linkSourceRef.current);
      if (src) {
        linkPreview = segmentFromNodeTowardPoint(src, pW.x, pW.y);
      }
    }
    const visibility = data.getLayerVisibilitySnapshot();
    const queryVisualActive = queryMode || isQueryDesignerMode(modes.mode);
    const layerVisualActive = modes.mode === 'page' || data.layerTreePanelOpen;
    const hoveredLayerPageId = layerVisualActive ? data.hoveredLayerPageId : undefined;
    const pageMembership = hoveredLayerPageId
      ? data.getLayerPageMembershipSnapshot(hoveredLayerPageId)
      : undefined;
    const mutedNodeIds = layerVisualActive ? new Set(visibility.mutedNodeIds) : new Set<string>();
    const mutedRelationIds = layerVisualActive
      ? new Set(visibility.mutedRelationIds)
      : new Set<string>();
    if (pageMembership) {
      for (const model of data.models) {
        if (!pageMembership.nodeIds.has(model.id)) {
          mutedNodeIds.add(model.id);
        }
      }
      for (const relation of data.relations) {
        if (!pageMembership.relationIds.has(relation.id)) {
          mutedRelationIds.add(relation.id);
        }
      }
    }
    const queryHighlightRelationIds = new Set(queryRelationIds ?? []);
    const queryCandidateIds = queryCandidateRelationIds ?? new Set<string>();
    if (queryVisualActive) {
      const chainNodeIds = queryModelIds ?? new Set<string>();
      for (const model of data.models) {
        if (!chainNodeIds.has(model.id)) {
          mutedNodeIds.add(model.id);
        }
      }
      for (const relation of data.relations) {
        if (!queryHighlightRelationIds.has(relation.id) && !queryCandidateIds.has(relation.id)) {
          mutedRelationIds.add(relation.id);
        }
      }
    }
    paintScene({
      ctx,
      width: cssSizeRef.current.width,
      height: cssSizeRef.current.height,
      data,
      config,
      selectedModelId,
      selectedRelationId,
      hoveredModelId,
      hoveredRelationId,
      hiddenNodeIds: visibility.hiddenNodeIds,
      hiddenRelationIds: visibility.hiddenRelationIds,
      mutedNodeIds,
      mutedRelationIds,
      highlightNodeIds: queryVisualActive ? queryModelIds : pageMembership?.nodeIds,
      highlightRelationIds: queryVisualActive
        ? queryHighlightRelationIds
        : pageMembership?.relationIds,
      candidateRelationIds: queryVisualActive ? queryCandidateIds : undefined,
      constraintRelationIds: queryVisualActive ? queryConstraintRelationIds : undefined,
      linkPreview,
      uiLocale: i18n.locale,
      snapGuides,
    });
  }, [
    config,
    data,
    modes.mode,
    selectedModelId,
    selectedRelationId,
    hoveredModelId,
    hoveredRelationId,
    queryMode,
    queryModelIds,
    queryRelationIds,
    queryConstraintRelationIds,
    queryCandidateRelationIds,
    placed,
    toWorld,
    i18n.locale,
    snapGuides,
  ]);

  useEffect(() => {
    const loop = (): void => {
      if (config.forceLayoutEnabled) {
        tickForceLayout();
      } else {
        flushForceLayoutDirty();
      }
      paint();
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [paint, tickForceLayout, flushForceLayoutDirty, config.forceLayoutEnabled]);

  useEffect(() => {
    const onGesture = (g: GestureKind): void => {
      const mode = modesRef.current;
      const sx = g.x;
      const sy = g.y;
      const w = toWorld(sx, sy);
      // 仅选择模式：长按进入连线（新建模式用 Ctrl+单击拖线）
      if (g.type === 'long_press' && mode === 'link') {
        const id = hitAt(sx, sy);
        if (!id || !canStartLinkGesture(interactionRef.current)) {
          return;
        }
        linkingFromAddCtrlRef.current = false;
        linkSourceRef.current = id;
        state.transition('LINKING');
        return;
      }
      if (g.type === 'click') {
        applyCanvasPick(sx, sy);
        return;
      }
      if (g.type === 'double_click' && mode === 'add') {
        if (
          interactionRef.current !== 'ADD_NODE' &&
          interactionRef.current !== 'SELECT' &&
          interactionRef.current !== 'LINK'
        ) {
          return;
        }
        const under = hitAt(sx, sy);
        const target = under ?? selectedModelId;
        if (!target) {
          return;
        }
        // 鼠标点 = 克隆体中心，故减去半径转回左上角存储。
        const nid = data.cloneModel(target, { x: w.x - NODE_RADIUS, y: w.y - NODE_RADIUS });
        if (nid) {
          onSelectModel(nid);
        }
        state.transition(interactionStateForToolMode(modesRef.current));
        return;
      }
    };
    events.setGestureHandler(onGesture);
    return () => events.setGestureHandler(() => {});
  }, [
    data,
    events,
    hitAt,
    applyCanvasPick,
    state,
    selectedModelId,
    onSelectModel,
    onSelectRelation,
    toWorld,
  ]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const onPointerDown = (ev: PointerEvent): void => {
      const { x, y } = clientToCanvas(canvas, ev.clientX, ev.clientY);
      pointerRef.current = { x, y };
      const w = toWorld(x, y);
      const hit = hitAt(x, y);
      const st = interactionRef.current;
      const tool = modesRef.current;

      if (ev.button === 1 || (ev.button === 0 && spaceDownRef.current)) {
        panDragRef.current = { lastX: x, lastY: y, startX: x, startY: y, moved: true };
        canvas.setPointerCapture(ev.pointerId);
        return;
      }

      // 新建模式 + Ctrl+单击：进入拖线（释放在目标上建正向边，在空白上建子模型）
      if (
        tool === 'add' &&
        (ev.ctrlKey || ev.metaKey) &&
        hit &&
        ev.button === 0 &&
        (st === 'SELECT' || st === 'ADD_NODE')
      ) {
        linkingFromAddCtrlRef.current = true;
        linkSourceRef.current = hit;
        state.transition('LINKING');
        bump((n) => n + 1);
        canvas.setPointerCapture(ev.pointerId);
        return;
      }

      const canDragNode =
        (tool === 'select' || tool === 'add') &&
        !!hit &&
        !data.isModelPositionLocked(hit) &&
        ev.button === 0 &&
        !ev.ctrlKey &&
        !ev.metaKey &&
        (st === 'SELECT' || st === 'ADD_NODE');
      if (canDragNode) {
        const layout = data.getLayout(hit!);
        const startCenterX = (layout?.position.x ?? 0) + NODE_RADIUS;
        const startCenterY = (layout?.position.y ?? 0) + NODE_RADIUS;
        const relationStates = data.relations
          .filter(
            (r) =>
              !data.isRelationLocked(r.id) &&
              (r.source_model_id === hit || r.target_model_id === hit),
          )
          .flatMap((r) => {
            const meta = data.getRelationCanvasMeta(r.id);
            if (r.source_model_id === r.target_model_id) {
              if (!meta.self_loop_anchor) {
                return [];
              }
              return [{ relationId: r.id, selfAnchor: meta.self_loop_anchor }];
            }
            const state: {
              relationId: string;
              forwardBend?: { x: number; y: number };
              reverseBend?: { x: number; y: number };
              pairBend?: { x: number; y: number };
              selfAnchor?: { x: number; y: number };
            } = {
              relationId: r.id,
            };
            if (meta.forward_bend) {
              state.forwardBend = meta.forward_bend;
            }
            if (!isInheritRelation(r.kind) && meta.pair_bend) {
              state.pairBend = meta.pair_bend;
            }
            if (!isInheritRelation(r.kind) && meta.reverse_bend) {
              state.reverseBend = meta.reverse_bend;
            }
            return state.forwardBend || state.reverseBend || state.pairBend ? [state] : [];
          });
        nodeDragRef.current = {
          id: hit!,
          startCenterX,
          startCenterY,
          relationStates,
          startWorldX: w.x,
          startWorldY: w.y,
          startCanvasX: x,
          startCanvasY: y,
          moved: false,
        };
        if (forceNodesRef.current) {
          const fn = forceNodesRef.current.find((n) => n.id === hit);
          if (fn) {
            fn.fixed = true;
          }
        }
        canvas.setPointerCapture(ev.pointerId);
        return;
      }

      const relHit = !hit && tool === 'select' ? hitRelationAt(x, y) : undefined;
      const canBendRelation =
        !!relHit &&
        !data.isRelationLocked(relHit.id) &&
        ev.button === 0 &&
        !ev.ctrlKey &&
        !ev.metaKey &&
        st === 'SELECT';
      if (canBendRelation && relHit) {
        const rel = data.relations.find((r) => r.id === relHit.id);
        const meta = data.getRelationCanvasMeta(relHit.id);
        const startAnchor = { x: w.x, y: w.y };
        let startForwardBend = meta.forward_bend ?? startAnchor;
        let startPairBend: { x: number; y: number } | undefined;
        let defaultPairBend: { x: number; y: number } | undefined;
        let startSelfAnchor: { x: number; y: number } | undefined;
        let dragKind: 'pair' | 'inherit' | 'self' = 'pair';
        if (rel && rel.source_model_id === rel.target_model_id) {
          dragKind = 'self';
          const source = placed().find((p) => p.model.id === rel.source_model_id);
          const slot = edgeSelfLoopSlotById(data.relations).get(rel.id) ?? 0;
          startSelfAnchor =
            meta.self_loop_anchor ?? (source ? selfLoopDefaultAnchor(source, slot) : startAnchor);
        } else if (rel) {
          const nodes = placed();
          const source = nodes.find((p) => p.model.id === rel.source_model_id);
          const target = nodes.find((p) => p.model.id === rel.target_model_id);
          if (source && target) {
            const slotOff = edgePerpOffsetById(data.relations).get(rel.id) ?? 0;
            if (isInheritRelation(rel.kind)) {
              dragKind = 'inherit';
              const forwardSeg = directedCurvedSegment(source, target, slotOff, meta.forward_bend);
              startForwardBend = meta.forward_bend ?? { x: forwardSeg.cpx, y: forwardSeg.cpy };
            } else {
              defaultPairBend = relationPairDefaultAnchor(source, target);
              const forwardSeg = directedCurvedSegment(
                source,
                target,
                slotOff + RELATION_INTRA_PAIR_GAP,
                meta.forward_bend,
              );
              const reverseSeg = directedCurvedSegment(
                target,
                source,
                -(slotOff - RELATION_INTRA_PAIR_GAP),
                meta.reverse_bend,
              );
              if (meta.pair_bend) {
                startPairBend = meta.pair_bend;
              } else if (meta.forward_bend || meta.reverse_bend) {
                const dx = target.x - source.x;
                const dy = target.y - source.y;
                const len = Math.hypot(dx, dy);
                const px = len < 1e-6 ? 0 : -dy / len;
                const py = len < 1e-6 ? 1 : dx / len;
                startPairBend = {
                  x: (forwardSeg.cpx + reverseSeg.cpx) / 2 - px * slotOff,
                  y: (forwardSeg.cpy + reverseSeg.cpy) / 2 - py * slotOff,
                };
              } else {
                startPairBend = defaultPairBend;
              }
            }
          }
        }
        const startRelationSnapPoint =
          startSelfAnchor ?? startPairBend ?? startForwardBend ?? startAnchor;
        relationDragRef.current = {
          relationId: relHit.id,
          dragKind,
          startForwardBend,
          startPairBend,
          defaultPairBend,
          startSelfAnchor,
          startSnapX: startRelationSnapPoint.x,
          startSnapY: startRelationSnapPoint.y,
          startWorldX: w.x,
          startWorldY: w.y,
          startCanvasX: x,
          startCanvasY: y,
          moved: false,
        };
        onSelectRelation(relHit.id);
        canvas.setPointerCapture(ev.pointerId);
        return;
      }

      if (st === 'LINKING') {
        return;
      }

      // 空白拖动画布：优先级最低；仅当未命中上述逻辑且未按修饰键时执行（与工具模式无关）
      if (
        ev.button === 0 &&
        !hit &&
        !ev.ctrlKey &&
        !ev.metaKey &&
        isIdleCanvasInteractionState(st)
      ) {
        panDragRef.current = { lastX: x, lastY: y, startX: x, startY: y, moved: false };
        canvas.setPointerCapture(ev.pointerId);
        return;
      }

      events.handlePointerDown({ x, y, time: performance.now() }, ev);
    };

    const onPointerMove = (ev: PointerEvent): void => {
      const { x, y } = clientToCanvas(canvas, ev.clientX, ev.clientY);
      pointerRef.current = { x, y };
      const w = toWorld(x, y);

      if (panDragRef.current) {
        const d = panDragRef.current;
        if (Math.hypot(x - d.startX, y - d.startY) > DRAG_THRESHOLD_CANVAS) {
          d.moved = true;
        }
        config.addViewportPan(x - d.lastX, y - d.lastY);
        panDragRef.current = { ...d, lastX: x, lastY: y };
        return;
      }

      if (nodeDragRef.current) {
        const d = nodeDragRef.current;
        if (Math.hypot(x - d.startCanvasX, y - d.startCanvasY) > DRAG_THRESHOLD_CANVAS) {
          d.moved = true;
        }
        const layout = data.getLayout(d.id);
        if (layout && !data.isModelPositionLocked(d.id)) {
          const totalDx = w.x - d.startWorldX;
          const totalDy = w.y - d.startWorldY;
          const proposedCx = d.startCenterX + totalDx;
          const proposedCy = d.startCenterY + totalDy;
          const snapped = snapNodeTopLeft(
            d.id,
            proposedCx,
            proposedCy,
            snapPeers(),
            snapDragOptions(),
          );
          setSnapGuides(snapped.guides);
          data.setLayout({ ...layout, position: snapped.position });
          const snappedDx = snapped.position.x + NODE_RADIUS - d.startCenterX;
          const snappedDy = snapped.position.y + NODE_RADIUS - d.startCenterY;
          for (const relState of d.relationStates) {
            if (data.isRelationLocked(relState.relationId)) {
              continue;
            }
            if (relState.selfAnchor) {
              data.patchRelationCanvasMeta(relState.relationId, {
                self_loop_anchor: {
                  x: relState.selfAnchor.x + snappedDx,
                  y: relState.selfAnchor.y + snappedDy,
                },
              });
              continue;
            }
            if (relState.pairBend) {
              data.patchRelationCanvasMeta(relState.relationId, {
                pair_bend: {
                  x: relState.pairBend.x + snappedDx,
                  y: relState.pairBend.y + snappedDy,
                },
              });
              continue;
            }
            data.patchRelationCanvasMeta(relState.relationId, {
              ...(relState.forwardBend
                ? {
                    forward_bend: {
                      x: relState.forwardBend.x + snappedDx,
                      y: relState.forwardBend.y + snappedDy,
                    },
                  }
                : {}),
              ...(relState.reverseBend
                ? {
                    reverse_bend: {
                      x: relState.reverseBend.x + snappedDx,
                      y: relState.reverseBend.y + snappedDy,
                    },
                  }
                : {}),
            });
          }
          if (forceNodesRef.current) {
            const fn = forceNodesRef.current.find((n) => n.id === d.id);
            if (fn) {
              fn.x = snapped.position.x + NODE_RADIUS;
              fn.y = snapped.position.y + NODE_RADIUS;
              fn.vx = 0;
              fn.vy = 0;
            }
          }
        }
        nodeDragRef.current = { ...d, moved: d.moved };
        return;
      }

      if (relationDragRef.current) {
        const d = relationDragRef.current;
        if (!data.isRelationLocked(d.relationId)) {
          if (Math.hypot(x - d.startCanvasX, y - d.startCanvasY) > DRAG_THRESHOLD_CANVAS) {
            d.moved = true;
          }
          const totalDx = w.x - d.startWorldX;
          const totalDy = w.y - d.startWorldY;
          const snapped = snapWorldPoint(
            d.startSnapX + totalDx,
            d.startSnapY + totalDy,
            snapPeers(),
            undefined,
            snapDragOptions(),
          );
          setSnapGuides(snapped.guides);
          const snappedDx = snapped.x - d.startSnapX;
          const snappedDy = snapped.y - d.startSnapY;
          if (d.dragKind === 'self' && d.startSelfAnchor) {
            data.patchRelationCanvasMeta(d.relationId, {
              self_loop_anchor: {
                x: d.startSelfAnchor.x + snappedDx,
                y: d.startSelfAnchor.y + snappedDy,
              },
            });
          } else if (d.dragKind === 'pair' && d.startPairBend && d.defaultPairBend) {
            const pairBend = {
              x: d.startPairBend.x + snappedDx,
              y: d.startPairBend.y + snappedDy,
            };
            const resetThreshold = RELATION_PAIR_RESET_THRESHOLD_CANVAS / config.viewportZoom;
            const resetToParallel =
              Math.hypot(pairBend.x - d.defaultPairBend.x, pairBend.y - d.defaultPairBend.y) <=
              resetThreshold;
            data.patchRelationCanvasMeta(d.relationId, {
              pair_bend: resetToParallel ? undefined : pairBend,
              forward_bend: undefined,
              reverse_bend: undefined,
            });
          } else {
            const forward = d.startForwardBend
              ? { x: d.startForwardBend.x + snappedDx, y: d.startForwardBend.y + snappedDy }
              : undefined;
            data.patchRelationCanvasMeta(d.relationId, {
              ...(forward ? { forward_bend: forward } : {}),
            });
          }
        }
        relationDragRef.current = { ...d, moved: d.moved };
        return;
      }

      const ist = interactionRef.current;
      if (ist === 'LINKING') {
        return;
      }
      updateHoverAt(x, y);
      events.handlePointerMove({ x, y, time: performance.now() });
    };

    const onPointerUp = (ev: PointerEvent): void => {
      const { x, y } = clientToCanvas(canvas, ev.clientX, ev.clientY);
      pointerRef.current = { x, y };

      if (panDragRef.current) {
        const d = panDragRef.current;
        panDragRef.current = null;
        setSnapGuides([]);
        try {
          canvas.releasePointerCapture(ev.pointerId);
        } catch {
          /* ignore */
        }
        if (!d.moved) {
          applyCanvasPick(x, y);
        }
        return;
      }

      if (nodeDragRef.current) {
        const moved = nodeDragRef.current.moved;
        const draggedId = nodeDragRef.current.id;
        const movedRelationIds = nodeDragRef.current.relationStates.map((r) => r.relationId);
        nodeDragRef.current = null;
        setSnapGuides([]);
        if (forceNodesRef.current) {
          const fn = forceNodesRef.current.find((n) => n.id === draggedId);
          if (fn) {
            fn.fixed = false;
          }
        }
        try {
          canvas.releasePointerCapture(ev.pointerId);
        } catch {
          /* ignore */
        }
        if (!moved) {
          applyCanvasPick(x, y);
        } else {
          graphSync.markModelDirty(draggedId);
          for (const relationId of movedRelationIds) {
            graphSync.markRelationDirty(relationId);
          }
        }
        return;
      }

      if (relationDragRef.current) {
        const moved = relationDragRef.current.moved;
        const relationId = relationDragRef.current.relationId;
        relationDragRef.current = null;
        setSnapGuides([]);
        try {
          canvas.releasePointerCapture(ev.pointerId);
        } catch {
          /* ignore */
        }
        if (moved) {
          graphSync.markRelationDirty(relationId);
        } else {
          applyCanvasPick(x, y);
        }
        return;
      }

      const st = interactionRef.current;

      if (st === 'LINKING') {
        const src = linkSourceRef.current;
        linkSourceRef.current = undefined;
        const tgt = hitAt(x, y);
        if (linkingFromAddCtrlRef.current) {
          linkingFromAddCtrlRef.current = false;
          if (modesRef.current === 'add') {
            if (src && tgt) {
              // 允许 src === tgt（自关联）。
              const edgeId = graphLink.linkNodes(src, tgt);
              if (edgeId) {
                onSelectRelation(edgeId);
              } else {
                onSelectModel(tgt);
              }
            } else if (src && !tgt) {
              const wu = toWorld(x, y);
              // 鼠标释放点 = 子节点中心。
              const out = data.createChildModel(src, {
                x: wu.x - NODE_RADIUS,
                y: wu.y - NODE_RADIUS,
              });
              if (out) {
                onSelectModel(out.modelId);
              }
            }
          }
        } else if (src && tgt) {
          // 允许 src === tgt（自关联）。
          const edgeId = graphLink.linkNodes(src, tgt);
          if (edgeId) {
            onSelectRelation(edgeId);
          }
        }
        state.transition(interactionStateForToolMode(modesRef.current));
        try {
          canvas.releasePointerCapture(ev.pointerId);
        } catch {
          /* ignore */
        }
        return;
      }

      events.handlePointerUp({ x, y, time: performance.now() }, ev);
    };

    const onWheel = (ev: WheelEvent): void => {
      ev.preventDefault();
      const { x, y } = clientToCanvas(canvas, ev.clientX, ev.clientY);
      const delta = ev.deltaY > 0 ? -0.08 : 0.08;
      config.setViewportZoomAtCanvasPoint(x, y, config.viewportZoom + delta);
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    const onPointerLeave = (): void => {
      setHoveredModelId(undefined);
      setHoveredRelationId(undefined);
    };
    canvas.addEventListener('pointerleave', onPointerLeave);
    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerleave', onPointerLeave);
    };
  }, [
    data,
    events,
    hitAt,
    state,
    graphLink,
    config,
    toWorld,
    applyCanvasPick,
    onSelectModel,
    onSelectRelation,
    graphSync,
    updateHoverAt,
    snapPeers,
    snapDragOptions,
  ]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    /**
     * 单一权威 resize 入口：
     * - backing buffer = CSS px × dpr（避免高 DPI 上模糊）；
     * - `ctx.setTransform(dpr, …)` 让 user-space ≡ CSS px，便于业务代码沿用屏幕像素心智模型；
     * - 将 CSS 尺寸写入 `cssSizeRef`，供 paint() 读取（不再读 `canvas.width`，那是 backing px）。
     */
    const resize = (): void => {
      const parent = canvas.parentElement;
      if (!parent) {
        return;
      }
      const dpr = window.devicePixelRatio || 1;
      const w = parent.clientWidth;
      const h = parent.clientHeight;
      const targetW = Math.max(1, Math.floor(w * dpr));
      const targetH = Math.max(1, Math.floor(h * dpr));
      if (canvas.width !== targetW) {
        canvas.width = targetW;
      }
      if (canvas.height !== targetH) {
        canvas.height = targetH;
      }
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      cssSizeRef.current = { width: w, height: h };
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas.parentElement!);

    // DPR 变化（浏览器缩放、跨显示器拖动到不同 scaling 的屏）不一定改变 CSS 尺寸，
    // 因此 ResizeObserver 可能不触发。这里订阅 `matchMedia('(resolution: <dpr>dppx)')`：
    // DPR 一旦不再匹配，change 事件触发，重新 resize 并以**新**的 dpr 重新订阅。
    let mql: MediaQueryList | null = null;
    const onDprChange = (): void => {
      resize();
      subscribeDpr();
    };
    const subscribeDpr = (): void => {
      mql?.removeEventListener('change', onDprChange);
      mql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      mql.addEventListener('change', onDprChange);
    };
    subscribeDpr();
    // 兜底：某些浏览器在 DPR 改变时也会触发 window resize；统一走 resize。
    window.addEventListener('resize', resize);

    return () => {
      ro.disconnect();
      mql?.removeEventListener('change', onDprChange);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{
        display: 'block',
        width: '100%',
        height: '100%',
        touchAction: 'none',
        cursor: spacePan ? 'grab' : 'default',
      }}
      aria-label="Model canvas"
    />
  );
}

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { useDesigner } from '../context/designer-context.js';
import { buildPlacedNodes, hitTestNode, hitTestRelation } from '../canvas/hit-test.js';
import { NODE_RADIUS } from '../canvas/node-geometry.js';
import { segmentFromNodeTowardPoint } from '../canvas/relation-geometry.js';
import { paintScene } from '../canvas/paint-scene.js';
import { CANVAS_VISUAL } from '../config/canvas-visual.js';
import { isInheritRelation } from '../config/graph-edge-kinds.js';
import type { GestureKind } from '../managers/event-manager.js';
import type { InteractionState } from '../managers/state-manager.js';

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

export function CanvasContainer(props: {
  selectedModelId: string | undefined;
  selectedRelationId: string | undefined;
  onSelectModel: (id: string | undefined) => void;
  onSelectRelation: (id: string | undefined) => void;
}): ReactElement {
  const { state, events, config, data, graphLink, modes, i18n, graphSync } = useDesigner();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);
  /** 画布当前 CSS 像素尺寸；由 resize 写入，paint 读取 —— 与绘制 ctx 的 `setTransform(dpr,…)` 配套。 */
  const cssSizeRef = useRef<{ width: number; height: number }>({ width: 0, height: 0 });
  const [, bump] = useState(0);
  const [hoveredModelId, setHoveredModelId] = useState<string | undefined>(undefined);
  const [hoveredRelationId, setHoveredRelationId] = useState<string | undefined>(undefined);
  const { selectedModelId, selectedRelationId, onSelectModel, onSelectRelation } = props;

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
    lastX: number;
    lastY: number;
    startX: number;
    startY: number;
    startCanvasX: number;
    startCanvasY: number;
    moved: boolean;
  } | null>(null);
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
        state.transition('SELECT');
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

  const hiddenIds = useCallback(() => data.getHiddenNodeIdsForLayerVisibility(), [data]);

  const hitAt = useCallback(
    (screenX: number, screenY: number) => {
      const w = toWorld(screenX, screenY);
      return hitTestNode(w.x, w.y, placed(), getZIndex, hiddenIds());
    },
    [placed, getZIndex, hiddenIds, toWorld],
  );

  const hitRelationAt = useCallback(
    (screenX: number, screenY: number) => {
      const w = toWorld(screenX, screenY);
      const thresholdWorld = REL_HIT_THRESHOLD / config.viewportZoom;
      return hitTestRelation(w.x, w.y, data.relations, placed(), hiddenIds(), thresholdWorld);
    },
    [data, placed, hiddenIds, config.viewportZoom, toWorld],
  );

  const applyCanvasPick = useCallback(
    (sx: number, sy: number): void => {
      const st = interactionRef.current;
      const mode = modesRef.current;
      const w = toWorld(sx, sy);
      const nodeId = hitAt(sx, sy);
      const relId = nodeId ? undefined : hitRelationAt(sx, sy);
      if (st === 'LINKING') {
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
        const themes = config.getThemes();
        const themeId = themes[0]!.id;
        const nid = crypto.randomUUID();
        // 用户期望「点击位置 = 节点中心」；存储约定 `position` 为外接正方形左上角，故减去半径。
        data.upsertModel(
          {
            id: nid,
            model_name: `model_${Date.now()}`,
            parent_id: null,
            // 新建模型：默认不带任何字段（由 Props 面板手动添加）。
            props_objects_array: [],
            name_i18n: { zh: '新模型', en: 'NewModel', ja: '新規モデル' },
          },
          {
            position: { x: w.x - NODE_RADIUS, y: w.y - NODE_RADIUS },
            color_theme: themeId,
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
    [hitAt, hitRelationAt, toWorld, data, config, graphLink, onSelectModel, onSelectRelation],
  );

  const updateHoverAt = useCallback(
    (screenX: number, screenY: number): void => {
      const st = interactionRef.current;
      if (st === 'LINKING' || panDragRef.current || nodeDragRef.current) {
        setHoveredModelId(undefined);
        setHoveredRelationId(undefined);
        return;
      }
      const nodeId = hitAt(screenX, screenY);
      let relId = nodeId ? undefined : hitRelationAt(screenX, screenY);
      if (relId) {
        const rel = data.relations.find((r) => r.id === relId);
        if (rel && isInheritRelation(rel.kind)) {
          relId = undefined;
        }
      }
      setHoveredModelId(nodeId);
      setHoveredRelationId(relId);
    },
    [hitAt, hitRelationAt],
  );

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
      hiddenNodeIds: data.getHiddenNodeIdsForLayerVisibility(),
      linkPreview,
      uiLocale: i18n.locale,
    });
  }, [
    config,
    data,
    selectedModelId,
    selectedRelationId,
    hoveredModelId,
    hoveredRelationId,
    placed,
    toWorld,
    i18n.locale,
  ]);

  useEffect(() => {
    const loop = (): void => {
      paint();
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [paint]);

  useEffect(() => {
    const onGesture = (g: GestureKind): void => {
      const mode = modesRef.current;
      const sx = g.x;
      const sy = g.y;
      const w = toWorld(sx, sy);
      // 仅选择模式：长按进入连线（新建模式用 Ctrl+单击拖线）
      if (g.type === 'long_press' && mode === 'link') {
        const id = hitAt(sx, sy);
        if (!id || (interactionRef.current !== 'SELECT' && interactionRef.current !== 'ADD_NODE')) {
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
        if (interactionRef.current !== 'ADD_NODE' && interactionRef.current !== 'SELECT') {
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
        state.transition('SELECT');
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
        tool === 'add' &&
        !!hit &&
        ev.button === 0 &&
        !ev.ctrlKey &&
        !ev.metaKey &&
        (st === 'SELECT' || st === 'ADD_NODE');
      if (canDragNode) {
        nodeDragRef.current = {
          id: hit!,
          lastX: w.x,
          lastY: w.y,
          startX: w.x,
          startY: w.y,
          startCanvasX: x,
          startCanvasY: y,
          moved: false,
        };
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
        (st === 'SELECT' || st === 'ADD_NODE')
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
        const layout = data.getLayout(d.id);
        if (layout) {
          const dx = w.x - d.lastX;
          const dy = w.y - d.lastY;
          if (Math.hypot(x - d.startCanvasX, y - d.startCanvasY) > DRAG_THRESHOLD_CANVAS) {
            d.moved = true;
          }
          data.setLayout({
            ...layout,
            position: { x: layout.position.x + dx, y: layout.position.y + dy },
          });
        }
        nodeDragRef.current = {
          id: d.id,
          lastX: w.x,
          lastY: w.y,
          startX: d.startX,
          startY: d.startY,
          startCanvasX: d.startCanvasX,
          startCanvasY: d.startCanvasY,
          moved: d.moved,
        };
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
        nodeDragRef.current = null;
        try {
          canvas.releasePointerCapture(ev.pointerId);
        } catch {
          /* ignore */
        }
        if (!moved) {
          applyCanvasPick(x, y);
        } else {
          graphSync.markModelDirty(draggedId);
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
        state.transition('SELECT');
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

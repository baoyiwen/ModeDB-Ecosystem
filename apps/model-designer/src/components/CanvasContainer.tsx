import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { useDesigner } from '../context/designer-context.js';
import { buildPlacedNodes, hitTestNode, hitTestRelation } from '../canvas/hit-test.js';
import { segmentFromNodeTowardPoint } from '../canvas/relation-geometry.js';
import { paintScene } from '../canvas/paint-scene.js';
import type { GestureKind } from '../managers/event-manager.js';
import type { InteractionState } from '../managers/state-manager.js';
import { DataType, dataTypeToEngineCode } from '../config/engine-prop-types.js';
import type { PropObject } from '../types/prop-object.js';

function clientToCanvas(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (clientX - rect.left) * scaleX,
    y: (clientY - rect.top) * scaleY,
  };
}

const REL_HIT_THRESHOLD = 16;
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
  const [, bump] = useState(0);
  const { selectedModelId, selectedRelationId, onSelectModel, onSelectRelation } = props;

  const interactionRef = useRef<InteractionState>('SELECT');
  const linkSourceRef = useRef<string | undefined>(undefined);
  const pointerRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const inheritParentRef = useRef<string | undefined>(undefined);
  const ctrlDragRef = useRef(false);
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
      if (e.code === 'Space') {
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
        inheritParentRef.current = undefined;
        ctrlDragRef.current = false;
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

  const getRelationKindLabel = useCallback(
    (kind: string) => {
      const key = `relationKind_${kind}`;
      const v = i18n.t('engine', key);
      return v === key ? kind : v;
    },
    [i18n],
  );

  const applyCanvasPick = useCallback(
    (sx: number, sy: number): void => {
      const st = interactionRef.current;
      const mode = modesRef.current;
      const w = toWorld(sx, sy);
      const nodeId = hitAt(sx, sy);
      const relId = nodeId ? undefined : hitRelationAt(sx, sy);
      if (st === 'LINKING' || st === 'INHERITING') {
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
        const prop: PropObject = {
          id: crypto.randomUUID(),
          name: 'field_1',
          name_i18n: { zh: '字段1', en: 'Field 1', ja: 'フィールド1' },
          type: DataType.String,
          is_primary: true,
          encrypt_level: 0,
          metadata: {},
          engine_type: dataTypeToEngineCode(DataType.String),
          sort: 0,
          is_required: false,
          description_i18n: {},
          vault_key: '',
        };
        data.upsertModel(
          {
            id: nid,
            model_name: `model_${Date.now()}`,
            parent_id: null,
            props_objects_array: [prop],
            name_i18n: { zh: '新模型', en: 'NewModel', ja: '新規モデル' },
          },
          { position: { x: w.x, y: w.y }, color_theme: themeId, z_index: 1 },
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
          } else if (first !== nodeId) {
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
        onSelectRelation(relId);
      } else {
        onSelectModel(undefined);
      }
    },
    [hitAt, hitRelationAt, toWorld, data, config, graphLink, onSelectModel, onSelectRelation],
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
    let inheritPreview: ReturnType<typeof segmentFromNodeTowardPoint> | null = null;
    if (st === 'LINKING' && linkSourceRef.current) {
      const src = placed().find((p) => p.model.id === linkSourceRef.current);
      if (src) {
        linkPreview = segmentFromNodeTowardPoint(src, pW.x, pW.y);
      }
    }
    if (st === 'INHERITING' && inheritParentRef.current) {
      const src = placed().find((p) => p.model.id === inheritParentRef.current);
      if (src) {
        inheritPreview = segmentFromNodeTowardPoint(src, pW.x, pW.y);
      }
    }
    paintScene({
      ctx,
      width: canvas.width,
      height: canvas.height,
      data,
      config,
      selectedModelId,
      selectedRelationId,
      hiddenNodeIds: data.getHiddenNodeIdsForLayerVisibility(),
      linkPreview,
      inheritPreview,
      getRelationKindLabel,
      uiLocale: i18n.locale,
    });
  }, [
    config,
    data,
    selectedModelId,
    selectedRelationId,
    placed,
    toWorld,
    getRelationKindLabel,
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
      if (g.type === 'long_press' && mode !== 'link' && mode === 'select') {
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
      if (g.type === 'double_click') {
        if (interactionRef.current !== 'ADD_NODE' || mode !== 'select') {
          return;
        }
        const under = hitAt(sx, sy);
        const target = under ?? selectedModelId;
        if (!target) {
          return;
        }
        const nid = data.cloneModel(target, { x: w.x, y: w.y });
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

      // 新建模式 + Ctrl+单击：立即进入拖线（释放在目标上建正向边，在空白上建子模型）
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

      // 选择/删除/链接等非「新建」模式下 Ctrl+拖拽：继承落子
      if ((ev.ctrlKey || ev.metaKey) && hit && tool !== 'add') {
        ctrlDragRef.current = true;
        inheritParentRef.current = hit;
        state.transition('INHERITING');
        canvas.setPointerCapture(ev.pointerId);
        return;
      }
      if (st === 'LINKING' || st === 'INHERITING') {
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
      if (ist === 'LINKING' || ist === 'INHERITING') {
        return;
      }
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

      if (ctrlDragRef.current || st === 'INHERITING') {
        const parent = inheritParentRef.current;
        ctrlDragRef.current = false;
        inheritParentRef.current = undefined;
        if (parent && st === 'INHERITING') {
          const targetHit = hitAt(x, y);
          if (!targetHit) {
            const wu = toWorld(x, y);
            const out = data.createChildModel(parent, { x: wu.x, y: wu.y });
            if (out) {
              onSelectRelation(out.inheritEdgeId);
            }
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

      if (st === 'LINKING') {
        const src = linkSourceRef.current;
        linkSourceRef.current = undefined;
        const tgt = hitAt(x, y);
        if (linkingFromAddCtrlRef.current) {
          linkingFromAddCtrlRef.current = false;
          if (src && tgt && tgt !== src) {
            const edgeId = graphLink.linkNodes(src, tgt);
            if (edgeId) {
              onSelectRelation(edgeId);
            } else {
              onSelectModel(tgt);
            }
          } else if (src && !tgt) {
            const wu = toWorld(x, y);
            const out = data.createChildModel(src, { x: wu.x, y: wu.y });
            if (out) {
              onSelectRelation(out.inheritEdgeId);
            }
          }
        } else if (src && tgt && src !== tgt) {
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
    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
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
  ]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const resize = (): void => {
      const parent = canvas.parentElement;
      if (!parent) {
        return;
      }
      const dpr = window.devicePixelRatio || 1;
      const w = parent.clientWidth;
      const h = parent.clientHeight;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas.parentElement!);
    return () => ro.disconnect();
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

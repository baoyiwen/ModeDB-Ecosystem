import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { useDesigner } from '../context/designer-context.js';
import { anchorRightCenter, buildPlacedNodes, hitTestNode } from '../canvas/hit-test.js';
import { paintScene } from '../canvas/paint-scene.js';
import type { GestureKind } from '../managers/event-manager.js';
import type { InteractionState } from '../managers/state-manager.js';

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

export function CanvasContainer(props: {
  selectedId: string | undefined;
  onSelect: (id: string | undefined) => void;
}): ReactElement {
  const { state, events, config, data, graphLink } = useDesigner();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);
  const [, bump] = useState(0);
  const { selectedId, onSelect } = props;

  const interactionRef = useRef<InteractionState>('SELECT');
  const downHitRef = useRef<string | undefined>(undefined);
  const linkSourceRef = useRef<string | undefined>(undefined);
  const pointerRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const inheritParentRef = useRef<string | undefined>(undefined);
  const ctrlDragRef = useRef(false);

  useEffect(() => {
    return data.subscribe(() => bump((n) => n + 1));
  }, [data]);

  useEffect(() => {
    return state.subscribe((s) => {
      interactionRef.current = s;
    });
  }, [state]);

  useEffect(() => {
    events.setTiming(config.longPressMs);
  }, [events, config]);

  const getZIndex = useCallback((id: string) => data.getLayout(id)?.z_index ?? 0, [data]);

  const placed = useCallback(() => {
    return buildPlacedNodes(data.models, (id) => data.getLayout(id)?.position);
  }, [data]);

  const hiddenIds = useCallback(() => data.getHiddenNodeIdsForLayerVisibility(), [data]);

  const hitAt = useCallback(
    (x: number, y: number) => hitTestNode(x, y, placed(), getZIndex, hiddenIds()),
    [placed, getZIndex, hiddenIds],
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
    let linkPreview: { x1: number; y1: number; x2: number; y2: number } | null = null;
    let inheritPreview: { x1: number; y1: number; x2: number; y2: number } | null = null;
    if (st === 'LINKING' && linkSourceRef.current) {
      const src = placed().find((p) => p.model.id === linkSourceRef.current);
      if (src) {
        const p1 = anchorRightCenter(src);
        linkPreview = { x1: p1.x, y1: p1.y, x2: pointerRef.current.x, y2: pointerRef.current.y };
      }
    }
    if (st === 'INHERITING' && inheritParentRef.current) {
      const src = placed().find((p) => p.model.id === inheritParentRef.current);
      if (src) {
        const p1 = anchorRightCenter(src);
        inheritPreview = { x1: p1.x, y1: p1.y, x2: pointerRef.current.x, y2: pointerRef.current.y };
      }
    }
    paintScene({
      ctx,
      width: canvas.width,
      height: canvas.height,
      data,
      config,
      selectedId,
      hiddenNodeIds: data.getHiddenNodeIdsForLayerVisibility(),
      linkPreview,
      inheritPreview,
    });
  }, [config, data, selectedId, placed]);

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
      const st = interactionRef.current;
      if (g.type === 'long_press') {
        const id = hitAt(g.x, g.y);
        if (!id || (st !== 'SELECT' && st !== 'ADD_NODE')) {
          return;
        }
        linkSourceRef.current = id;
        state.transition('LINKING');
        return;
      }
      if (g.type === 'click') {
        const id = hitAt(g.x, g.y);
        if (st === 'LINKING') {
          return;
        }
        if (st === 'INHERITING') {
          return;
        }
        onSelect(id);
        return;
      }
      if (g.type === 'double_click') {
        if (st !== 'ADD_NODE') {
          return;
        }
        const under = hitAt(g.x, g.y);
        const target = under ?? selectedId;
        if (!target) {
          return;
        }
        const nid = data.cloneModel(target, { x: g.x, y: g.y });
        if (nid) {
          onSelect(nid);
        }
        state.transition('SELECT');
        return;
      }
    };
    events.setGestureHandler(onGesture);
    return () => events.setGestureHandler(() => {});
  }, [data, events, hitAt, state, selectedId, onSelect]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        state.transition('SELECT');
        linkSourceRef.current = undefined;
        inheritParentRef.current = undefined;
        ctrlDragRef.current = false;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const onPointerDown = (ev: PointerEvent): void => {
      const { x, y } = clientToCanvas(canvas, ev.clientX, ev.clientY);
      pointerRef.current = { x, y };
      downHitRef.current = hitAt(x, y);
      const st = interactionRef.current;
      if (ev.ctrlKey || ev.metaKey) {
        if (downHitRef.current) {
          ctrlDragRef.current = true;
          inheritParentRef.current = downHitRef.current;
          state.transition('INHERITING');
          canvas.setPointerCapture(ev.pointerId);
        }
        return;
      }
      if (st === 'LINKING' || st === 'INHERITING') {
        return;
      }
      events.handlePointerDown({ x, y, time: performance.now() }, ev);
    };

    const onPointerMove = (ev: PointerEvent): void => {
      const { x, y } = clientToCanvas(canvas, ev.clientX, ev.clientY);
      pointerRef.current = { x, y };
      const st = interactionRef.current;
      if (st === 'LINKING' || st === 'INHERITING') {
        return;
      }
      events.handlePointerMove({ x, y, time: performance.now() });
    };

    const onPointerUp = (ev: PointerEvent): void => {
      const { x, y } = clientToCanvas(canvas, ev.clientX, ev.clientY);
      pointerRef.current = { x, y };
      const st = interactionRef.current;

      if (ctrlDragRef.current || st === 'INHERITING') {
        const parent = inheritParentRef.current;
        ctrlDragRef.current = false;
        inheritParentRef.current = undefined;
        if (parent && st === 'INHERITING') {
          const targetHit = hitAt(x, y);
          if (!targetHit) {
            data.createChildModel(parent, { x, y });
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
        const tgt = hitAt(x, y);
        linkSourceRef.current = undefined;
        if (src && tgt && src !== tgt) {
          graphLink.linkNodes(src, tgt);
        }
        state.transition('SELECT');
        return;
      }

      events.handlePointerUp({ x, y, time: performance.now() }, ev);
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
    };
  }, [data, events, hitAt, state, graphLink]);

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
      style={{ display: 'block', width: '100%', height: '100%', touchAction: 'none' }}
      aria-label="Model canvas"
    />
  );
}

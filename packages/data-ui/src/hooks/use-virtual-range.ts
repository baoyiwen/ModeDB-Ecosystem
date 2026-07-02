import { useCallback, useEffect, useState, type RefObject } from 'react';

export interface VirtualRange {
  readonly start: number;
  readonly end: number;
  readonly paddingTop: number;
  readonly paddingBottom: number;
  readonly totalHeight: number;
}

const DEFAULT_OVERSCAN = 6;

/**
 * Fixed-row-height virtual scroll range for large tables within one page.
 */
export function useVirtualRange(
  containerRef: RefObject<HTMLElement | null>,
  rowCount: number,
  rowHeight: number,
  overscan = DEFAULT_OVERSCAN,
): VirtualRange {
  const [range, setRange] = useState<VirtualRange>({
    start: 0,
    end: Math.min(rowCount, 40),
    paddingTop: 0,
    paddingBottom: 0,
    totalHeight: rowCount * rowHeight,
  });

  const recompute = useCallback((): void => {
    const el = containerRef.current;
    const totalHeight = rowCount * rowHeight;
    if (!el || rowCount === 0) {
      setRange({
        start: 0,
        end: 0,
        paddingTop: 0,
        paddingBottom: 0,
        totalHeight,
      });
      return;
    }
    const scrollTop = el.scrollTop;
    const viewHeight = el.clientHeight;
    const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
    const visibleCount = Math.ceil(viewHeight / rowHeight) + overscan * 2;
    const end = Math.min(rowCount, start + visibleCount);
    setRange({
      start,
      end,
      paddingTop: start * rowHeight,
      paddingBottom: Math.max(0, totalHeight - end * rowHeight),
      totalHeight,
    });
  }, [containerRef, rowCount, rowHeight, overscan]);

  useEffect(() => {
    recompute();
  }, [recompute, rowCount]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) {
      return;
    }
    el.addEventListener('scroll', recompute, { passive: true });
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', recompute);
      ro.disconnect();
    };
  }, [containerRef, recompute]);

  return range;
}

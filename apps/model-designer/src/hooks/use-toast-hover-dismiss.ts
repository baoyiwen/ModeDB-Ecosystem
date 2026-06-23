import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

export interface ToastHoverDismissOptions {
  /** 是否启用倒计时（如 async toast 进行中时为 false）。 */
  readonly active: boolean;
  readonly durationMs: number;
  /** 倒计时起点（毫秒时间戳）。 */
  readonly startedAt: number;
  readonly onRequestExit: () => void;
}

export interface ToastHoverDismissHandlers {
  readonly paused: boolean;
  readonly progressRef: RefObject<HTMLDivElement | null>;
  readonly handlePointerEnter: () => void;
  readonly handlePointerLeave: () => void;
  readonly handleDismissClick: () => void;
}

/**
 * Toast 自动消失 + 悬停暂停：鼠标移入停止倒计时，移出从剩余时间继续；进度条保持当前比例。
 */
export function useToastHoverDismiss(options: ToastHoverDismissOptions): ToastHoverDismissHandlers {
  const { active, durationMs, startedAt, onRequestExit } = options;
  const [paused, setPaused] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const progressRef = useRef<HTMLDivElement | null>(null);
  /** 进度条已播放时长（ms），与 dismiss 计时共享。 */
  const consumedMsRef = useRef(0);
  const endTimeRef = useRef(startedAt + durationMs);

  const clearTimer = useCallback((): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const scheduleDismiss = useCallback(
    (ms: number): void => {
      clearTimer();
      if (ms <= 0) {
        onRequestExit();
        return;
      }
      timerRef.current = setTimeout(() => {
        onRequestExit();
      }, ms);
    },
    [clearTimer, onRequestExit],
  );

  const syncConsumedFromClock = useCallback((): number => {
    const remaining = Math.max(0, endTimeRef.current - Date.now());
    const consumed = Math.min(durationMs, Math.max(0, durationMs - remaining));
    consumedMsRef.current = consumed;
    return remaining;
  }, [durationMs]);

  /** 总时长固定为 durationMs，用负 delay 表示已消耗进度（0→满宽度，duration→空）。 */
  const applyProgressBar = useCallback(
    (playState: 'running' | 'paused'): void => {
      const el = progressRef.current;
      if (!el) {
        return;
      }
      const consumed = Math.min(durationMs, Math.max(0, consumedMsRef.current));
      el.style.animationName = 'designer-notify-progress-shrink';
      el.style.animationTimingFunction = 'linear';
      el.style.animationFillMode = 'forwards';
      el.style.animationDuration = `${durationMs}ms`;
      el.style.animationDelay = `-${consumed}ms`;
      el.style.animationPlayState = playState;
    },
    [durationMs],
  );

  useEffect(() => {
    endTimeRef.current = startedAt + durationMs;
    consumedMsRef.current = Math.min(durationMs, Math.max(0, Date.now() - startedAt));
    setPaused(false);
  }, [startedAt, durationMs]);

  useLayoutEffect(() => {
    if (!active) {
      return;
    }
    applyProgressBar('running');
  }, [active, startedAt, durationMs, applyProgressBar]);

  useEffect(() => {
    if (!active || paused) {
      clearTimer();
      return;
    }
    const remaining = syncConsumedFromClock();
    scheduleDismiss(remaining);
    return clearTimer;
  }, [active, paused, scheduleDismiss, clearTimer, syncConsumedFromClock, startedAt]);

  const handlePointerEnter = useCallback((): void => {
    if (!active || paused) {
      return;
    }
    syncConsumedFromClock();
    clearTimer();
    if (progressRef.current) {
      progressRef.current.style.animationPlayState = 'paused';
    }
    setPaused(true);
  }, [active, paused, clearTimer, syncConsumedFromClock]);

  const handlePointerLeave = useCallback((): void => {
    if (!active || !paused) {
      return;
    }
    const remaining = Math.max(0, durationMs - consumedMsRef.current);
    endTimeRef.current = Date.now() + remaining;
    if (progressRef.current) {
      progressRef.current.style.animationPlayState = 'running';
    }
    setPaused(false);
    scheduleDismiss(remaining);
  }, [active, paused, durationMs, scheduleDismiss]);

  const handleDismissClick = useCallback((): void => {
    clearTimer();
    onRequestExit();
  }, [clearTimer, onRequestExit]);

  return {
    paused,
    progressRef,
    handlePointerEnter,
    handlePointerLeave,
    handleDismissClick,
  };
}

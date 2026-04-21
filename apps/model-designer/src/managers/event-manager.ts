export interface PointerSample {
  x: number;
  y: number;
  time: number;
}

export type GestureKind =
  | { type: 'click'; x: number; y: number }
  | { type: 'double_click'; x: number; y: number }
  | { type: 'long_press'; x: number; y: number };

/**
 * 统一键盘与指针；长按、双击判定后分发业务（由上层注册回调）。
 * Ctrl/拖拽继承在 Canvas 层与节点命中结合处理。
 */
export class EventManager {
  private _longPressMs = 500;
  private _moveThreshold = 6;
  private _doubleClickMs = 320;
  private _doubleClickDist = 6;
  private _clickDelayMs = 280;

  private _pressTimer: ReturnType<typeof setTimeout> | null = null;
  private _clickTimer: ReturnType<typeof setTimeout> | null = null;
  private _pointerDown: PointerSample | null = null;
  private _lastTap: PointerSample | null = null;

  private _onGesture: ((g: GestureKind) => void) | null = null;

  setTiming(longPressMs: number): void {
    this._longPressMs = longPressMs;
  }

  setGestureHandler(handler: (g: GestureKind) => void): void {
    this._onGesture = handler;
  }

  private emit(g: GestureKind): void {
    this._onGesture?.(g);
  }

  private clearClickTimer(): void {
    if (this._clickTimer) {
      clearTimeout(this._clickTimer);
      this._clickTimer = null;
    }
  }

  handlePointerDown(sample: PointerSample, ev: PointerEvent): void {
    if (ev.ctrlKey || ev.metaKey) {
      return;
    }
    this.clearLongPressTimer();
    this._pointerDown = sample;
    this._pressTimer = setTimeout(() => {
      this.emit({ type: 'long_press', x: sample.x, y: sample.y });
      this._pressTimer = null;
      this._pointerDown = null;
    }, this._longPressMs);
  }

  handlePointerMove(sample: PointerSample): void {
    if (this._pointerDown && this._pressTimer) {
      const dx = sample.x - this._pointerDown.x;
      const dy = sample.y - this._pointerDown.y;
      if (Math.hypot(dx, dy) > this._moveThreshold) {
        this.clearLongPressTimer();
      }
    }
  }

  handlePointerUp(sample: PointerSample, ev: PointerEvent): void {
    if (ev.ctrlKey || ev.metaKey) {
      return;
    }
    this.clearLongPressTimer();
    const down = this._pointerDown;
    this._pointerDown = null;
    if (!down) {
      return;
    }
    const dist = Math.hypot(sample.x - down.x, sample.y - down.y);
    if (dist > this._moveThreshold) {
      return;
    }

    const prev = this._lastTap;
    if (
      prev &&
      sample.time - prev.time <= this._doubleClickMs &&
      Math.hypot(sample.x - prev.x, sample.y - prev.y) <= this._doubleClickDist
    ) {
      this.clearClickTimer();
      this._lastTap = null;
      this.emit({ type: 'double_click', x: sample.x, y: sample.y });
      return;
    }

    this._lastTap = { x: sample.x, y: sample.y, time: sample.time };
    this.clearClickTimer();
    this._clickTimer = setTimeout(() => {
      this._clickTimer = null;
      this.emit({ type: 'click', x: sample.x, y: sample.y });
    }, this._clickDelayMs);
  }

  private clearLongPressTimer(): void {
    if (this._pressTimer) {
      clearTimeout(this._pressTimer);
      this._pressTimer = null;
    }
  }
}

export type NotificationLevel = 'info' | 'success' | 'warning' | 'error';

export interface StudioNotification {
  readonly id: string;
  readonly level: NotificationLevel;
  readonly title: string;
  readonly message?: string;
  readonly timestamp: number;
}

export interface ActiveToast {
  readonly id: string;
  readonly notificationId: string;
  readonly startedAt: number;
}

export const TOAST_DURATION_MS = 5200;

/** Toast + notification center for Data Studio. */
export class StudioNotificationManager {
  private readonly _items: StudioNotification[] = [];
  private readonly _toasts: ActiveToast[] = [];
  private readonly _listeners = new Set<() => void>();

  get items(): readonly StudioNotification[] {
    return this._items;
  }

  get toasts(): readonly ActiveToast[] {
    return this._toasts;
  }

  subscribe(fn: () => void): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  success(title: string, message?: string): void {
    this.push('success', title, message);
  }

  error(title: string, message?: string): void {
    this.push('error', title, message);
  }

  warning(title: string, message?: string): void {
    this.push('warning', title, message);
  }

  info(title: string, message?: string): void {
    this.push('info', title, message);
  }

  dismissToast(toastId: string): void {
    const idx = this._toasts.findIndex((t) => t.id === toastId);
    if (idx >= 0) {
      this._toasts.splice(idx, 1);
      this.emit();
    }
  }

  private push(level: NotificationLevel, title: string, message?: string): void {
    const id = crypto.randomUUID();
    this._items.unshift({ id, level, title, message, timestamp: Date.now() });
    if (this._items.length > 60) {
      this._items.length = 60;
    }
    this._toasts.push({ id: crypto.randomUUID(), notificationId: id, startedAt: Date.now() });
    this.emit();
  }

  private emit(): void {
    for (const fn of this._listeners) {
      fn();
    }
  }
}

/** 全局通知级别。 */
export type NotificationLevel = 'info' | 'success' | 'warning' | 'error';

export interface DesignerNotification {
  readonly id: string;
  readonly level: NotificationLevel;
  readonly title: string;
  readonly message?: string;
  readonly timestamp: number;
  read: boolean;
}

export interface PushNotificationInput {
  readonly level: NotificationLevel;
  readonly title: string;
  readonly message?: string;
  /** 是否弹出短暂 toast；默认 `true`。 */
  readonly toast?: boolean;
}

export interface ActiveToast {
  readonly id: string;
  readonly notificationId: string;
  /** Toast 出现时刻，供进度条与暂停恢复计算。 */
  readonly startedAt: number;
}

export type NotificationListener = () => void;

export const TOAST_DURATION_MS = 5200;
/** Toast 滑出动画时长（与 CSS `designer-notify-toast-out` 一致）。 */
export const TOAST_EXIT_ANIM_MS = 340;
const MAX_ITEMS = 80;

/**
 * 全局消息中心：持久通知列表 + 可选 toast。
 */
export class NotificationManager {
  private readonly _items: DesignerNotification[] = [];
  private readonly _toasts: ActiveToast[] = [];
  private readonly _listeners = new Set<NotificationListener>();

  get items(): readonly DesignerNotification[] {
    return this._items;
  }

  get toasts(): readonly ActiveToast[] {
    return this._toasts;
  }

  get unreadCount(): number {
    return this._items.filter((n) => !n.read).length;
  }

  subscribe(fn: NotificationListener): () => void {
    this._listeners.add(fn);
    return () => {
      this._listeners.delete(fn);
    };
  }

  info(title: string, opts?: Omit<PushNotificationInput, 'level' | 'title'>): string {
    return this.push({ level: 'info', title, ...opts });
  }

  success(title: string, opts?: Omit<PushNotificationInput, 'level' | 'title'>): string {
    return this.push({ level: 'success', title, ...opts });
  }

  warning(title: string, opts?: Omit<PushNotificationInput, 'level' | 'title'>): string {
    return this.push({ level: 'warning', title, ...opts });
  }

  error(title: string, opts?: Omit<PushNotificationInput, 'level' | 'title'>): string {
    return this.push({ level: 'error', title, ...opts });
  }

  push(input: PushNotificationInput): string {
    const id = crypto.randomUUID();
    const entry: DesignerNotification = {
      id,
      level: input.level,
      title: input.title,
      message: input.message,
      timestamp: Date.now(),
      read: false,
    };
    this._items.unshift(entry);
    if (this._items.length > MAX_ITEMS) {
      this._items.length = MAX_ITEMS;
    }
    if (input.toast !== false) {
      this.enqueueToast(id);
    }
    this.emit();
    return id;
  }

  markRead(id: string): void {
    const n = this._items.find((x) => x.id === id);
    if (!n || n.read) {
      return;
    }
    n.read = true;
    this.emit();
  }

  markAllRead(): void {
    let changed = false;
    for (const n of this._items) {
      if (!n.read) {
        n.read = true;
        changed = true;
      }
    }
    if (changed) {
      this.emit();
    }
  }

  dismiss(id: string): void {
    const idx = this._items.findIndex((x) => x.id === id);
    if (idx >= 0) {
      this._items.splice(idx, 1);
      this.emit();
    }
  }

  dismissToast(toastId: string): void {
    const idx = this._toasts.findIndex((t) => t.id === toastId);
    if (idx < 0) {
      return;
    }
    this._toasts.splice(idx, 1);
    this.emit();
  }

  clear(): void {
    if (this._items.length === 0) {
      return;
    }
    this._items.length = 0;
    this.emit();
  }

  private enqueueToast(notificationId: string): void {
    this._toasts.push({
      id: crypto.randomUUID(),
      notificationId,
      startedAt: Date.now(),
    });
  }

  private emit(): void {
    for (const fn of this._listeners) {
      fn();
    }
  }
}

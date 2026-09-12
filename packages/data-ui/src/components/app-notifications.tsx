import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type AnimationEvent,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react';
import './app-shell.css';
import { AppCloseIcon } from './app-close-icon.js';

export type AppNotificationLevel = 'info' | 'success' | 'warning' | 'error';

export interface AppNotificationItem {
  readonly id: string;
  readonly level: AppNotificationLevel;
  readonly title: string;
  readonly message?: string;
  readonly timestamp: number;
  readonly read?: boolean;
}

export interface AppActiveToast {
  readonly id: string;
  readonly notificationId: string;
  readonly startedAt?: number;
}

export interface AppNotificationLabels {
  readonly dismiss?: string;
  readonly centerTitle?: string;
  readonly empty?: string;
  readonly markAllRead?: string;
  readonly clearAll?: string;
  readonly unreadCount?: (count: number) => string;
  readonly level?: Partial<Record<AppNotificationLevel, string>>;
}

const DEFAULT_TOAST_DURATION_MS = 5200;
const TOAST_EXIT_MS = 190;

function levelGlyph(level: AppNotificationLevel): string {
  switch (level) {
    case 'success':
      return 'OK';
    case 'warning':
      return '!';
    case 'error':
      return 'x';
    default:
      return 'i';
  }
}

function defaultLevelLabel(level: AppNotificationLevel): string {
  switch (level) {
    case 'success':
      return 'Success';
    case 'warning':
      return 'Warning';
    case 'error':
      return 'Error';
    default:
      return 'Info';
  }
}

function formatTime(ts: number, locale?: string): string {
  try {
    return new Intl.DateTimeFormat(locale || undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date(ts));
  } catch {
    return new Date(ts).toLocaleTimeString();
  }
}

function NotificationIcon(props: {
  readonly level: AppNotificationLevel;
  readonly renderIcon?: (level: AppNotificationLevel) => ReactNode;
}): ReactElement {
  return (
    <div className="mode-ui-notification-icon" aria-hidden>
      {props.renderIcon ? props.renderIcon(props.level) : levelGlyph(props.level)}
    </div>
  );
}

function AppToastCard(props: {
  readonly toast: AppActiveToast;
  readonly item: AppNotificationItem;
  readonly durationMs: number;
  readonly dismissLabel: string;
  readonly renderIcon?: (level: AppNotificationLevel) => ReactNode;
  readonly onDismiss: (toastId: string) => void;
}): ReactElement {
  const { toast, item, durationMs, dismissLabel, renderIcon, onDismiss } = props;
  const [exiting, setExiting] = useState(false);
  const dismissedRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const progressRef = useRef<HTMLDivElement | null>(null);

  const finishDismiss = useCallback((): void => {
    if (dismissedRef.current) {
      return;
    }
    dismissedRef.current = true;
    onDismiss(toast.id);
  }, [onDismiss, toast.id]);

  const requestExit = useCallback((): void => {
    setExiting(true);
  }, []);

  useEffect(() => {
    timerRef.current = window.setTimeout(requestExit, durationMs);
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, [durationMs, requestExit, toast.id]);

  useEffect(() => {
    if (!exiting) {
      return;
    }
    const fallback = window.setTimeout(finishDismiss, TOAST_EXIT_MS + 80);
    return () => window.clearTimeout(fallback);
  }, [exiting, finishDismiss]);

  const pause = (): void => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (progressRef.current) {
      progressRef.current.style.animationPlayState = 'paused';
    }
  };

  const resume = (): void => {
    if (exiting || timerRef.current !== null) {
      return;
    }
    timerRef.current = window.setTimeout(requestExit, 900);
    if (progressRef.current) {
      progressRef.current.style.animationPlayState = 'running';
    }
  };

  const handleAnimationEnd = (event: AnimationEvent<HTMLDivElement>): void => {
    if (exiting && event.animationName === 'mode-ui-toast-out') {
      finishDismiss();
    }
  };

  return (
    <div
      className={[
        'mode-ui-toast',
        `mode-ui-toast--${item.level}`,
        exiting ? 'mode-ui-toast--exit' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      role="status"
      onPointerEnter={pause}
      onPointerLeave={resume}
      onAnimationEnd={handleAnimationEnd}
    >
      <div className="mode-ui-toast-main">
        <NotificationIcon level={item.level} renderIcon={renderIcon} />
        <div className="mode-ui-toast-body">
          <strong className="mode-ui-toast-title">{item.title}</strong>
          {item.message ? <p className="mode-ui-toast-message">{item.message}</p> : null}
        </div>
        <button
          type="button"
          className="mode-ui-notification-close"
          aria-label={dismissLabel}
          onClick={requestExit}
        >
          <AppCloseIcon />
        </button>
      </div>
      <div className="mode-ui-toast-progress" aria-hidden>
        <div
          ref={progressRef}
          className="mode-ui-toast-progress-bar"
          data-running="true"
          style={{ '--mode-ui-toast-duration': `${durationMs}ms` } as CSSProperties}
        />
      </div>
    </div>
  );
}

export function AppNotificationToastStack(props: {
  readonly items: readonly AppNotificationItem[];
  readonly toasts: readonly AppActiveToast[];
  readonly onDismissToast: (toastId: string) => void;
  readonly durationMs?: number;
  readonly dismissLabel?: string;
  readonly renderIcon?: (level: AppNotificationLevel) => ReactNode;
  readonly childrenBefore?: ReactNode;
}): ReactElement | null {
  const {
    items,
    toasts,
    onDismissToast,
    durationMs = DEFAULT_TOAST_DURATION_MS,
    dismissLabel = 'Dismiss',
    renderIcon,
    childrenBefore,
  } = props;
  const byId = new Map(items.map((item) => [item.id, item] as const));

  if (!childrenBefore && toasts.length === 0) {
    return null;
  }

  return (
    <div className="mode-ui-toast-stack" aria-live="polite" aria-relevant="additions">
      {childrenBefore}
      {toasts.map((toast) => {
        const item = byId.get(toast.notificationId);
        return item ? (
          <AppToastCard
            key={toast.id}
            toast={toast}
            item={item}
            durationMs={durationMs}
            dismissLabel={dismissLabel}
            renderIcon={renderIcon}
            onDismiss={onDismissToast}
          />
        ) : null;
      })}
    </div>
  );
}

export function AppNotificationCenter(props: {
  readonly items: readonly AppNotificationItem[];
  readonly unreadCount?: number;
  readonly labels?: AppNotificationLabels;
  readonly locale?: string;
  readonly renderIcon?: (level: AppNotificationLevel) => ReactNode;
  readonly onOpen?: (id: string) => void;
  readonly onDismiss?: (id: string) => void;
  readonly onMarkAllRead?: () => void;
  readonly onClear?: () => void;
}): ReactElement {
  const {
    items,
    unreadCount = items.filter((item) => item.read === false).length,
    labels,
    locale,
    renderIcon,
    onOpen,
    onDismiss,
    onMarkAllRead,
    onClear,
  } = props;
  const dismissLabel = labels?.dismiss ?? 'Dismiss';
  const unreadText = labels?.unreadCount
    ? labels.unreadCount(unreadCount)
    : `${unreadCount} unread`;

  return (
    <div className="mode-ui-notification-center">
      <div className="mode-ui-notification-toolbar">
        <div className="mode-ui-notification-toolbar-main">
          <span className="mode-ui-notification-count-label">
            {labels?.centerTitle ?? 'Notifications'}
          </span>
          <span
            className="mode-ui-notification-count-pill"
            data-active={unreadCount > 0 ? 'true' : 'false'}
          >
            {unreadText}
          </span>
        </div>
        <div className="mode-ui-notification-toolbar-actions">
          {onMarkAllRead ? (
            <button
              type="button"
              className="mode-ui-notification-action"
              disabled={unreadCount === 0}
              onClick={onMarkAllRead}
            >
              {labels?.markAllRead ?? 'Mark read'}
            </button>
          ) : null}
          {onClear ? (
            <button
              type="button"
              className="mode-ui-notification-action"
              disabled={items.length === 0}
              onClick={onClear}
            >
              {labels?.clearAll ?? 'Clear'}
            </button>
          ) : null}
        </div>
      </div>

      {items.length === 0 ? (
        <div className="mode-ui-notification-empty">
          <p>{labels?.empty ?? 'No notifications yet.'}</p>
        </div>
      ) : (
        <div className="mode-ui-notification-list">
          {items.map((item, index) => {
            const levelLabel = labels?.level?.[item.level] ?? defaultLevelLabel(item.level);
            return (
              <article
                key={item.id}
                className={`mode-ui-notification-item mode-ui-notification-item--${item.level}`}
                data-unread={item.read === false ? 'true' : 'false'}
                style={{ animationDelay: `${Math.min(index, 8) * 28}ms` }}
                role="button"
                tabIndex={0}
                onClick={() => onOpen?.(item.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    onOpen?.(item.id);
                  }
                }}
              >
                <NotificationIcon level={item.level} renderIcon={renderIcon} />
                <div className="mode-ui-notification-body">
                  <div className="mode-ui-notification-meta">
                    <span className="mode-ui-notification-badge">{levelLabel}</span>
                    <time
                      className="mode-ui-notification-time"
                      dateTime={new Date(item.timestamp).toISOString()}
                    >
                      {formatTime(item.timestamp, locale)}
                    </time>
                  </div>
                  <h4 className="mode-ui-notification-title">{item.title}</h4>
                  {item.message ? (
                    <p className="mode-ui-notification-message">{item.message}</p>
                  ) : null}
                </div>
                {onDismiss ? (
                  <button
                    type="button"
                    className="mode-ui-notification-close"
                    aria-label={dismissLabel}
                    onClick={(event) => {
                      event.stopPropagation();
                      onDismiss(item.id);
                    }}
                  >
                    <AppCloseIcon />
                  </button>
                ) : item.read === false ? (
                  <span className="mode-ui-notification-unread-dot" aria-hidden />
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

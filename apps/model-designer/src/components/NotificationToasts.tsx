import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type AnimationEvent,
  type ReactElement,
} from 'react';

import { useDesigner } from '../context/designer-context.js';

import {
  TOAST_DURATION_MS,
  TOAST_EXIT_ANIM_MS,
  type ActiveToast,
  type DesignerNotification,
} from '../managers/notification-manager.js';

import { useToastHoverDismiss } from '../hooks/use-toast-hover-dismiss.js';

import { AsyncOperationToast } from './AsyncOperationToast.js';

import { NotificationLevelIcon } from './notification-level-icon.js';

function ToastCard(props: {
  toast: ActiveToast;

  notification: DesignerNotification;

  onDismiss: (toastId: string) => void;
}): ReactElement {
  const { toast, notification, onDismiss } = props;

  const { i18n } = useDesigner();

  const [exiting, setExiting] = useState(false);

  const exitDoneRef = useRef(false);

  const requestExit = useCallback((): void => {
    setExiting(true);
  }, []);

  const { progressRef, handlePointerEnter, handlePointerLeave, handleDismissClick } =
    useToastHoverDismiss({
      active: !exiting,

      durationMs: TOAST_DURATION_MS,

      startedAt: toast.startedAt,

      onRequestExit: requestExit,
    });

  const finishExit = useCallback((): void => {
    if (exitDoneRef.current) {
      return;
    }

    exitDoneRef.current = true;

    onDismiss(toast.id);
  }, [onDismiss, toast.id]);

  const handleExitAnimationEnd = useCallback(
    (event: AnimationEvent<HTMLDivElement>): void => {
      if (!exiting || event.animationName !== 'designer-notify-toast-out') {
        return;
      }

      finishExit();
    },

    [exiting, finishExit],
  );

  useEffect(() => {
    if (!exiting) {
      return;
    }

    const fallback = window.setTimeout(() => finishExit(), TOAST_EXIT_ANIM_MS + 64);

    return () => window.clearTimeout(fallback);
  }, [exiting, finishExit]);

  return (
    <div
      className={`designer-notify-toast designer-notify-toast--${notification.level}${exiting ? ' designer-notify-toast--exit' : ''}`}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      onAnimationEnd={handleExitAnimationEnd}
      role="status"
    >
      <div className="designer-notify-toast-row">
        <div
          className={`designer-notify-toast-icon designer-notify-toast-icon--${notification.level}`}
        >
          <NotificationLevelIcon level={notification.level} />
        </div>

        <div className="designer-notify-toast-body">
          <strong>{notification.title}</strong>

          {notification.message ? <span>{notification.message}</span> : null}
        </div>

        <button
          type="button"
          className="designer-notify-toast-close"
          aria-label={i18n.t('ui', 'notifyDismiss')}
          onClick={handleDismissClick}
        >
          ×
        </button>
      </div>

      <div className="designer-notify-toast-progress" aria-hidden>
        <div
          ref={progressRef}
          className={`designer-notify-toast-progress-bar designer-notify-toast-progress-bar--${notification.level}`}
        />
      </div>
    </div>
  );
}

/** 画布右上角短暂 toast（带倒计时进度条）。 */

export function NotificationToasts(): ReactElement {
  const { notifications, asyncOps } = useDesigner();

  const [, bump] = useState(0);

  useEffect(() => notifications.subscribe(() => bump((n) => n + 1)), [notifications]);

  useEffect(() => asyncOps.subscribe(() => bump((n) => n + 1)), [asyncOps]);

  const toasts = notifications.toasts;

  const asyncVisible = asyncOps.snapshot.key !== null && asyncOps.snapshot.phase !== null;

  if (!asyncVisible && toasts.length === 0) {
    return <></>;
  }

  return (
    <div className="designer-notify-toast-stack" aria-live="polite" aria-relevant="additions">
      <AsyncOperationToast />

      {toasts.map((toast) => {
        const n = notifications.items.find((x) => x.id === toast.notificationId);

        if (!n) {
          return null;
        }

        return (
          <ToastCard
            key={toast.id}
            toast={toast}
            notification={n}
            onDismiss={(id) => notifications.dismissToast(id)}
          />
        );
      })}
    </div>
  );
}

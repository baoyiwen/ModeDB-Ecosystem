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
  type NotificationLevel,
} from '../managers/notification-manager.js';
import type { AsyncOperationPhase } from '../managers/async-operation-manager.js';
import { resolveAsyncOpLabels } from '../utils/async-op-i18n.js';
import { useToastHoverDismiss } from '../hooks/use-toast-hover-dismiss.js';
import { NotificationLevelIcon } from './notification-level-icon.js';

function phaseLevel(phase: AsyncOperationPhase): NotificationLevel {
  if (phase === 'success') {
    return 'success';
  }
  if (phase === 'error') {
    return 'error';
  }
  return 'info';
}

export function AsyncOperationToast(): ReactElement | null {
  const { asyncOps, i18n, notifications } = useDesigner();
  const [, bump] = useState(0);
  const [exiting, setExiting] = useState(false);
  const [settledAt, setSettledAt] = useState<number | null>(null);
  const loggedRef = useRef<string | null>(null);
  const prevPhaseRef = useRef<AsyncOperationPhase | null>(null);

  useEffect(() => asyncOps.subscribe(() => bump((n) => n + 1)), [asyncOps]);

  useEffect(() => {
    document.body.classList.toggle('designer-async-busy', asyncOps.isBusy);
    return () => {
      document.body.classList.remove('designer-async-busy');
    };
  }, [asyncOps.isBusy]);

  const snap = asyncOps.snapshot;
  const visible = snap.key !== null && snap.phase !== null;
  const countdownActive = visible && snap.phase !== 'running' && settledAt !== null && !exiting;

  const finishExit = useCallback((): void => {
    asyncOps.dismiss();
    setExiting(false);
  }, [asyncOps]);

  const requestExit = useCallback((): void => {
    setExiting(true);
  }, []);

  const { progressRef, handlePointerEnter, handlePointerLeave, handleDismissClick } =
    useToastHoverDismiss({
      active: countdownActive,
      durationMs: TOAST_DURATION_MS,
      startedAt: settledAt ?? Date.now(),
      onRequestExit: requestExit,
    });

  useEffect(() => {
    if (!visible) {
      setExiting(false);
      setSettledAt(null);
      prevPhaseRef.current = null;
      loggedRef.current = null;
      return;
    }
    if (snap.phase !== 'running' && prevPhaseRef.current === 'running') {
      setSettledAt(Date.now());
    }
    prevPhaseRef.current = snap.phase;
  }, [visible, snap.key, snap.phase, snap.startedAt]);

  useEffect(() => {
    if (!visible || snap.phase !== 'success' || !snap.key) {
      return;
    }
    const logId = `${snap.key}-${snap.startedAt}-success`;
    if (loggedRef.current === logId) {
      return;
    }
    loggedRef.current = logId;
    const { title, message } = resolveAsyncOpLabels(
      i18n,
      snap.key,
      'success',
      snap.detail,
      snap.errorMessage,
    );
    notifications.success(title, { toast: false, message });
  }, [
    visible,
    snap.key,
    snap.phase,
    snap.startedAt,
    snap.detail,
    snap.errorMessage,
    i18n,
    notifications,
  ]);

  useEffect(() => {
    if (!visible || snap.phase !== 'error' || !snap.key) {
      return;
    }
    const logId = `${snap.key}-${snap.startedAt}-error`;
    if (loggedRef.current === logId) {
      return;
    }
    loggedRef.current = logId;
    const { title, message } = resolveAsyncOpLabels(
      i18n,
      snap.key,
      'error',
      snap.detail,
      snap.errorMessage,
    );
    notifications.error(title, { toast: false, message });
  }, [
    visible,
    snap.key,
    snap.phase,
    snap.startedAt,
    snap.detail,
    snap.errorMessage,
    i18n,
    notifications,
  ]);

  useEffect(() => {
    if (!exiting) {
      return;
    }
    const fallback = window.setTimeout(() => finishExit(), TOAST_EXIT_ANIM_MS + 64);
    return () => window.clearTimeout(fallback);
  }, [exiting, finishExit]);

  const handleExitAnimationEnd = useCallback(
    (event: AnimationEvent<HTMLDivElement>): void => {
      if (!exiting || event.animationName !== 'mode-ui-toast-out') {
        return;
      }
      finishExit();
    },
    [exiting, finishExit],
  );

  if (!visible || !snap.key || !snap.phase) {
    return null;
  }

  const level = phaseLevel(snap.phase);
  const { title, message } = resolveAsyncOpLabels(
    i18n,
    snap.key,
    snap.phase,
    snap.detail,
    snap.errorMessage,
  );

  return (
    <div
      className={`mode-ui-toast mode-ui-toast--${level}${exiting ? ' mode-ui-toast--exit' : ''}`}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      onAnimationEnd={handleExitAnimationEnd}
      role="status"
      aria-live="polite"
      aria-busy={snap.phase === 'running'}
    >
      <div className="mode-ui-toast-main">
        <div className="mode-ui-notification-icon">
          {snap.phase === 'running' ? (
            <span className="designer-async-toast-spinner" aria-hidden />
          ) : (
            <NotificationLevelIcon level={level} />
          )}
        </div>

        <div className="mode-ui-toast-body">
          <strong className="mode-ui-toast-title">{title}</strong>
          {message ? <p className="mode-ui-toast-message">{message}</p> : null}
        </div>

        {snap.phase !== 'running' ? (
          <button
            type="button"
            className="mode-ui-notification-close"
            aria-label={i18n.t('ui', 'notifyDismiss')}
            onClick={handleDismissClick}
          >
            <span aria-hidden="true">x</span>
          </button>
        ) : null}
      </div>

      {snap.phase !== 'running' && settledAt !== null ? (
        <div className="mode-ui-toast-progress" aria-hidden>
          <div ref={progressRef} className="mode-ui-toast-progress-bar" />
        </div>
      ) : null}
    </div>
  );
}

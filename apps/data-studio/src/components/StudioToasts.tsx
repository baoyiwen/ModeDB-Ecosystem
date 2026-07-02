import { useEffect, useState, type ReactElement } from 'react';
import { TOAST_DURATION_MS, type ActiveToast } from '../managers/notification-manager.js';
import { useStudio } from '../context/studio-context.js';

/** Top-right toast stack for Data Studio. */
export function StudioToasts(): ReactElement | null {
  const { notify } = useStudio();
  const [, bump] = useState(0);

  useEffect(() => notify.subscribe(() => bump((n) => n + 1)), [notify]);

  const toasts = notify.toasts;
  if (toasts.length === 0) {
    return null;
  }

  return (
    <div className="studio-toast-stack" aria-live="polite">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={() => notify.dismissToast(toast.id)} />
      ))}
    </div>
  );
}

function ToastItem(props: {
  readonly toast: ActiveToast;
  readonly onDismiss: () => void;
}): ReactElement {
  const { toast, onDismiss } = props;
  const { notify } = useStudio();
  const n = notify.items.find((x) => x.id === toast.notificationId);

  useEffect(() => {
    const timer = window.setTimeout(onDismiss, TOAST_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [onDismiss, toast.id]);

  if (!n) {
    return <div />;
  }

  return (
    <div className={`studio-toast studio-toast--${n.level}`} role="status">
      <div className="studio-toast-body">
        <strong>{n.title}</strong>
        {n.message ? <span>{n.message}</span> : null}
      </div>
      <button type="button" className="studio-toast-close" aria-label="Dismiss" onClick={onDismiss}>
        ×
      </button>
    </div>
  );
}

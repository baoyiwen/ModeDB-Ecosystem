import { useEffect, useState, type ReactElement } from 'react';
import { AppNotificationToastStack } from '@mode-db/data-ui';
import { TOAST_DURATION_MS } from '../managers/notification-manager.js';
import { useStudio } from '../context/studio-context.js';

/** Top-right toast stack for Data Studio, rendered with the shared app notification component. */
export function StudioToasts(): ReactElement | null {
  const { notify } = useStudio();
  const [, bump] = useState(0);

  useEffect(() => notify.subscribe(() => bump((n) => n + 1)), [notify]);

  return (
    <AppNotificationToastStack
      items={notify.items}
      toasts={notify.toasts}
      durationMs={TOAST_DURATION_MS}
      dismissLabel="Dismiss"
      onDismissToast={(id) => notify.dismissToast(id)}
    />
  );
}

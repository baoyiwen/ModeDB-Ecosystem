import { useEffect, useState, type ReactElement } from 'react';
import { AppNotificationToastStack } from '@mode-db/data-ui';
import { useDesigner } from '../context/designer-context.js';
import { TOAST_DURATION_MS } from '../managers/notification-manager.js';
import { AsyncOperationToast } from './AsyncOperationToast.js';
import { NotificationLevelIcon } from './notification-level-icon.js';

/** Canvas top-right toast stack, rendered with the shared app notification component. */
export function NotificationToasts(): ReactElement | null {
  const { i18n, notifications, asyncOps } = useDesigner();
  const [, bump] = useState(0);

  useEffect(() => notifications.subscribe(() => bump((n) => n + 1)), [notifications]);
  useEffect(() => asyncOps.subscribe(() => bump((n) => n + 1)), [asyncOps]);

  const asyncVisible = asyncOps.snapshot.key !== null && asyncOps.snapshot.phase !== null;

  return (
    <AppNotificationToastStack
      items={notifications.items}
      toasts={notifications.toasts}
      durationMs={TOAST_DURATION_MS}
      dismissLabel={i18n.t('ui', 'notifyDismiss')}
      renderIcon={(level) => <NotificationLevelIcon level={level} />}
      onDismissToast={(id) => notifications.dismissToast(id)}
      childrenBefore={asyncVisible ? <AsyncOperationToast /> : null}
    />
  );
}

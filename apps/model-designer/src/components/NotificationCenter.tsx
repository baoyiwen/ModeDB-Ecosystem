import { useEffect, useState, type ReactElement } from 'react';
import { AppNotificationCenter } from '@mode-db/data-ui';
import { useDesigner } from '../context/designer-context.js';
import type { NotificationLevel } from '../managers/notification-manager.js';
import { NotificationLevelIcon } from './notification-level-icon.js';

function levelLabel(
  i18n: ReturnType<typeof useDesigner>['i18n'],
  level: NotificationLevel,
): string {
  switch (level) {
    case 'success':
      return i18n.t('ui', 'notifyLevelSuccess');
    case 'warning':
      return i18n.t('ui', 'notifyLevelWarning');
    case 'error':
      return i18n.t('ui', 'notifyLevelError');
    default:
      return i18n.t('ui', 'notifyLevelInfo');
  }
}

/** Sidebar notification list, rendered with the shared app notification component. */
export function NotificationCenter(): ReactElement {
  const { i18n, notifications } = useDesigner();
  const [, bump] = useState(0);

  useEffect(() => notifications.subscribe(() => bump((n) => n + 1)), [notifications]);

  return (
    <AppNotificationCenter
      items={notifications.items}
      unreadCount={notifications.unreadCount}
      locale={i18n.locale}
      renderIcon={(level) => <NotificationLevelIcon level={level} />}
      labels={{
        dismiss: i18n.t('ui', 'notifyDismiss'),
        centerTitle: i18n.t('ui', 'notifyCenterTitle'),
        empty: i18n.t('ui', 'notifyEmpty'),
        markAllRead: i18n.t('ui', 'notifyMarkAllRead'),
        clearAll: i18n.t('ui', 'notifyClearAll'),
        unreadCount: (count) => i18n.t('ui', 'notifyUnreadCount', { count: String(count) }),
        level: {
          info: levelLabel(i18n, 'info'),
          success: levelLabel(i18n, 'success'),
          warning: levelLabel(i18n, 'warning'),
          error: levelLabel(i18n, 'error'),
        },
      }}
      onOpen={(id) => notifications.markRead(id)}
      onDismiss={(id) => notifications.dismiss(id)}
      onMarkAllRead={() => notifications.markAllRead()}
      onClear={() => notifications.clear()}
    />
  );
}

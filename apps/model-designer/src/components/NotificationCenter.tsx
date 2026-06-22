import { useEffect, useState, type ReactElement } from 'react';
import { useDesigner } from '../context/designer-context.js';
import type { DesignerNotification, NotificationLevel } from '../managers/notification-manager.js';
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

function formatTime(ts: number, locale: string): string {
  try {
    return new Intl.DateTimeFormat(
      locale === 'zh' ? 'zh-CN' : locale === 'ja' ? 'ja-JP' : 'en-US',
      {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      },
    ).format(new Date(ts));
  } catch {
    return new Date(ts).toLocaleTimeString();
  }
}

function NotificationRow(props: {
  item: DesignerNotification;
  index: number;
  onOpen: (id: string) => void;
}): ReactElement {
  const { i18n, notifications } = useDesigner();
  const { item, index } = props;

  return (
    <article
      className={`designer-notify-item designer-notify-item--${item.level}${item.read ? '' : ' designer-notify-item--unread'}`}
      style={{ animationDelay: `${Math.min(index, 8) * 40}ms` }}
      onClick={() => props.onOpen(item.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          props.onOpen(item.id);
        }
      }}
      role="button"
      tabIndex={0}
    >
      <div className={`designer-notify-item-icon designer-notify-item-icon--${item.level}`}>
        <NotificationLevelIcon level={item.level} />
      </div>
      <div className="designer-notify-item-body">
        <div className="designer-notify-item-head">
          <span className={`designer-notify-badge designer-notify-badge--${item.level}`}>
            {levelLabel(i18n, item.level)}
          </span>
          <time className="designer-notify-time" dateTime={new Date(item.timestamp).toISOString()}>
            {formatTime(item.timestamp, i18n.locale)}
          </time>
          <button
            type="button"
            className="designer-notify-dismiss"
            aria-label={i18n.t('ui', 'notifyDismiss')}
            onClick={(e) => {
              e.stopPropagation();
              notifications.dismiss(item.id);
            }}
          >
            ×
          </button>
        </div>
        <h4 className="designer-notify-title">{item.title}</h4>
        {item.message ? <p className="designer-notify-message">{item.message}</p> : null}
      </div>
      {!item.read ? <span className="designer-notify-unread-dot" aria-hidden /> : null}
    </article>
  );
}

/** 侧栏「消息中心」列表。 */
export function NotificationCenter(): ReactElement {
  const { i18n, notifications } = useDesigner();
  const [, bump] = useState(0);
  useEffect(() => notifications.subscribe(() => bump((n) => n + 1)), [notifications]);

  const items = notifications.items;

  return (
    <div className="designer-notify-center">
      <div className="designer-notify-toolbar designer-glass-inset">
        <div className="designer-notify-toolbar-main">
          <span className="designer-notify-count-label">{i18n.t('ui', 'notifyCenterTitle')}</span>
          <span
            className={`designer-notify-count-pill${notifications.unreadCount > 0 ? ' designer-notify-count-pill--active' : ''}`}
          >
            {i18n.t('ui', 'notifyUnreadCount', { count: String(notifications.unreadCount) })}
          </span>
        </div>
        <div className="designer-notify-toolbar-actions">
          <button
            type="button"
            className="designer-notify-action"
            disabled={notifications.unreadCount === 0}
            onClick={() => notifications.markAllRead()}
          >
            {i18n.t('ui', 'notifyMarkAllRead')}
          </button>
          <button
            type="button"
            className="designer-notify-action designer-notify-action--muted"
            disabled={items.length === 0}
            onClick={() => notifications.clear()}
          >
            {i18n.t('ui', 'notifyClearAll')}
          </button>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="designer-notify-empty">
          <div className="designer-notify-empty-icon" aria-hidden>
            <NotificationLevelIcon level="info" />
          </div>
          <p>{i18n.t('ui', 'notifyEmpty')}</p>
        </div>
      ) : (
        <div className="designer-notify-list designer-scrollbar-hide">
          {items.map((item, index) => (
            <NotificationRow
              key={item.id}
              item={item}
              index={index}
              onOpen={(id) => notifications.markRead(id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

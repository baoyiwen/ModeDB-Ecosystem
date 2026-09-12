import type { CSSProperties, ReactElement, ReactNode } from 'react';
import './app-shell.css';
import { AppCloseIcon } from './app-close-icon.js';

export interface AppDrawerProps {
  readonly open: boolean;
  readonly title: ReactNode;
  readonly eyebrow?: ReactNode;
  readonly side?: 'left' | 'right';
  readonly width?: number | string;
  readonly closeLabel?: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly className?: string;
  readonly bodyClassName?: string;
  readonly labelledById?: string;
  readonly withScrim?: boolean;
  readonly unmountOnClose?: boolean;
}

export function AppDrawer(props: AppDrawerProps): ReactElement {
  const {
    open,
    title,
    eyebrow,
    side = 'right',
    width,
    closeLabel = 'Close',
    onClose,
    children,
    footer,
    className,
    bodyClassName,
    labelledById = 'mode-ui-drawer-title',
    withScrim = true,
    unmountOnClose = false,
  } = props;
  const style =
    width === undefined
      ? undefined
      : ({
          '--mode-ui-drawer-width': typeof width === 'number' ? `${width}px` : width,
        } as CSSProperties);

  return (
    <div className="mode-ui-drawer-shell" data-open={open ? 'true' : 'false'} aria-hidden={!open}>
      {withScrim ? (
        <button
          type="button"
          className="mode-ui-drawer-scrim"
          tabIndex={-1}
          aria-label={closeLabel}
          onClick={onClose}
        />
      ) : null}
      {!open && unmountOnClose ? null : (
        <aside
          className={['mode-ui-drawer', `mode-ui-drawer--${side}`, className]
            .filter(Boolean)
            .join(' ')}
          style={style}
          role="dialog"
          aria-modal="false"
          aria-labelledby={labelledById}
        >
          <header className="mode-ui-drawer-header">
            <div className="mode-ui-drawer-title">
              {eyebrow ? <span className="mode-ui-drawer-eyebrow">{eyebrow}</span> : null}
              <h2 id={labelledById}>{title}</h2>
            </div>
            <button
              type="button"
              className="mode-ui-drawer-close"
              aria-label={closeLabel}
              onClick={onClose}
            >
              <AppCloseIcon />
            </button>
          </header>
          <div className={['mode-ui-drawer-body', bodyClassName].filter(Boolean).join(' ')}>
            {children}
          </div>
          {footer ? <footer className="mode-ui-drawer-footer">{footer}</footer> : null}
        </aside>
      )}
    </div>
  );
}

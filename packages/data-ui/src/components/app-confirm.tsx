import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import './app-shell.css';

export type AppConfirmTone = 'default' | 'danger';

export interface AppConfirmOptions {
  readonly title: ReactNode;
  readonly message?: ReactNode;
  readonly eyebrow?: ReactNode;
  readonly confirmLabel?: ReactNode;
  readonly cancelLabel?: ReactNode;
  readonly tone?: AppConfirmTone;
}

interface ActiveConfirm extends AppConfirmOptions {
  readonly id: number;
  readonly resolve: (value: boolean) => void;
}

const ConfirmContext = createContext<((options: AppConfirmOptions) => Promise<boolean>) | null>(
  null,
);

export function AppConfirmProvider(props: {
  readonly children: ReactNode;
  readonly defaultConfirmLabel?: ReactNode;
  readonly defaultCancelLabel?: ReactNode;
  readonly defaultEyebrow?: ReactNode;
}): ReactElement {
  const {
    children,
    defaultCancelLabel = '取消',
    defaultConfirmLabel = '确认',
    defaultEyebrow,
  } = props;
  const nextIdRef = useRef(1);
  const [active, setActive] = useState<ActiveConfirm | null>(null);

  const confirm = useCallback((options: AppConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      setActive({
        ...options,
        id: nextIdRef.current,
        resolve,
      });
      nextIdRef.current += 1;
    });
  }, []);

  const settle = useCallback(
    (value: boolean): void => {
      if (!active) {
        return;
      }
      active.resolve(value);
      setActive(null);
    },
    [active],
  );

  const value = useMemo(() => confirm, [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      <div
        className="mode-ui-confirm-shell"
        data-open={active ? 'true' : 'false'}
        aria-hidden={active ? 'false' : 'true'}
      >
        <button
          type="button"
          className="mode-ui-confirm-scrim"
          tabIndex={-1}
          aria-label={String(active?.cancelLabel ?? defaultCancelLabel)}
          onClick={() => settle(false)}
        />
        {active ? (
          <section
            key={active.id}
            className="mode-ui-confirm-card"
            data-tone={active.tone ?? 'default'}
            role="dialog"
            aria-modal="true"
            aria-labelledby="mode-ui-confirm-title"
          >
            <div className="mode-ui-confirm-head">
              <span className="mode-ui-confirm-eyebrow">
                {active.eyebrow ?? defaultEyebrow ?? 'ModeDB'}
              </span>
              <h2 id="mode-ui-confirm-title">{active.title}</h2>
            </div>
            {active.message ? (
              <div className="mode-ui-confirm-message">{active.message}</div>
            ) : null}
            <div className="mode-ui-confirm-actions">
              <button
                type="button"
                className="mode-ui-confirm-btn mode-ui-confirm-btn--secondary"
                onClick={() => settle(false)}
              >
                {active.cancelLabel ?? defaultCancelLabel}
              </button>
              <button
                type="button"
                className="mode-ui-confirm-btn mode-ui-confirm-btn--primary"
                onClick={() => settle(true)}
              >
                {active.confirmLabel ?? defaultConfirmLabel}
              </button>
            </div>
          </section>
        ) : null}
      </div>
    </ConfirmContext.Provider>
  );
}

export function useAppConfirm(): (options: AppConfirmOptions) => Promise<boolean> {
  const confirm = useContext(ConfirmContext);
  if (!confirm) {
    throw new Error('useAppConfirm must be used within AppConfirmProvider.');
  }
  return confirm;
}

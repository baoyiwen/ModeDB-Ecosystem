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

export interface AppSelectItem {
  readonly value: string;
  readonly label: ReactNode;
  readonly description?: ReactNode;
  readonly meta?: ReactNode;
  readonly disabled?: boolean;
}

export interface AppSelectOptions {
  readonly title: ReactNode;
  readonly items: readonly AppSelectItem[];
  readonly message?: ReactNode;
  readonly eyebrow?: ReactNode;
  readonly initialValue?: string;
  readonly confirmLabel?: ReactNode;
  readonly cancelLabel?: ReactNode;
  readonly emptyLabel?: ReactNode;
}

/** Themed selection list, shared by dialogs and full-page management views. */
export function AppSelectList(props: {
  readonly items: readonly AppSelectItem[];
  readonly value: string | null;
  readonly onChange: (value: string) => void;
  readonly onActivate?: (value: string) => void;
  readonly label?: string;
  readonly emptyLabel: ReactNode;
}): ReactElement {
  return (
    <div className="mode-ui-select-list" role="listbox" aria-label={props.label}>
      {props.items.length === 0 ? (
        <div className="mode-ui-select-empty">{props.emptyLabel}</div>
      ) : (
        props.items.map((item) => {
          const selected = item.value === props.value;
          return (
            <button
              key={item.value}
              type="button"
              className="mode-ui-select-option"
              data-selected={selected ? 'true' : 'false'}
              role="option"
              aria-selected={selected}
              disabled={item.disabled}
              onClick={() => props.onChange(item.value)}
              onDoubleClick={() => props.onActivate?.(item.value)}
            >
              <span className="mode-ui-select-option-copy">
                <strong>{item.label}</strong>
                {item.description ? <small>{item.description}</small> : null}
              </span>
              {item.meta ? <span className="mode-ui-select-option-meta">{item.meta}</span> : null}
            </button>
          );
        })
      )}
    </div>
  );
}

interface ActiveConfirm extends AppConfirmOptions {
  readonly id: number;
  readonly resolve: (value: boolean) => void;
}

interface ActiveSelect extends AppSelectOptions {
  readonly id: number;
  readonly resolve: (value: string | null) => void;
  readonly selectedValue: string | null;
}

const ConfirmContext = createContext<((options: AppConfirmOptions) => Promise<boolean>) | null>(
  null,
);
const SelectContext = createContext<((options: AppSelectOptions) => Promise<string | null>) | null>(
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
  const [activeSelect, setActiveSelect] = useState<ActiveSelect | null>(null);

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

  const select = useCallback((options: AppSelectOptions): Promise<string | null> => {
    return new Promise<string | null>((resolve) => {
      const firstEnabled = options.items.find((item) => !item.disabled)?.value ?? null;
      const requested = options.initialValue;
      const selectedValue =
        requested && options.items.some((item) => item.value === requested && !item.disabled)
          ? requested
          : firstEnabled;
      setActiveSelect({
        ...options,
        id: nextIdRef.current,
        resolve,
        selectedValue,
      });
      nextIdRef.current += 1;
    });
  }, []);

  const settleSelect = useCallback(
    (value: string | null): void => {
      if (!activeSelect) {
        return;
      }
      activeSelect.resolve(value);
      setActiveSelect(null);
    },
    [activeSelect],
  );

  const selectValue = useMemo(() => select, [select]);

  return (
    <ConfirmContext.Provider value={value}>
      <SelectContext.Provider value={selectValue}>
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
        <div
          className="mode-ui-select-shell"
          data-open={activeSelect ? 'true' : 'false'}
          aria-hidden={activeSelect ? 'false' : 'true'}
        >
          <button
            type="button"
            className="mode-ui-confirm-scrim"
            tabIndex={-1}
            aria-label={String(activeSelect?.cancelLabel ?? defaultCancelLabel)}
            onClick={() => settleSelect(null)}
          />
          {activeSelect ? (
            <section
              key={activeSelect.id}
              className="mode-ui-select-card"
              role="dialog"
              aria-modal="true"
              aria-labelledby="mode-ui-select-title"
            >
              <div className="mode-ui-confirm-head">
                <span className="mode-ui-confirm-eyebrow">
                  {activeSelect.eyebrow ?? defaultEyebrow ?? 'ModeDB'}
                </span>
                <h2 id="mode-ui-select-title">{activeSelect.title}</h2>
              </div>
              {activeSelect.message ? (
                <div className="mode-ui-confirm-message">{activeSelect.message}</div>
              ) : null}
              <AppSelectList
                items={activeSelect.items}
                value={activeSelect.selectedValue}
                emptyLabel={activeSelect.emptyLabel ?? 'No options'}
                onChange={(value) =>
                  setActiveSelect((current) =>
                    current ? { ...current, selectedValue: value } : current,
                  )
                }
                onActivate={(value) => settleSelect(value)}
              />
              <div className="mode-ui-confirm-actions">
                <button
                  type="button"
                  className="mode-ui-confirm-btn mode-ui-confirm-btn--secondary"
                  onClick={() => settleSelect(null)}
                >
                  {activeSelect.cancelLabel ?? defaultCancelLabel}
                </button>
                <button
                  type="button"
                  className="mode-ui-confirm-btn mode-ui-confirm-btn--primary"
                  disabled={!activeSelect.selectedValue}
                  onClick={() => settleSelect(activeSelect.selectedValue)}
                >
                  {activeSelect.confirmLabel ?? defaultConfirmLabel}
                </button>
              </div>
            </section>
          ) : null}
        </div>
      </SelectContext.Provider>
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

export function useAppSelect(): (options: AppSelectOptions) => Promise<string | null> {
  const select = useContext(SelectContext);
  if (!select) {
    throw new Error('useAppSelect must be used within AppConfirmProvider.');
  }
  return select;
}

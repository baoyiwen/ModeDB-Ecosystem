import { useEffect, useId, useMemo, useRef, useState, type ReactElement } from 'react';

export interface DesignerSelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export function DesignerSelect(props: {
  value: string;
  options: readonly DesignerSelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  compact?: boolean;
}): ReactElement {
  const { value, options, onChange, disabled = false, placeholder, compact = false } = props;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const selected = useMemo(() => options.find((opt) => opt.value === value), [options, value]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (!rootRef.current?.contains(target)) {
        setOpen(false);
      }
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      className={[
        'designer-selectbox',
        open ? 'designer-selectbox--open' : '',
        disabled ? 'designer-selectbox--disabled' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <button
        type="button"
        className={[
          'designer-selectbox__trigger',
          compact ? 'designer-selectbox__trigger--compact' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className="designer-selectbox__label">{selected?.label ?? placeholder ?? value}</span>
        <span className="designer-selectbox__chevron" aria-hidden />
      </button>

      {open ? (
        <div id={listId} className="designer-selectbox__menu" role="listbox">
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="option"
              className="designer-selectbox__option"
              aria-selected={opt.value === value}
              disabled={opt.disabled}
              onClick={() => {
                onChange(opt.value);
                setOpen(false);
              }}
            >
              <span className="designer-selectbox__option-label">{opt.label}</span>
              {opt.value === value ? (
                <span className="designer-selectbox__option-mark" aria-hidden />
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';
import { createPortal } from 'react-dom';

export interface DesignerSelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

type MenuPosition = {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
};

function clamp(value: number, min: number, max: number): number {
  if (max < min) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

export function DesignerSelect(props: {
  value: string;
  options: readonly DesignerSelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  compact?: boolean;
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyLabel?: string;
}): ReactElement {
  const {
    value,
    options,
    onChange,
    disabled = false,
    placeholder,
    compact = false,
    searchable = false,
    searchPlaceholder = 'Search...',
    emptyLabel = 'No options',
  } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const selected = useMemo(() => options.find((opt) => opt.value === value), [options, value]);
  const filteredOptions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return options;
    }
    return options.filter(
      (opt) => opt.label.toLowerCase().includes(q) || opt.value.toLowerCase().includes(q),
    );
  }, [options, query]);

  const updateMenuPosition = useCallback((): void => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const rect = root.getBoundingClientRect();
    const gap = 6;
    const margin = 8;
    const preferredHeight = 260;
    const minHeight = 120;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const width = Math.min(Math.max(rect.width, 164), viewportWidth - margin * 2);
    const below = viewportHeight - rect.bottom - gap - margin;
    const above = rect.top - gap - margin;
    const right = viewportWidth - rect.right - gap - margin;
    const left = rect.left - gap - margin;
    const verticalLeft = clamp(rect.left, margin, viewportWidth - width - margin);

    if (below >= minHeight || below >= above) {
      setMenuPosition({
        top: rect.bottom + gap,
        left: verticalLeft,
        width,
        maxHeight: Math.max(minHeight, Math.min(preferredHeight, below)),
      });
      return;
    }

    if (above >= minHeight) {
      const maxHeight = Math.max(minHeight, Math.min(preferredHeight, above));
      setMenuPosition({
        top: rect.top - gap - maxHeight,
        left: verticalLeft,
        width,
        maxHeight,
      });
      return;
    }

    const sideHeight = Math.max(minHeight, Math.min(preferredHeight, viewportHeight - margin * 2));
    const sideTop = clamp(rect.top, margin, viewportHeight - sideHeight - margin);
    if (right >= width || right >= left) {
      setMenuPosition({
        top: sideTop,
        left: clamp(rect.right + gap, margin, viewportWidth - width - margin),
        width,
        maxHeight: sideHeight,
      });
      return;
    }

    setMenuPosition({
      top: sideTop,
      left: clamp(rect.left - gap - width, margin, viewportWidth - width - margin),
      width,
      maxHeight: sideHeight,
    });
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    updateMenuPosition();

    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false);
      }
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    const onViewportChange = (): void => updateMenuPosition();

    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
    };
  }, [open, updateMenuPosition]);

  useEffect(() => {
    if (!open) {
      setQuery('');
      return;
    }
    if (searchable) {
      window.setTimeout(() => searchRef.current?.focus(), 0);
    }
  }, [open, searchable]);

  const menuStyle: CSSProperties | undefined = menuPosition
    ? {
        top: menuPosition.top,
        left: menuPosition.left,
        width: menuPosition.width,
        maxHeight: menuPosition.maxHeight,
      }
    : undefined;

  const menu = open
    ? createPortal(
        <div
          ref={menuRef}
          id={listId}
          className="designer-selectbox__menu"
          role="listbox"
          style={menuStyle}
        >
          {searchable ? (
            <div className="designer-selectbox__search-wrap">
              <input
                ref={searchRef}
                className="designer-selectbox__search"
                value={query}
                placeholder={searchPlaceholder}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    setOpen(false);
                  }
                }}
              />
            </div>
          ) : null}
          <div className="designer-selectbox__options">
            {filteredOptions.length > 0 ? (
              filteredOptions.map((opt) => (
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
              ))
            ) : (
              <div className="designer-selectbox__empty">{emptyLabel}</div>
            )}
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <>
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
          <span className="designer-selectbox__label">
            {selected?.label ?? placeholder ?? value}
          </span>
          <span className="designer-selectbox__chevron" aria-hidden />
        </button>
      </div>
      {menu}
    </>
  );
}

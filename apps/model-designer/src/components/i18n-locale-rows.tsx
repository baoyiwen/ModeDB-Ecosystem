import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';
import { DesignerSelect } from './base/designer-select.js';

const EXTRA_LOCALE_OPTIONS = ['ja', 'ko', 'fr', 'de'] as const;

function splitI18n(value: Record<string, string>): {
  zh: string;
  en: string;
  extra: Record<string, string>;
} {
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (k !== 'zh' && k !== 'en') {
      extra[k] = v;
    }
  }
  return { zh: value.zh ?? '', en: value.en ?? '', extra };
}

function buildCommit(
  zh: string,
  en: string,
  extra: Record<string, string>,
): Record<string, string> {
  const next: Record<string, string> = {};
  const put = (key: string, raw: string): void => {
    if (raw.length === 0) {
      return;
    }
    next[key] = raw;
  };
  put('zh', zh);
  put('en', en);
  for (const [k, v] of Object.entries(extra)) {
    put(k, v);
  }
  return next;
}

type Draft = { zh: string; en: string; extra: Record<string, string> };

export interface I18nLocaleRowsHandle {
  flush: () => Record<string, string>;
}

type I18nLocaleRowsProps = {
  readonly disabled: boolean;
  readonly summary: string;
  readonly value: Record<string, string>;
  readonly onCommit: (next: Record<string, string>) => void;
  readonly pickLocaleLabel: string;
  readonly addRowHint: string;
  readonly multiline?: boolean;
};

export const I18nLocaleRows = forwardRef<I18nLocaleRowsHandle, I18nLocaleRowsProps>(
  function I18nLocaleRows(props, ref): ReactElement {
    const {
      disabled,
      summary,
      value,
      onCommit,
      pickLocaleLabel,
      addRowHint,
      multiline = false,
    } = props;
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState<Draft>(() => splitI18n(value));
    const [pick, setPick] = useState<string>('');
    const [addVal, setAddVal] = useState('');
    const draftRef = useRef(draft);
    const pickRef = useRef(pick);
    const addValRef = useRef(addVal);

    const pendingCommit = useRef<Record<string, string> | null>(null);
    const onCommitRef = useRef(onCommit);
    onCommitRef.current = onCommit;

    useEffect(() => {
      if (pendingCommit.current !== null) {
        const payload = pendingCommit.current;
        pendingCommit.current = null;
        onCommitRef.current(payload);
      }
    });

    const valueKey = JSON.stringify(value);
    useEffect(() => {
      const next = splitI18n(value);
      draftRef.current = next;
      pickRef.current = '';
      addValRef.current = '';
      setDraft(next);
      setPick('');
      setAddVal('');
    }, [valueKey]);

    const commit = useCallback((d: Draft): void => {
      pendingCommit.current = buildCommit(d.zh, d.en, d.extra);
    }, []);

    const updateDraft = useCallback((updater: (current: Draft) => Draft): Draft => {
      const next = updater(draftRef.current);
      draftRef.current = next;
      setDraft(next);
      return next;
    }, []);

    const updatePick = useCallback((next: string): void => {
      pickRef.current = next;
      setPick(next);
    }, []);

    const updateAddVal = useCallback((next: string): void => {
      addValRef.current = next;
      setAddVal(next);
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        flush: () => {
          const currentDraft = draftRef.current;
          const currentPick = pickRef.current;
          const currentAddVal = addValRef.current;
          const extra =
            currentPick && currentAddVal.length > 0
              ? { ...currentDraft.extra, [currentPick]: currentAddVal }
              : { ...currentDraft.extra };
          const payload = buildCommit(currentDraft.zh, currentDraft.en, extra);
          pendingCommit.current = null;
          onCommitRef.current(payload);
          return payload;
        },
      }),
      [],
    );

    const rowStyle: CSSProperties = {
      display: 'grid',
      gridTemplateColumns: '28px 1fr',
      alignItems: multiline ? 'start' : 'center',
      gap: 8,
      fontSize: 12,
    };

    const labelStyle: CSSProperties = {
      color: '#64748b',
      fontVariantNumeric: 'tabular-nums',
      paddingTop: multiline ? 8 : 0,
    };

    const usedLocales = new Set<string>(['zh', 'en', ...Object.keys(draft.extra)]);
    const pickOptions = EXTRA_LOCALE_OPTIONS.filter((k) => !usedLocales.has(k));

    const textField = (
      val: string,
      onChange: (v: string) => void,
      onBlur: (v: string) => void,
    ): ReactElement =>
      multiline ? (
        <textarea
          className="designer-input"
          rows={4}
          disabled={disabled}
          value={val}
          placeholder="--"
          style={{ resize: 'vertical', minHeight: 72 }}
          onChange={(e) => onChange(e.target.value)}
          onBlur={(e) => onBlur(e.target.value)}
        />
      ) : (
        <input
          className="designer-input"
          disabled={disabled}
          value={val}
          placeholder="--"
          onChange={(e) => onChange(e.target.value)}
          onBlur={(e) => onBlur(e.target.value)}
        />
      );

    return (
      <details
        className="designer-i18n-details"
        open={open}
        onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      >
        <summary>{summary}</summary>
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={rowStyle}>
            <span style={labelStyle}>zh</span>
            {textField(
              draft.zh,
              (v) => updateDraft((d) => ({ ...d, zh: v })),
              (z) => {
                updateDraft((d) => {
                  const next = { ...d, zh: z };
                  commit(next);
                  return next;
                });
              },
            )}
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>en</span>
            {textField(
              draft.en,
              (v) => updateDraft((d) => ({ ...d, en: v })),
              (t) => {
                updateDraft((d) => {
                  const next = { ...d, en: t };
                  commit(next);
                  return next;
                });
              },
            )}
          </div>

          {Object.entries(draft.extra).map(([locale, v]) => (
            <div key={locale} style={rowStyle}>
              <span style={labelStyle}>{locale}</span>
              {textField(
                v,
                (nv) =>
                  updateDraft((d) => ({
                    ...d,
                    extra: { ...d.extra, [locale]: nv },
                  })),
                (raw) => {
                  updateDraft((d) => {
                    const next = { ...d, extra: { ...d.extra, [locale]: raw } };
                    commit(next);
                    return next;
                  });
                },
              )}
            </div>
          ))}

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: multiline ? '1fr' : 'auto 1fr',
              gap: 8,
              alignItems: multiline ? 'stretch' : 'center',
              paddingTop: 8,
              marginTop: 4,
              borderTop: '1px dashed rgba(15, 23, 42, 0.1)',
            }}
          >
            <div style={{ maxWidth: multiline ? '100%' : 140 }}>
              <DesignerSelect
                compact
                disabled={disabled}
                placeholder={pickLocaleLabel}
                value={pick}
                options={[
                  { value: '', label: pickLocaleLabel },
                  ...pickOptions.map((k) => ({ value: k, label: k })),
                ]}
                onChange={(next) => {
                  updatePick(next);
                  updateAddVal('');
                }}
              />
            </div>
            {multiline ? (
              <textarea
                className="designer-input"
                rows={3}
                disabled={disabled || !pick}
                placeholder={addRowHint}
                value={addVal}
                style={{ resize: 'vertical', minHeight: 56 }}
                onChange={(e) => updateAddVal(e.target.value)}
                onBlur={() => {
                  const key = pickRef.current;
                  const val = addValRef.current;
                  if (!key || val.length === 0) {
                    return;
                  }
                  updatePick('');
                  updateAddVal('');
                  updateDraft((d) => {
                    const merged = { ...d.extra, [key]: val };
                    const next = { ...d, extra: merged };
                    commit(next);
                    return next;
                  });
                }}
              />
            ) : (
              <input
                className="designer-input"
                disabled={disabled || !pick}
                placeholder={addRowHint}
                value={addVal}
                onChange={(e) => updateAddVal(e.target.value)}
                onBlur={() => {
                  const key = pickRef.current;
                  const val = addValRef.current;
                  if (!key || val.length === 0) {
                    return;
                  }
                  updatePick('');
                  updateAddVal('');
                  updateDraft((d) => {
                    const merged = { ...d.extra, [key]: val };
                    const next = { ...d, extra: merged };
                    commit(next);
                    return next;
                  });
                }}
              />
            )}
          </div>
        </div>
      </details>
    );
  },
);

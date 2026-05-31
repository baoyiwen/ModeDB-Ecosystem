import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';

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
    // 展示名 / 描述：保留空格与特殊符号，仅跳过空字符串。
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

type I18nLocaleRowsProps = {
  readonly disabled: boolean;
  readonly summary: string;
  readonly value: Record<string, string>;
  readonly onCommit: (next: Record<string, string>) => void;
  readonly pickLocaleLabel: string;
  readonly addRowHint: string;
  readonly multiline?: boolean;
};

/**
 * Collapsible I18N rows: zh / en by default, extra locales below,
 * with a locale-picker trailing row.
 */
export function I18nLocaleRows(props: I18nLocaleRowsProps): ReactElement {
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
    setDraft(splitI18n(value));
    setPick('');
    setAddVal('');
  }, [valueKey]);

  const commit = useCallback((d: Draft): void => {
    pendingCommit.current = buildCommit(d.zh, d.en, d.extra);
  }, []);

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
        placeholder="—"
        style={{ resize: 'vertical', minHeight: 72 }}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => onBlur(e.target.value)}
      />
    ) : (
      <input
        className="designer-input"
        disabled={disabled}
        value={val}
        placeholder="—"
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
            (v) => setDraft((d) => ({ ...d, zh: v })),
            (z) => {
              setDraft((d) => {
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
            (v) => setDraft((d) => ({ ...d, en: v })),
            (t) => {
              setDraft((d) => {
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
                setDraft((d) => ({
                  ...d,
                  extra: { ...d.extra, [locale]: nv },
                })),
              (raw) => {
                setDraft((d) => {
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
          <select
            className="designer-input"
            style={{ maxWidth: multiline ? '100%' : 120, fontSize: 11 }}
            disabled={disabled}
            value={pick}
            onChange={(e) => {
              setPick(e.target.value);
              setAddVal('');
            }}
          >
            <option value="">{pickLocaleLabel}</option>
            {pickOptions.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          {multiline ? (
            <textarea
              className="designer-input"
              rows={3}
              disabled={disabled || !pick}
              placeholder={addRowHint}
              value={addVal}
              style={{ resize: 'vertical', minHeight: 56 }}
              onChange={(e) => setAddVal(e.target.value)}
              onBlur={() => {
                if (!pick || addVal.length === 0) {
                  return;
                }
                const key = pick;
                const val = addVal;
                setPick('');
                setAddVal('');
                setDraft((d) => {
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
              onChange={(e) => setAddVal(e.target.value)}
              onBlur={() => {
                if (!pick || addVal.length === 0) {
                  return;
                }
                const key = pick;
                const val = addVal;
                setPick('');
                setAddVal('');
                setDraft((d) => {
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
}

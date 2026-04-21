import { useEffect, useState, type CSSProperties, type ReactElement } from 'react';

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
  if (zh.trim()) {
    next.zh = zh.trim();
  }
  if (en.trim()) {
    next.en = en.trim();
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v.trim()) {
      next[k] = v.trim();
    }
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
};

/**
 * 可折叠 I18N：默认 zh / en 两行，其余语言单独列出；末行选择语言后填写并合并。
 */
export function I18nLocaleRows(props: I18nLocaleRowsProps): ReactElement {
  const { disabled, summary, value, onCommit, pickLocaleLabel, addRowHint } = props;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => splitI18n(value));
  const [pick, setPick] = useState<string>('');
  const [addVal, setAddVal] = useState('');

  const valueKey = JSON.stringify(value);
  useEffect(() => {
    setDraft(splitI18n(value));
    setPick('');
    setAddVal('');
  }, [valueKey]);

  const commit = (d: Draft): void => {
    onCommit(buildCommit(d.zh, d.en, d.extra));
  };

  const rowStyle: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: '28px 1fr',
    alignItems: 'center',
    gap: 8,
    fontSize: 12,
  };

  const labelStyle: CSSProperties = { color: '#64748b', fontVariantNumeric: 'tabular-nums' };

  const usedLocales = new Set<string>(['zh', 'en', ...Object.keys(draft.extra)]);
  const pickOptions = EXTRA_LOCALE_OPTIONS.filter((k) => !usedLocales.has(k));

  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      style={{
        border: '1px solid #e2e8f0',
        borderRadius: 8,
        padding: '6px 8px',
        background: '#fafafa',
      }}
    >
      <summary
        style={{
          cursor: 'pointer',
          fontSize: 12,
          color: '#334155',
          fontWeight: 600,
          listStyle: 'none',
        }}
      >
        {summary}
      </summary>
      <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={rowStyle}>
          <span style={labelStyle}>zh</span>
          <input
            className="designer-input"
            disabled={disabled}
            value={draft.zh}
            placeholder="—"
            onChange={(e) => setDraft((d) => ({ ...d, zh: e.target.value }))}
            onBlur={(e) => {
              const z = e.target.value;
              setDraft((d) => {
                const next = { ...d, zh: z };
                commit(next);
                return next;
              });
            }}
          />
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>en</span>
          <input
            className="designer-input"
            disabled={disabled}
            value={draft.en}
            placeholder="—"
            onChange={(e) => setDraft((d) => ({ ...d, en: e.target.value }))}
            onBlur={(e) => {
              const t = e.target.value;
              setDraft((d) => {
                const next = { ...d, en: t };
                commit(next);
                return next;
              });
            }}
          />
        </div>

        {Object.entries(draft.extra).map(([locale, v]) => (
          <div key={locale} style={rowStyle}>
            <span style={labelStyle}>{locale}</span>
            <input
              className="designer-input"
              disabled={disabled}
              value={v}
              onChange={(e) => {
                const next = e.target.value;
                setDraft((d) => ({
                  ...d,
                  extra: { ...d.extra, [locale]: next },
                }));
              }}
              onBlur={(e) => {
                const v = e.target.value;
                setDraft((d) => {
                  const nextEx = { ...d.extra, [locale]: v };
                  const next = { ...d, extra: nextEx };
                  commit(next);
                  return next;
                });
              }}
            />
          </div>
        ))}

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            gap: 8,
            alignItems: 'center',
            paddingTop: 4,
            borderTop: '1px dashed #e2e8f0',
          }}
        >
          <select
            className="designer-input"
            style={{ maxWidth: 120, fontSize: 11 }}
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
          <input
            className="designer-input"
            disabled={disabled || !pick}
            placeholder={addRowHint}
            value={addVal}
            onChange={(e) => setAddVal(e.target.value)}
            onBlur={() => {
              if (!pick || !addVal.trim()) {
                return;
              }
              const key = pick;
              const val = addVal.trim();
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
        </div>
      </div>
    </details>
  );
}

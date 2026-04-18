import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_LOCALE, type LocaleId, type MessageKey, messages } from './messages';

const LS_LOCALE = 'modedb.playground.locale';

function loadLocale(): LocaleId {
  try {
    const raw = localStorage.getItem(LS_LOCALE)?.trim();
    if (raw === 'en' || raw === 'zh-CN') {
      return raw;
    }
  } catch {
    /* ignore */
  }
  if (typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh')) {
    return 'zh-CN';
  }
  return 'en';
}

function saveLocale(locale: LocaleId): void {
  try {
    localStorage.setItem(LS_LOCALE, locale);
  } catch {
    /* ignore */
  }
}

function interpolate(template: string, params?: Record<string, string>): string {
  if (!params) {
    return template;
  }
  let out = template;
  for (const [k, v] of Object.entries(params)) {
    out = out.split(`{${k}}`).join(v);
  }
  return out;
}

export type I18nContextValue = {
  readonly locale: LocaleId;
  readonly setLocale: (locale: LocaleId) => void;
  readonly t: (key: MessageKey, params?: Record<string, string>) => string;
};

const Ctx = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { readonly children: ReactNode }): React.ReactElement {
  const [locale, setLocaleState] = useState<LocaleId>(loadLocale);

  const setLocale = useCallback((next: LocaleId) => {
    setLocaleState(next);
    saveLocale(next);
  }, []);

  const t = useCallback(
    (key: MessageKey, params?: Record<string, string>) => {
      const table = messages[locale] ?? messages[DEFAULT_LOCALE];
      const fallback = messages.en[key];
      const raw = table[key] ?? fallback ?? key;
      return interpolate(raw, params);
    },
    [locale],
  );

  const value = useMemo(
    () => ({
      locale,
      setLocale,
      t,
    }),
    [locale, setLocale, t],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18nContextValue {
  const v = useContext(Ctx);
  if (!v) {
    throw new Error('useI18n must be used within I18nProvider');
  }
  return v;
}

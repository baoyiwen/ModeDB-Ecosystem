import enUi from '../i18n/locales/en/ui.json';
import jaUi from '../i18n/locales/ja/ui.json';
import zhUi from '../i18n/locales/zh/ui.json';

export type StudioLocale = 'en' | 'zh' | 'ja';

type UiBundle = Record<string, string>;

const bundles: Record<StudioLocale, UiBundle> = {
  en: enUi as UiBundle,
  zh: zhUi as UiBundle,
  ja: jaUi as UiBundle,
};

const LOCALE_KEY = 'data-studio:locale';

function readStoredLocale(): StudioLocale {
  if (typeof localStorage === 'undefined') {
    return 'en';
  }
  try {
    const v = localStorage.getItem(LOCALE_KEY);
    if (v === 'en' || v === 'zh' || v === 'ja') {
      return v;
    }
  } catch {
    /* ignore */
  }
  return 'en';
}

/** Lightweight i18n for Data Studio (ui namespace only). */
export class StudioI18n {
  private _locale: StudioLocale = readStoredLocale();
  private readonly _listeners = new Set<() => void>();

  get locale(): StudioLocale {
    return this._locale;
  }

  setLocale(code: StudioLocale): void {
    this._locale = code;
    try {
      localStorage.setItem(LOCALE_KEY, code);
    } catch {
      /* ignore */
    }
    for (const fn of this._listeners) {
      fn();
    }
  }

  subscribe(fn: () => void): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  t(key: string, params?: Record<string, string>): string {
    const template = bundles[this._locale][key] ?? bundles.en[key] ?? key;
    if (!params) {
      return template;
    }
    return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => params[name] ?? '');
  }
}

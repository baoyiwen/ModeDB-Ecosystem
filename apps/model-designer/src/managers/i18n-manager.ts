import enEngine from '../i18n/locales/en/engine.json' with { type: 'json' };
import enErrors from '../i18n/locales/en/errors.json' with { type: 'json' };
import enUi from '../i18n/locales/en/ui.json' with { type: 'json' };
import jaEngine from '../i18n/locales/ja/engine.json' with { type: 'json' };
import jaErrors from '../i18n/locales/ja/errors.json' with { type: 'json' };
import jaUi from '../i18n/locales/ja/ui.json' with { type: 'json' };
import zhEngine from '../i18n/locales/zh/engine.json' with { type: 'json' };
import zhErrors from '../i18n/locales/zh/errors.json' with { type: 'json' };
import zhUi from '../i18n/locales/zh/ui.json' with { type: 'json' };

export type LocaleCode = 'en' | 'zh' | 'ja';

export type Namespace = 'ui' | 'engine' | 'errors';

type Bundle = Record<Namespace, Record<string, string>>;

const bundles: Record<LocaleCode, Bundle> = {
  en: {
    ui: enUi as Record<string, string>,
    engine: enEngine as Record<string, string>,
    errors: enErrors as Record<string, string>,
  },
  zh: {
    ui: zhUi as Record<string, string>,
    engine: zhEngine as Record<string, string>,
    errors: zhErrors as Record<string, string>,
  },
  ja: {
    ui: jaUi as Record<string, string>,
    engine: jaEngine as Record<string, string>,
    errors: jaErrors as Record<string, string>,
  },
};

export type I18nListener = () => void;

const LOCALE_STORAGE_KEY = 'model-designer:locale';

function readStoredLocale(): LocaleCode {
  if (typeof localStorage === 'undefined') {
    return 'en';
  }
  try {
    const v = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (v === 'en' || v === 'zh' || v === 'ja') {
      return v;
    }
  } catch {
    /* ignore */
  }
  return 'en';
}

function writeStoredLocale(code: LocaleCode): void {
  if (typeof localStorage === 'undefined') {
    return;
  }
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, code);
  } catch {
    /* ignore */
  }
}

/**
 * 命名空间：ui / engine / errors；字符串由此集中出口。
 */
export class I18nManager {
  private _locale: LocaleCode = readStoredLocale();
  private readonly _listeners = new Set<I18nListener>();

  get locale(): LocaleCode {
    return this._locale;
  }

  setLocale(code: LocaleCode): void {
    this._locale = code;
    writeStoredLocale(code);
    for (const fn of this._listeners) {
      fn();
    }
  }

  subscribe(fn: I18nListener): () => void {
    this._listeners.add(fn);
    return () => {
      this._listeners.delete(fn);
    };
  }

  t(ns: Namespace, key: string): string {
    const table = bundles[this._locale][ns];
    return table[key] ?? bundles.en[ns][key] ?? key;
  }
}

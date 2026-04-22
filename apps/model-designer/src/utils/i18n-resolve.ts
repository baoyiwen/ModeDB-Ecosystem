import type { EngineModelNode } from '../types/engine-schema.js';

/** 从 I18N 映射中取「规范」单名：优先 zh → en → ja → 任意非空，否则 fallback */
export function pickCanonicalFromI18n(
  map: Record<string, string> | undefined,
  fallback: string,
): string {
  const m = map ?? {};
  for (const k of ['zh', 'en', 'ja']) {
    const v = m[k]?.trim();
    if (v) {
      return v;
    }
  }
  for (const v of Object.values(m)) {
    const t = v?.trim();
    if (t) {
      return t;
    }
  }
  return fallback;
}

/** 按当前界面语言解析展示文案；无则回退到 canonical / fallback */
export function resolveI18nForLocale(
  map: Record<string, string> | undefined,
  locale: string,
  fallback: string,
): string {
  const m = map ?? {};
  const direct = m[locale]?.trim();
  if (direct) {
    return direct;
  }
  return pickCanonicalFromI18n(m, fallback);
}

export function resolveModelDisplayName(model: EngineModelNode, locale: string): string {
  return resolveI18nForLocale(model.name_i18n, locale, model.model_name || model.id);
}

export function mapI18nSuffix(
  map: Record<string, string> | undefined,
  suffix: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!map) {
    return out;
  }
  for (const [k, v] of Object.entries(map)) {
    out[k] = `${v}${suffix}`;
  }
  return out;
}

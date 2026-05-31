/**
 * I18N 名称解析工具：
 * - 模型 / 关系的"显示名"统一走 `*_i18n[locale] → canonical → 唯一名 → id` 兜底链。
 * - `mapI18nSuffix` 用于克隆 / 复制时给所有语言加统一后缀（如 `_copy`）。
 *
 * 该文件所有导出都是模块顶层 `export function`，对 Vite HMR 友好；任何对此文件的
 * 改动若引起 HMR 增量 patch 出现导出名"消失"的怪现象，请重启 dev server。
 */
import type { EngineModelNode, EngineRelationEdge } from '../types/engine-schema.js';
import {
  INHERIT_RELATION_DEFAULT_NAME,
  INHERIT_RELATION_LABEL_I18N,
} from '../config/graph-edge-kinds.js';
import { relationCardinalityUiKey } from '../config/relation-cardinality.js';

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

/** 正向关系名：`forward_name_i18n[locale]` → canonical → `forward_name`（唯一名）。 */
export function resolveRelationForwardLabel(rel: EngineRelationEdge, locale: string): string {
  return resolveI18nForLocale(
    rel.forward_name_i18n,
    locale,
    rel.forward_name || rel.kind || rel.id,
  );
}

/** 逆向关系名：`reverse_name_i18n[locale]` → canonical → `reverse_name`（唯一名）。 */
export function resolveRelationReverseLabel(rel: EngineRelationEdge, locale: string): string {
  return resolveI18nForLocale(
    rel.reverse_name_i18n,
    locale,
    rel.reverse_name || rel.kind || rel.id,
  );
}

/**
 * 继承关系名（单向）：`forward_name_i18n` → `forward_name` → 默认 `inherits`。
 * 继承边不使用 reverse_name / 成对命名。
 */
export function resolveInheritRelationLabel(rel: EngineRelationEdge, locale: string): string {
  const direct = rel.forward_name_i18n?.[locale]?.trim();
  if (direct) {
    return direct;
  }
  const name = rel.forward_name || INHERIT_RELATION_DEFAULT_NAME;
  if (
    name === INHERIT_RELATION_DEFAULT_NAME ||
    name.startsWith(`${INHERIT_RELATION_DEFAULT_NAME}-`)
  ) {
    return INHERIT_RELATION_LABEL_I18N[locale] ?? INHERIT_RELATION_LABEL_I18N.en ?? name;
  }
  return resolveI18nForLocale(rel.forward_name_i18n, locale, name);
}

/** 对应关系基数文案的 ui.json 键名（一对多 / 多对一）。 */
export { relationCardinalityUiKey };

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

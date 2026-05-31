/** 与引擎 catalog 对齐的有向链接类型 */
export const GRAPH_NODE_LINK_KIND = 'modelLinksOut' as const;
/** 父子 / 继承（画布子模型）——绘制成虚线直线 */
export const GRAPH_INHERIT_KIND = 'modelInherits' as const;

/** 继承边默认唯一名（与成对关系线的 children/parent 或 source-target 规则不同）。 */
export const INHERIT_RELATION_DEFAULT_NAME = 'inherits' as const;

/** 继承关系画布标签默认 i18n（`forward_name_i18n` 缺失时的展示回退）。 */
export const INHERIT_RELATION_LABEL_I18N: Record<string, string> = {
  zh: '继承',
  en: 'inherits',
  ja: '継承',
};

export function isInheritRelation(kind: string): boolean {
  return kind === GRAPH_INHERIT_KIND;
}

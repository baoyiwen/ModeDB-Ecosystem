/**
 * 层级树：分组（文件夹）与页（承载 model / relation / props 的画布作用域）。
 */
export type LayerTreeKind = 'group' | 'page';

export interface LayerTreeNode {
  readonly id: string;
  kind: LayerTreeKind;
  /** 树节点主名称（持久化；展示优先走 name_i18n）。 */
  label: string;
  name_i18n?: Record<string, string>;
  description_i18n?: Record<string, string>;
  /** 是否参与画布可见性（页可与旧 flat layer 对齐） */
  isVisible: boolean;
  sort: number;
  /** 仅 kind === `group` */
  children: LayerTreeNode[];
  /** 仅 kind === `page`：关联画布模型 id */
  memberModelIds: string[];
  /** Page member relation ids. Kept separate from models so relations can be layered independently. */
  memberRelationIds?: string[];
}

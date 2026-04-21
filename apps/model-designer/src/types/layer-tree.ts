/**
 * 层级树：分组（文件夹）与页（承载 model / relation / props 的画布作用域）。
 */
export type LayerTreeKind = 'group' | 'page';

export interface LayerTreeNode {
  readonly id: string;
  kind: LayerTreeKind;
  label: string;
  /** 是否参与画布可见性（页可与旧 flat layer 对齐） */
  isVisible: boolean;
  sort: number;
  /** 仅 kind === `group` */
  children: LayerTreeNode[];
  /** 仅 kind === `page`：关联画布模型 id */
  memberModelIds: string[];
}

/** 唯一根分组 id（不可删除、不可拖拽；可编辑名称与描述）。 */
export const LAYER_ROOT_GROUP_ID = 'group-root' as const;

export const LAYER_DEFAULT_PAGE_ID = 'page-main' as const;

export function isLayerRootGroupId(id: string): boolean {
  return id === LAYER_ROOT_GROUP_ID;
}

export function defaultLayerGroupLabel(): string {
  return `group_${Date.now()}`;
}

export function defaultLayerPageLabel(): string {
  return `layer_${Date.now()}`;
}

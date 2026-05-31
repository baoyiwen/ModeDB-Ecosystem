import type { LayerTreeNode } from '../types/layer-tree.js';
import { resolveI18nForLocale } from './i18n-resolve.js';

export function resolveLayerNodeLabel(node: LayerTreeNode, locale: string): string {
  return resolveI18nForLocale(node.name_i18n, locale, node.label);
}

export function findLayerNode(
  roots: readonly LayerTreeNode[],
  id: string,
): LayerTreeNode | undefined {
  for (const n of roots) {
    if (n.id === id) {
      return n;
    }
    if (n.kind === 'group') {
      const hit = findLayerNode(n.children, id);
      if (hit) {
        return hit;
      }
    }
  }
  return undefined;
}

/** 新增组/页时的父分组：选中组 → 该组；否则 → 根分组。 */
export function resolveLayerAddParentGroupId(
  roots: readonly LayerTreeNode[],
  selectedNodeId: string | undefined,
  rootGroupId: string,
): string {
  if (!selectedNodeId) {
    return rootGroupId;
  }
  const node = findLayerNode(roots, selectedNodeId);
  if (node?.kind === 'group') {
    return node.id;
  }
  return rootGroupId;
}

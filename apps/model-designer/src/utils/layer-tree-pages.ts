import type { LayerTreeNode } from '../types/layer-tree.js';

/** 遍历层级树，收集全部「页」节点（可选画布归属）。 */
export function collectLayerPages(
  roots: readonly LayerTreeNode[],
): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = [];
  const walk = (nodes: readonly LayerTreeNode[]): void => {
    for (const n of nodes) {
      if (n.kind === 'group') {
        walk(n.children);
      } else {
        out.push({ id: n.id, label: n.label });
      }
    }
  };
  walk(roots);
  return out;
}

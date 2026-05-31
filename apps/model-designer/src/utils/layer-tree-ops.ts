import type { LayerTreeNode } from '../types/layer-tree.js';
import {
  defaultLayerGroupLabel,
  isLayerRootGroupId,
  LAYER_ROOT_GROUP_ID,
} from '../config/layer-tree-defaults.js';

export type LayerDropZone = 'before' | 'after' | 'inside';

type NodeLocation = {
  list: LayerTreeNode[];
  index: number;
  node: LayerTreeNode;
};

function findLocation(list: LayerTreeNode[], id: string): NodeLocation | null {
  for (let i = 0; i < list.length; i++) {
    const node = list[i]!;
    if (node.id === id) {
      return { list, index: i, node };
    }
    if (node.kind === 'group') {
      const hit = findLocation(node.children, id);
      if (hit) {
        return hit;
      }
    }
  }
  return null;
}

function containsId(node: LayerTreeNode, id: string): boolean {
  if (node.id === id) {
    return true;
  }
  if (node.kind !== 'group') {
    return false;
  }
  for (const child of node.children) {
    if (containsId(child, id)) {
      return true;
    }
  }
  return false;
}

function reindexSort(list: LayerTreeNode[]): void {
  for (let i = 0; i < list.length; i++) {
    list[i]!.sort = i;
  }
}

function createWrapGroup(children: LayerTreeNode[]): LayerTreeNode {
  return {
    id: crypto.randomUUID(),
    kind: 'group',
    label: defaultLayerGroupLabel(),
    isVisible: true,
    sort: 0,
    memberModelIds: [],
    children,
  };
}

/**
 * 在可变树上执行拖拽放置（调用方传入 clone 后的 roots）。
 */
export function applyLayerTreeDrop(
  roots: LayerTreeNode[],
  dragId: string,
  targetId: string,
  zone: LayerDropZone,
): boolean {
  if (dragId === targetId) {
    return false;
  }
  if (isLayerRootGroupId(dragId)) {
    return false;
  }

  const dragLoc = findLocation(roots, dragId);
  const targetLoc = findLocation(roots, targetId);
  if (!dragLoc || !targetLoc) {
    return false;
  }

  const dragGroup = dragLoc.node.kind === 'group' ? dragLoc.node : null;
  if (dragGroup && containsId(dragGroup, targetId)) {
    return false;
  }

  if (isLayerRootGroupId(targetId) && zone !== 'inside') {
    return false;
  }

  const dragIndex = dragLoc.index;
  const dragParent = dragLoc.list;
  const targetIndex = targetLoc.index;
  const targetParent = targetLoc.list;
  const sameParent = dragParent === targetParent;

  const dragged = dragParent.splice(dragIndex, 1)[0]!;
  if (!dragged) {
    return false;
  }

  let adjustedTargetIndex = targetIndex;
  if (sameParent && dragIndex < targetIndex) {
    adjustedTargetIndex -= 1;
  }

  const targetLocAfter = findLocation(roots, targetId);
  if (!targetLocAfter) {
    return false;
  }

  if (zone === 'inside') {
    if (targetLocAfter.node.kind === 'group') {
      targetLocAfter.node.children.push(dragged);
      reindexSort(targetLocAfter.node.children);
    } else {
      const parentList = targetLocAfter.list;
      const page = parentList.splice(adjustedTargetIndex, 1)[0]!;
      if (!page || page.kind !== 'page') {
        return false;
      }
      const wrap = createWrapGroup(
        sameParent && dragIndex < targetIndex ? [dragged, page] : [page, dragged],
      );
      parentList.splice(adjustedTargetIndex, 0, wrap);
      reindexSort(parentList);
      reindexSort(wrap.children);
    }
  } else {
    const parentList = targetLocAfter.list;
    const insertAt = zone === 'before' ? adjustedTargetIndex : adjustedTargetIndex + 1;
    parentList.splice(insertAt, 0, dragged);
    reindexSort(parentList);
  }

  reindexSort(roots);
  return true;
}

export function collectPageIdsInSubtree(node: LayerTreeNode): string[] {
  if (node.kind === 'page') {
    return [node.id];
  }
  const out: string[] = [];
  for (const child of node.children) {
    out.push(...collectPageIdsInSubtree(child));
  }
  return out;
}

export function collectAllPageIds(roots: readonly LayerTreeNode[]): string[] {
  const out: string[] = [];
  for (const root of roots) {
    out.push(...collectPageIdsInSubtree(root));
  }
  return out;
}

export function removeLayerNodeFromTree(roots: LayerTreeNode[], id: string): boolean {
  if (isLayerRootGroupId(id)) {
    return false;
  }
  const removeFrom = (list: LayerTreeNode[]): boolean => {
    const idx = list.findIndex((n) => n.id === id);
    if (idx >= 0) {
      list.splice(idx, 1);
      reindexSort(list);
      return true;
    }
    for (const n of list) {
      if (n.kind === 'group' && removeFrom(n.children)) {
        return true;
      }
    }
    return false;
  };
  return removeFrom(roots);
}

export function normalizeLayerTreeRoots(roots: readonly LayerTreeNode[]): LayerTreeNode[] {
  if (roots.length === 0) {
    return [];
  }
  const clone = (nodes: readonly LayerTreeNode[]): LayerTreeNode[] =>
    nodes.map((n) => ({
      ...n,
      name_i18n: n.name_i18n ? { ...n.name_i18n } : undefined,
      description_i18n: n.description_i18n ? { ...n.description_i18n } : undefined,
      children: n.kind === 'group' ? clone(n.children) : [],
      memberModelIds: n.kind === 'page' ? [...n.memberModelIds] : [],
    }));

  const cloned = clone(roots);
  const root = cloned.find((n) => n.id === LAYER_ROOT_GROUP_ID && n.kind === 'group');
  if (cloned.length === 1 && root) {
    return cloned;
  }

  const mergedRoot: LayerTreeNode = root ?? {
    id: LAYER_ROOT_GROUP_ID,
    kind: 'group',
    label: 'Root',
    isVisible: true,
    sort: 0,
    memberModelIds: [],
    children: [],
    name_i18n: { zh: '根分组', en: 'Root', ja: 'ルート' },
  };

  const extras = cloned.filter((n) => n.id !== LAYER_ROOT_GROUP_ID);
  mergedRoot.children = [...mergedRoot.children, ...extras];
  reindexSort(mergedRoot.children);
  return [mergedRoot];
}

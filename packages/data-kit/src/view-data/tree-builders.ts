import type { WireEntityNode } from '@mode-db/shared';

import type { ColumnDef, EntityRowRef, MetricDef, ViewTreeNode } from './view-data-shape.js';

export type { ViewTreeNode } from './view-data-shape.js';

function rowRefFromData(
  data: Record<string, unknown>,
  model: string | undefined,
): EntityRowRef | null {
  if (!model) {
    return null;
  }
  const id = data._id;
  if (typeof id === 'string' && id.length > 0) {
    return { model, id };
  }
  if (typeof id === 'number' && Number.isFinite(id)) {
    return { model, id: String(id) };
  }
  return null;
}

function nodeKey(prefix: string, label: string, index: number): string {
  return `${prefix}:${label}:${index}`;
}

/**
 * Converts wire entity nodes (with optional `relates`) into UI tree nodes.
 */
export function wireEntitiesToTreeNodes(
  nodes: readonly WireEntityNode[],
  options?: { depth?: number; keyPrefix?: string },
): ViewTreeNode[] {
  const depth = options?.depth ?? 0;
  const prefix = options?.keyPrefix ?? 'root';
  return nodes.map((node, index) =>
    entityNodeToTree(node, depth, nodeKey(prefix, String(node.data._id ?? index), index)),
  );
}

function entityNodeToTree(node: WireEntityNode, depth: number, key: string): ViewTreeNode {
  const data = { ...node.data };
  delete data['relates'];
  const label =
    typeof data._id === 'string' || typeof data._id === 'number' ? String(data._id) : node.model;
  const children: ViewTreeNode[] = [];
  if (node.relates) {
    for (const [relationKey, related] of Object.entries(node.relates)) {
      for (let i = 0; i < related.length; i++) {
        const child = related[i]!;
        children.push({
          ...entityNodeToTree(child, depth + 1, nodeKey(key, relationKey, i)),
          relationKey,
        });
      }
    }
  }
  return {
    key,
    depth,
    label,
    values: data,
    rowRef: rowRefFromData(data, node.model),
    sourceModel: node.model,
    children,
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Converts {@link AnalysisResult.asTree} nested object into expandable tree nodes.
 */
export function analysisTreeToViewNodes(
  tree: Record<string, unknown>,
  dimensionKeys: readonly string[],
  metrics: readonly MetricDef[],
): ViewTreeNode[] {
  const metricKeys = new Set(metrics.map((m) => m.key));

  function walk(
    node: Record<string, unknown>,
    dimIndex: number,
    pathValues: Record<string, unknown>,
    prefix: string,
  ): ViewTreeNode[] {
    if (dimIndex >= dimensionKeys.length) {
      return [];
    }
    const dimKey = dimensionKeys[dimIndex]!;
    const isLeafLevel = dimIndex === dimensionKeys.length - 1;
    const out: ViewTreeNode[] = [];
    let index = 0;
    for (const [seg, child] of Object.entries(node)) {
      if (!isPlainObject(child)) {
        continue;
      }
      const segmentValues = { ...pathValues, [dimKey]: coerceSegment(seg) };
      const childKey = nodeKey(prefix, seg, index);
      index += 1;

      if (isLeafLevel) {
        const metricValues: Record<string, unknown> = { ...segmentValues };
        for (const [k, v] of Object.entries(child)) {
          if (metricKeys.has(k) || !isPlainObject(v)) {
            metricValues[k] = v;
          }
        }
        out.push({
          key: childKey,
          depth: dimIndex,
          label: seg,
          values: metricValues,
          children: [],
        });
        continue;
      }

      const childNodes = walk(child, dimIndex + 1, segmentValues, childKey);
      out.push({
        key: childKey,
        depth: dimIndex,
        label: seg,
        values: segmentValues,
        children: childNodes,
      });
    }
    return out;
  }

  return walk(tree, 0, {}, 'analysis');
}

function coerceSegment(seg: string): unknown {
  if (seg === 'true') {
    return true;
  }
  if (seg === 'false') {
    return false;
  }
  if (seg === 'null') {
    return null;
  }
  const n = Number(seg);
  if (seg !== '' && Number.isFinite(n) && String(n) === seg) {
    return n;
  }
  return seg;
}

/** Returns true when any entity node carries nested relates. */
export function hasNestedRelates(nodes: readonly WireEntityNode[]): boolean {
  for (const node of nodes) {
    if (node.relates && Object.keys(node.relates).length > 0) {
      return true;
    }
    if (node.relates) {
      for (const children of Object.values(node.relates)) {
        if (hasNestedRelates(children)) {
          return true;
        }
      }
    }
  }
  return false;
}

/** Flattens tree nodes to a depth-first visible row list (respecting expand set). */
export function flattenVisibleTreeNodes(
  roots: readonly ViewTreeNode[],
  expanded: ReadonlySet<string>,
): ViewTreeNode[] {
  const out: ViewTreeNode[] = [];
  const visit = (node: ViewTreeNode): void => {
    out.push(node);
    if (node.children.length > 0 && expanded.has(node.key)) {
      for (const child of node.children) {
        visit(child);
      }
    }
  };
  for (const root of roots) {
    visit(root);
  }
  return out;
}

/** Collects column keys from tree node value objects (excluding nested keys). */
export function inferTreeColumns(
  nodes: readonly ViewTreeNode[],
  options?: { excludeKeys?: ReadonlySet<string> },
): ColumnDef[] {
  const exclude = options?.excludeKeys ?? new Set(['relates']);
  const keys = new Set<string>();
  const walk = (list: readonly ViewTreeNode[]): void => {
    for (const node of list) {
      for (const k of Object.keys(node.values)) {
        if (!exclude.has(k)) {
          keys.add(k);
        }
      }
      walk(node.children);
    }
  };
  walk(nodes);
  return [...keys].sort().map((key) => ({
    key,
    readOnly: key === '_id',
  }));
}

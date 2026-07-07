import type { WireEntityNode, WireExecuteResultJson, WireGroupBucket } from '@mode-db/shared';

import type {
  ColumnDef,
  EntityRowRef,
  MetricDef,
  ViewDataShape,
  ViewGroupBucket,
  ViewPagination,
} from './view-data-shape.js';
import { applyPropFieldColumns } from './prop-fields.js';
import {
  analysisTreeToViewNodes,
  hasNestedRelates,
  inferTreeColumns,
  wireEntitiesToTreeNodes,
} from './tree-builders.js';

const ID_FIELD = '_id';
type ColumnLabelMap = Readonly<Record<string, string>>;

function inferColumns(rows: readonly Record<string, unknown>[]): ColumnDef[] {
  const keys = new Set<string>();
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      keys.add(k);
    }
  }
  return [...keys].sort().map((key) => ({
    key,
    readOnly: key === ID_FIELD,
  }));
}

function extractRowRef(
  row: Record<string, unknown>,
  sourceModel: string | undefined,
): EntityRowRef | null {
  if (!sourceModel) {
    return null;
  }
  const id = row[ID_FIELD];
  if (typeof id === 'string' && id.length > 0) {
    return { model: sourceModel, id };
  }
  if (typeof id === 'number' && Number.isFinite(id)) {
    return { model: sourceModel, id: String(id) };
  }
  return null;
}

function applyColumnLabels(columns: readonly ColumnDef[], labels?: ColumnLabelMap): ColumnDef[] {
  if (!labels) {
    return [...columns];
  }
  return columns.map((col) => {
    const label = labels[col.key]?.trim();
    return label ? { ...col, label } : col;
  });
}

function adaptRowsResult(
  rows: readonly WireEntityNode[],
  pagination?: ViewPagination,
  propFields?: readonly string[],
  sourceModelHint?: string,
  columnLabels?: ColumnLabelMap,
): ViewDataShape {
  if (rows.length === 0) {
    return { kind: 'empty', reason: 'no_rows' };
  }

  if (hasNestedRelates(rows)) {
    const roots = wireEntitiesToTreeNodes(rows);
    const columns = applyColumnLabels(
      applyPropFieldColumns(inferTreeColumns(roots), propFields),
      columnLabels,
    );
    const sourceModel = rows[0]?.model ?? sourceModelHint;
    return {
      kind: 'tree',
      treeKind: 'entity',
      columns,
      roots,
      sourceModel,
      pagination,
    };
  }

  const sourceModel = rows[0]?.model ?? sourceModelHint;
  const flatRows = rows.map((r) => ({ ...r.data }));
  const columns = applyColumnLabels(
    applyPropFieldColumns(inferColumns(flatRows), propFields),
    columnLabels,
  );
  const rowRefs = sourceModel ? flatRows.map((row) => extractRowRef(row, sourceModel)) : undefined;
  return {
    kind: 'tabular',
    columns,
    rows: flatRows,
    rowRefs,
    sourceModel,
    pagination,
  };
}

function metricsFromAnalysisRows(
  dimensionKeys: readonly string[],
  rows: readonly Record<string, unknown>[],
  columnLabels?: ColumnLabelMap,
): MetricDef[] {
  const dimSet = new Set(dimensionKeys);
  return inferColumns(rows)
    .map((c) => c.key)
    .filter((k) => !dimSet.has(k))
    .map((key) => ({ key, label: columnLabels?.[key] }));
}

function adaptAnalysisResult(
  dimensionKeys: readonly string[],
  rows: readonly Record<string, unknown>[],
  tree: Record<string, unknown> | undefined,
  pagination?: ViewPagination,
  isLeafGrain = false,
  columnLabels?: ColumnLabelMap,
): ViewDataShape {
  if (rows.length === 0 && (!tree || Object.keys(tree).length === 0)) {
    return { kind: 'empty', reason: 'no_analysis_rows' };
  }

  const metrics = metricsFromAnalysisRows(dimensionKeys, rows, columnLabels);
  const dimSet = new Set(dimensionKeys);
  const allKeys = inferColumns(rows).map((c) => c.key);
  const columns: ColumnDef[] = allKeys.map((key) => ({
    key,
    label: columnLabels?.[key],
    readOnly: !isLeafGrain || dimSet.has(key),
    isMetric: !dimSet.has(key),
  }));

  if (tree && dimensionKeys.length > 0 && Object.keys(tree).length > 0) {
    const roots = analysisTreeToViewNodes(tree, dimensionKeys, metrics);
    const treeColumns = inferTreeColumns(roots);
    const mergedKeys = new Set([...dimensionKeys, ...treeColumns.map((c) => c.key)]);
    const treeCols: ColumnDef[] = [...mergedKeys].map((key) => ({
      key,
      label: columnLabels?.[key],
      readOnly: dimSet.has(key) || !isLeafGrain,
      isMetric: !dimSet.has(key),
    }));
    return {
      kind: 'tree',
      treeKind: 'analysis',
      columns: treeCols,
      roots,
      pagination,
    };
  }

  return {
    kind: 'pivot',
    dimensions: [...dimensionKeys],
    metrics,
    columns,
    rows,
    isLeafGrain,
    pagination,
  };
}

function adaptGroupsResult(
  dimensionKeys: readonly string[],
  groups: readonly WireGroupBucket[],
  pagination?: ViewPagination,
  propFields?: readonly string[],
  columnLabels?: ColumnLabelMap,
): ViewDataShape {
  if (groups.length === 0) {
    return { kind: 'empty', reason: 'no_groups' };
  }
  const headerRows = groups.map((g) => g.aggregates);
  const metrics = metricsFromAnalysisRows(dimensionKeys, headerRows, columnLabels);
  const dimSet = new Set(dimensionKeys);
  const columns: ColumnDef[] = inferColumns(headerRows).map((col) => ({
    key: col.key,
    label: columnLabels?.[col.key],
    readOnly: dimSet.has(col.key),
    isMetric: !dimSet.has(col.key),
  }));

  const viewGroups: ViewGroupBucket[] = groups.map((g, index) => {
    const members = wireEntitiesToTreeNodes(g.members, { keyPrefix: `group-${index}` });
    const memberColumns = applyColumnLabels(
      applyPropFieldColumns(inferTreeColumns(members.length > 0 ? members : []), propFields),
      columnLabels,
    );
    return {
      key: `group-${index}`,
      headerRow: g.aggregates,
      members,
      memberColumns,
    };
  });

  return {
    kind: 'grouped',
    dimensionKeys: [...dimensionKeys],
    metrics,
    columns,
    groups: viewGroups,
    pagination,
  };
}

export interface AdaptQueryResultOptions {
  /** Start model from the query plan — used for row identity on tabular results. */
  readonly sourceModel?: string;
  /**
   * When true, analysis results are treated as leaf grain (drill-down complete).
   * Aggregated pivot cells remain read-only unless this is set.
   */
  readonly pivotLeafGrain?: boolean;
  /** Schema prop names from catalog — only these columns are shown in tabular views. */
  readonly propFields?: readonly string[];
  /** Optional display labels keyed by field/column name. */
  readonly columnLabels?: ColumnLabelMap;
  /**
   * When false, multi-dim analysis stays as flat pivot (drill-down UX).
   * Default true: prefer nested tree when the wire payload includes `tree`.
   */
  readonly preferAnalysisTree?: boolean;
}

function isWireExecuteResultJson(x: unknown): x is WireExecuteResultJson {
  if (typeof x !== 'object' || x === null || !('kind' in x)) {
    return false;
  }
  const kind = (x as { kind: unknown }).kind;
  return (
    kind === 'rows' ||
    kind === 'analysis' ||
    kind === 'groups' ||
    kind === 'paginated' ||
    kind === 'mutation' ||
    kind === 'previewBind' ||
    kind === 'relationStats'
  );
}

/**
 * Converts wire {@link WireExecuteResultJson} into a {@link ViewDataShape} for UI components.
 */
export function adaptQueryResult(
  result: WireExecuteResultJson,
  options: AdaptQueryResultOptions = {},
): ViewDataShape {
  switch (result.kind) {
    case 'paginated': {
      const pagination: ViewPagination = {
        page: result.page,
        limit: result.limit,
        total: result.total,
        pageCount: result.pageCount,
      };
      const inner = adaptQueryResult(result.items, options);
      if (
        inner.kind === 'tabular' ||
        inner.kind === 'pivot' ||
        inner.kind === 'tree' ||
        inner.kind === 'grouped'
      ) {
        return { ...inner, pagination };
      }
      return inner;
    }
    case 'rows': {
      return adaptRowsResult(
        result.rows,
        undefined,
        options.propFields,
        options.sourceModel,
        options.columnLabels,
      );
    }
    case 'analysis': {
      const preferTree = options.preferAnalysisTree !== false;
      const tree = preferTree ? result.tree : undefined;
      return adaptAnalysisResult(
        result.dimensionKeys,
        result.rows,
        tree,
        undefined,
        options.pivotLeafGrain ?? false,
        options.columnLabels,
      );
    }
    case 'groups':
      return adaptGroupsResult(
        result.dimensionKeys,
        result.groups,
        undefined,
        options.propFields,
        options.columnLabels,
      );
    case 'mutation':
      return { kind: 'empty', reason: 'mutation_result_not_viewable' };
    case 'previewBind':
      return { kind: 'empty', reason: 'preview_bind_not_viewable' };
    case 'relationStats':
      return { kind: 'empty', reason: 'relation_stats_not_viewable' };
    default: {
      const _exhaustive: never = result;
      return _exhaustive;
    }
  }
}

/** Reads the origin model from a query plan. */
export function startModelFromSnapshot(plan: {
  readonly originModel?: string;
}): string | undefined {
  const model = plan.originModel;
  return typeof model === 'string' && model.length > 0 ? model : undefined;
}

/** Narrow unknown execute results before adaptation. */
export function adaptUnknownQueryResult(
  result: unknown,
  options: AdaptQueryResultOptions = {},
): ViewDataShape {
  if (!isWireExecuteResultJson(result)) {
    return { kind: 'empty', reason: 'invalid_query_result' };
  }
  return adaptQueryResult(result, options);
}

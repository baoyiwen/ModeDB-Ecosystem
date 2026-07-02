/** Column metadata for tabular / pivot leaf rendering. */
export interface ColumnDef {
  readonly key: string;
  readonly label?: string;
  readonly dataType?: string;
  readonly readOnly?: boolean;
  /** When false the column is an aggregate metric (pivot) and never editable. */
  readonly isMetric?: boolean;
  /** Source model for row identity resolution during edit staging. */
  readonly sourceModel?: string;
}

/** Metric descriptor for pivot / analysis views. */
export interface MetricDef {
  readonly key: string;
  readonly label?: string;
  readonly aggregateOp?: string;
}

/** Pagination envelope attached to tabular views. */
export interface ViewPagination {
  readonly page: number;
  readonly limit: number;
  readonly total: number;
  readonly pageCount: number;
}

/** Row identity for leaf-level edits (required before staging `update`). */
export interface EntityRowRef {
  readonly model: string;
  readonly id: string;
}

/** One node in a hierarchical query result (entity tree, pivot tree, or nested relates). */
export interface ViewTreeNode {
  readonly key: string;
  readonly depth: number;
  readonly label: string;
  readonly values: Record<string, unknown>;
  readonly rowRef?: EntityRowRef | null;
  readonly sourceModel?: string;
  readonly relationKey?: string;
  readonly children: readonly ViewTreeNode[];
}

/** One grouped bucket with aggregate header and expandable member rows. */
export interface ViewGroupBucket {
  readonly key: string;
  readonly headerRow: Record<string, unknown>;
  readonly members: readonly ViewTreeNode[];
  readonly memberColumns: readonly ColumnDef[];
}

/** Normalized read model consumed by `@mode-db/data-ui` components. */
export type ViewDataShape =
  | {
      readonly kind: 'tabular';
      readonly columns: readonly ColumnDef[];
      readonly rows: readonly Record<string, unknown>[];
      readonly rowRefs?: readonly (EntityRowRef | null)[];
      readonly pagination?: ViewPagination;
      readonly sourceModel?: string;
    }
  | {
      readonly kind: 'pivot';
      readonly dimensions: readonly string[];
      readonly metrics: readonly MetricDef[];
      readonly columns: readonly ColumnDef[];
      /** Flat analysis rows (`shape: flat` from engine). */
      readonly rows: readonly Record<string, unknown>[];
      /** True when drill-down reached entity grain (leaf editing allowed). */
      readonly isLeafGrain: boolean;
      readonly pagination?: ViewPagination;
    }
  | {
      readonly kind: 'tree';
      readonly columns: readonly ColumnDef[];
      readonly roots: readonly ViewTreeNode[];
      /** `entity` for relate/recursive trees; `analysis` for pivot/group nested trees. */
      readonly treeKind: 'entity' | 'analysis';
      readonly sourceModel?: string;
      readonly pagination?: ViewPagination;
    }
  | {
      readonly kind: 'grouped';
      readonly dimensionKeys: readonly string[];
      readonly metrics: readonly MetricDef[];
      readonly columns: readonly ColumnDef[];
      readonly groups: readonly ViewGroupBucket[];
      readonly pagination?: ViewPagination;
    }
  | {
      readonly kind: 'empty';
      readonly reason?: string;
    };

/** Whether pivot cells may enter edit staging (leaf grain only). */
export function isPivotLeafEditable(shape: ViewDataShape): boolean {
  return shape.kind === 'pivot' && shape.isLeafGrain;
}

/** Whether any cell in the view may be edited in the current shape + mode. */
export function isViewEditable(shape: ViewDataShape, mode: 'edit' | 'delete'): boolean {
  if (shape.kind === 'empty') {
    return false;
  }
  if (mode === 'delete') {
    return shape.kind === 'tabular' && shape.rowRefs !== undefined;
  }
  if (shape.kind === 'tabular') {
    return true;
  }
  return isPivotLeafEditable(shape);
}

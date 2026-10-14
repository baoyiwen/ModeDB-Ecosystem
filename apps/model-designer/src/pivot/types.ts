/**
 * The two v1 sources that can feed Pivot Tab. Both are normalized into a
 * {@link PivotDocument} before a view renders them.
 */
export type PivotSource =
  | {
      readonly kind: 'model';
      readonly modelId: string;
      readonly modelName: string;
    }
  | {
      readonly kind: 'interface';
      readonly interfaceId?: string;
      readonly callableName: string;
      readonly version: string;
    };

export type PivotPaginationMode = 'none' | 'offset' | 'cursor';

export interface PivotPageInfo {
  readonly mode: PivotPaginationMode;
  readonly page?: number;
  readonly total?: number;
  readonly pageCount?: number;
  readonly nextCursor?: string;
}

export interface PivotPathSegment {
  readonly key: string;
  readonly kind: 'field' | 'index';
  readonly index?: number;
}

export type PivotNodeKind = 'record' | 'object' | 'array' | 'value';

/** A normalized value in the hierarchy. `value` always remains the raw value. */
export interface PivotNode {
  readonly id: string;
  readonly key: string;
  readonly kind: PivotNodeKind;
  readonly path: readonly PivotPathSegment[];
  readonly value: unknown;
  readonly children: readonly PivotNode[];
}

export interface PivotRow {
  readonly index: number;
  readonly id: string;
  readonly raw: Readonly<Record<string, unknown>>;
  readonly root: PivotNode;
}

export interface PivotDocument {
  readonly source: PivotSource;
  readonly rows: readonly PivotRow[];
  /** The exact row payload supplied by the source adapter. */
  readonly rawRows: readonly Readonly<Record<string, unknown>>[];
  readonly page: PivotPageInfo;
  readonly createdAt: string;
}

export interface PivotResultInput {
  readonly source: PivotSource;
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly page?: Partial<PivotPageInfo>;
  readonly createdAt?: string;
}

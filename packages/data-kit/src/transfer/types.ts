/** Versioned, reversible data exchange. Derived reports are deliberately not importable. */
export const TRANSFER_FORMAT = 'modedb.transfer.v1' as const;
export const TRANSFER_MAX_ROWS = 10_000;
export const TRANSFER_MAX_EDGES = 50_000;
export const TRANSFER_MAX_BYTES = 20 * 1024 * 1024;

export interface TransferField {
  readonly name: string;
  readonly label: string;
  readonly type: string;
  readonly required?: boolean;
}

export interface TransferModel {
  readonly name: string;
  readonly label: string;
  readonly sheet: string;
  readonly fields: readonly TransferField[];
}

export interface TransferRelation {
  readonly source: string;
  readonly target: string;
  readonly forward: string;
  readonly reverse: string;
  readonly selfLoopPolicy?: 'deny' | 'allow';
}

export interface TransferManifest {
  readonly format: typeof TRANSFER_FORMAT;
  readonly kind: 'data' | 'template' | 'report';
  readonly database: string;
  readonly createdAt: string;
  readonly models: readonly TransferModel[];
  readonly relations: readonly TransferRelation[];
  readonly interfaceSource?: {
    readonly callableName: string;
    readonly version: string;
    readonly signature: string;
    readonly scope: 'returned-result';
  };
}

export interface TransferLocation {
  readonly sheet: string;
  readonly row: number;
  readonly column?: string;
}

export interface TransferRow extends TransferLocation {
  readonly model: string;
  /** Stable within one model. Relation references use `row:<key>` or `id:<database ID>`. */
  readonly key: string;
  readonly id?: string;
  readonly values: Readonly<Record<string, unknown>>;
}

export interface TransferEdge extends TransferRelation, TransferLocation {
  readonly sourceRef: string;
  readonly targetRef: string;
}

export interface TransferPackage {
  readonly manifest: TransferManifest;
  readonly rows: readonly TransferRow[];
  readonly edges: readonly TransferEdge[];
  /** Occurrences retain query paths when one database record appears more than once. */
  readonly paths?: readonly {
    readonly path: string;
    readonly parentPath: string;
    readonly nodeId: string;
    readonly model: string;
    readonly key: string;
  }[];
}

export interface TransferIssue extends TransferLocation {
  readonly code: string;
  readonly detail?: string;
}

export interface TransferPreflight {
  readonly checkedAt: string;
  readonly database: string;
  readonly rows: number;
  readonly newRows: number;
  readonly existingRows: number;
  readonly relations: number;
  readonly issues: readonly TransferIssue[];
  readonly valid: boolean;
}

export interface TransferProgress {
  readonly stage: 'query' | 'relations' | 'workbook' | 'parse' | 'validate' | 'complete';
  readonly completed: number;
  readonly total?: number;
}

export class TransferError extends Error {
  constructor(
    readonly code: string,
    readonly location?: TransferLocation,
    readonly detail?: string,
  ) {
    super(code);
    this.name = 'TransferError';
  }
}

export function transferRelationKey(relation: TransferRelation): string {
  return JSON.stringify([relation.source, relation.target, relation.forward, relation.reverse]);
}

export function transferRecordKey(model: string, id: string): string {
  return JSON.stringify([model, id]);
}

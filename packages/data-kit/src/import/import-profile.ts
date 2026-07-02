/** Serializable cleaning transform (applied during ingest normalize phase). */
export type CleaningRule =
  | { readonly kind: 'trim'; readonly columns?: readonly string[] }
  | { readonly kind: 'drop_empty_rows' }
  | { readonly kind: 'coerce_type'; readonly column: string; readonly dataType: string }
  | { readonly kind: 'default_value'; readonly column: string; readonly value: unknown }
  | {
      readonly kind: 'regex_replace';
      readonly column: string;
      readonly pattern: string;
      readonly replacement: string;
    };

/** How row-level failures affect the batch. */
export type ImportStrictness = 'lenient' | 'strict';

/** Rule for binding imported rows to related models via engine `bind` (PROTOCOL). */
export interface RelationBindingRule {
  /** Forward relation label from catalog (`forward`). */
  readonly relation: string;
  /** CSV / ingest column holding the join value on the imported side. */
  readonly sourceColumn: string;
  /** Peer model field to match (business natural key, e.g. `code` or `id`). */
  readonly targetMatchColumn: string;
  /** Related model name from catalog. */
  readonly targetModel: string;
  /**
   * When true (default if `sourceColumn` is not in column mapping), the CSV value is used only
   * to look up existing peer rows and is **not** stored on the import model.
   */
  readonly bindOnly?: boolean;
}

/**
 * Import profile produced by cleaning / mapping — replayed through DataBinding as `applyAll`.
 */
export interface ImportProfile {
  readonly id: string;
  readonly sourceFingerprint: string;
  readonly targetModel: string;
  readonly columnMapping: Readonly<Record<string, string>>;
  readonly relationBindings?: readonly RelationBindingRule[];
  readonly transformRules?: readonly CleaningRule[];
  readonly strict?: ImportStrictness;
  readonly chunkSize?: number;
}

/** Checkpoint for resumable large-file import. */
export interface ImportCheckpoint {
  readonly profileId: string;
  readonly chunkIndex: number;
  readonly rowsCommitted: number;
  readonly updatedAt: string;
}

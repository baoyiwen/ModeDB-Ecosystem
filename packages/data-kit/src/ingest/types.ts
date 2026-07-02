/** Supported external data carriers for cleaning / import pipelines. */
export type IngestFormat = 'csv' | 'excel' | 'json' | 'xml' | 'sql';

/** Locator for a file, URL, or external DB connection (adapter-specific payload). */
export interface IngestSource {
  readonly format: IngestFormat;
  readonly label?: string;
  /** File path, object URL, JDBC-ish config, etc. */
  readonly locator: string;
  readonly options?: Readonly<Record<string, unknown>>;
}

/** Inferred column from a sample read. */
export interface IngestColumnSchema {
  readonly name: string;
  readonly inferredType?: string;
  readonly nullable?: boolean;
  readonly sampleValues?: readonly unknown[];
}

export interface IngestSchema {
  readonly format: IngestFormat;
  readonly columns: readonly IngestColumnSchema[];
  readonly rowCountEstimate?: number;
}

/** One raw row before normalization (adapter output). */
export type IngestRow = Readonly<Record<string, unknown>>;

/**
 * Streaming ingest handle — adapters must not load entire files into memory.
 */
export interface IngestHandle {
  readonly format: IngestFormat;
  sniffSchema(sampleRows?: number): Promise<IngestSchema>;
  readChunk(size: number): Promise<readonly IngestRow[] | null>;
  close(): void;
}

/** Opens a source and returns a streaming handle. */
export interface IngestAdapter {
  readonly format: IngestFormat;
  open(source: IngestSource): Promise<IngestHandle>;
}

/** Ambiguity surfaced to the user only when auto-mapping cannot resolve. */
export interface IngestAmbiguity {
  readonly id: string;
  readonly kind: 'column_mapping' | 'required_field' | 'relation_target' | 'type_coercion';
  readonly message: string;
  readonly candidates?: readonly string[];
  readonly rowIndex?: number;
  readonly column?: string;
}

/** Result of automatic mapping before human review. */
export interface IngestAutoMapResult {
  readonly mappedColumns: Readonly<Record<string, string>>;
  readonly ambiguities: readonly IngestAmbiguity[];
  readonly quarantinedRowCount: number;
}

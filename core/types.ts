/**
 * Schema definition for a registered model.
 * Only the declared property names are persisted — enforcing model purity.
 */
export interface ModelSchema {
  readonly name: string;
  readonly fields: ReadonlySet<string>;
}

/**
 * Engine-level metadata attached to every persisted record.
 * These fields are managed by the storage layer, never by user code.
 */
export interface RecordMeta {
  readonly _id: string;
  readonly _createdAt: string;
}

/**
 * A persisted record = user-supplied data (filtered to schema fields) + engine metadata.
 */
export type ModelRecord<T extends Record<string, unknown> = Record<string, unknown>> = T &
  RecordMeta;

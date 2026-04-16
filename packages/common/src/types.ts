import type { FieldTypeDef } from './data-types.js';

/**
 * Schema definition for a registered model.
 * Only the declared property names are persisted — enforcing model purity.
 * `fieldTypes` carries optional per-field DataType metadata; fields absent
 * from this map are treated as untyped strings with no validation.
 */
export interface ModelSchema {
  readonly name: string;
  fields: ReadonlySet<string>;
  fieldTypes: Map<string, FieldTypeDef>;
}

/**
 * A registered model definition in the registry.
 *
 * `parentId` is locked at creation time and cannot be changed afterwards,
 * enforcing the inheritance-lock rule. `fields` can be updated later via
 * deferred completion (skeleton-first pattern).
 * `fieldTypes` carries optional per-field DataType metadata.
 */
export interface ModelDefinition {
  readonly name: string;
  readonly parentId: string | null;
  fields: ReadonlySet<string>;
  fieldTypes: Map<string, FieldTypeDef>;
}

/**
 * A registered relation between two models.
 *
 * Relations are pure four-tuple protocols — they carry no data, only the
 * directional semantics between a source and target model.
 *
 * `logic` and `matchOn` may be `null` when the relation is first created
 * as a skeleton, to be filled in later via deferred completion.
 *
 * @example
 * {
 *   source: 'User', target: 'Department',
 *   forward: '属于', reverse: '包含',
 *   logic: 'many-to-one',
 *   matchOn: { sourceField: 'deptCode', targetField: 'code' },
 * }
 */
export interface RelationDefinition {
  readonly source: string;
  readonly target: string;
  readonly forward: string;
  readonly reverse: string;
  logic: RelationLogic | null;
  matchOn: MatchPredicate | null;
}

/**
 * Attribute-equality predicate that drives automatic relation linking.
 *
 * When a record is inserted into the source (or target) model, the indexer
 * evaluates `record[sourceField] === otherRecord[targetField]` to decide
 * whether a link should be created.
 */
export interface MatchPredicate {
  readonly sourceField: string;
  readonly targetField: string;
}

/**
 * Cardinality logic for a relation.
 */
export type RelationLogic = 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many';

/**
 * Serialized form of a single relation's bidirectional index.
 * Persisted as JSON in `data/relations/{source}-{target}-{forward}.rid`.
 */
export interface RelationIndexData {
  fwd: Record<string, string[]>;
  rev: Record<string, string[]>;
}

// ---------------------------------------------------------------------------
// Binding strategies
// ---------------------------------------------------------------------------

/**
 * Strategy that controls how relation indices are built.
 *
 * - `GLOBAL`      — Full N:N surjection: every source record links to every target record.
 * - `PROTOCOL`    — Automatic matching using the relation's registered `matchOn` predicate.
 * - `CONDITIONAL` — Like PROTOCOL, but also applies a user-supplied filter function.
 * - `MANUAL`      — Explicit `[srcId, targetId]` pairs supplied by the caller.
 */
export type BindStrategy = 'GLOBAL' | 'PROTOCOL' | 'CONDITIONAL' | 'MANUAL';

/**
 * User-supplied predicate for CONDITIONAL binding.
 * Receives the source and target records; returns `true` to create a link.
 */
export type ConditionFn = (source: ModelRecord, target: ModelRecord) => boolean;

/**
 * Options accepted by `RelationIndexer.bind` and `Engine.bind`.
 */
export interface BindOptions {
  /** Explicit ID pairs for MANUAL strategy. */
  pairs?: ReadonlyArray<readonly [srcId: string, targetId: string]>;
  /** Filter function for CONDITIONAL strategy. */
  condition?: ConditionFn;
}

/**
 * Statistics snapshot for a relation's in-memory index.
 */
export interface RelationStats {
  /** Number of distinct source IDs with at least one forward link. */
  readonly forwardKeys: number;
  /** Number of distinct target IDs with at least one reverse link. */
  readonly reverseKeys: number;
  /** Total number of link pairs (forward direction count). */
  readonly totalLinks: number;
}

/**
 * Options for {@link RelationEntity.bind}.
 * Combines strategy selection with strategy-specific parameters.
 */
export interface RelationBindOptions {
  /** Binding strategy. Defaults to `'PROTOCOL'` if omitted. */
  strategy?: BindStrategy;
  /** Explicit ID pairs for MANUAL strategy. */
  pairs?: ReadonlyArray<readonly [srcId: string, targetId: string]>;
  /** Filter function for CONDITIONAL strategy. */
  condition?: ConditionFn;
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
 * Sentinel field set by {@link ModelEntity.delete} / {@link AuthoringEngine.delete}.
 * Rows carrying this flag are invisible to queries (filtered by {@link MergedDataReader})
 * and physically removed from `.mld` on the next flush cycle.
 */
export const DELETED_SENTINEL = '__deleted' as const;

/**
 * A persisted record = user-supplied data (filtered to schema fields) + engine metadata.
 * Tombstoned rows additionally carry `__deleted: true`.
 */
export type ModelRecord<T extends Record<string, unknown> = Record<string, unknown>> = T &
  RecordMeta & { [DELETED_SENTINEL]?: true };

/** Type guard: returns `true` when the row is a soft-delete tombstone. */
export function isDeletedRecord(r: ModelRecord): boolean {
  return (r as Record<string, unknown>)[DELETED_SENTINEL] === true;
}

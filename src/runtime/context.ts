import type { ModelRegistry, DataReader, IndexReader } from '@mode-db/common';
import type { FieldMatchContext } from './query-filter.js';

/**
 * Read-only runtime context for client delivery (no authoring / write side).
 */
export interface RuntimeContext {
  readonly atlas: string;
  readonly registry: ModelRegistry;
  readonly dataReader: DataReader;
  readonly indexReader: IndexReader;
  /** Optional I18N / DataType context for locale-aware query filtering. */
  readonly fieldContext?: FieldMatchContext;
}

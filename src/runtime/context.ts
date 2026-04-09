import type { ModelRegistry } from '../../common/registry.js';
import type { DataReader, IndexReader } from '../../common/provider.js';

/**
 * Read-only runtime context for client delivery (no authoring / write side).
 */
export interface RuntimeContext {
  readonly atlas: string;
  readonly registry: ModelRegistry;
  readonly dataReader: DataReader;
  readonly indexReader: IndexReader;
}

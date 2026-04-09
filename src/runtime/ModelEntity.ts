import type { ModelRegistry } from '../../common/registry.js';
import type { DataReader, IndexReader } from '../../common/provider.js';
import { RuntimeModel } from './RuntimeModel.js';

/**
 * Third-party client model handle: read-only (no `insert`, `updateFields`, or `bind`).
 * Queries use {@link ModelFileReader} + {@link RelationIndexFileReader} under the hood.
 */
export class ModelEntity extends RuntimeModel {
  constructor(
    name: string,
    registry: ModelRegistry,
    dataReader: DataReader,
    indexReader: IndexReader,
  ) {
    super(name, registry, dataReader, indexReader);
  }
}

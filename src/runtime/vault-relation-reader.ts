import type { RelationDefinition, RelationIndexData } from '../../common/types.js';
import type { IndexReader } from '../../common/provider.js';
import { IndexerError } from '../../common/errors.js';
import { AtlasSingleVault } from '../../authoring/atlas-single-vault.js';

function relationFileKey(rel: RelationDefinition): string {
  return `${rel.source}-${rel.target}-${rel.forward}`;
}

/**
 * Read-only relation access from {@link AtlasSingleVault} (`r:*` keys).
 */
export class VaultRelationIndexReader implements IndexReader {
  private readonly cache = new Map<string, RelationIndexData>();

  constructor(private readonly vault: AtlasSingleVault) {}

  async getForward(rel: RelationDefinition, sourceId: string): Promise<string[]> {
    const data = await this.loadData(rel);
    const arr = data.fwd[sourceId];
    return arr ? [...arr] : [];
  }

  async getReverse(rel: RelationDefinition, targetId: string): Promise<string[]> {
    const data = await this.loadData(rel);
    const arr = data.rev[targetId];
    return arr ? [...arr] : [];
  }

  private async loadData(rel: RelationDefinition): Promise<RelationIndexData> {
    const key = relationFileKey(rel);
    const cached = this.cache.get(key);
    if (cached) {
      return cached;
    }

    const raw = this.vault.get(AtlasSingleVault.relationKey(key));
    let data: RelationIndexData = { fwd: {}, rev: {} };
    if (raw) {
      try {
        data = JSON.parse(raw) as RelationIndexData;
      } catch (err) {
        throw new IndexerError(`Failed to parse relation vault entry "${key}"`, { cause: err });
      }
    }

    this.cache.set(key, data);
    return data;
  }
}

import { DiskAdapter } from '../../common/disk-adapter.js';
import type { RelationDefinition, RelationIndexData } from '../../common/types.js';
import type { IndexReader } from '../../common/provider.js';
import type { PathResolver } from '../common/PathResolver.js';
import { IndexerError } from '../../common/errors.js';

function relationFileKey(rel: RelationDefinition): string {
  return `${rel.source}-${rel.target}-${rel.forward}`;
}

/**
 * Read-only `.rid` JSON access (no bind, no pair writes, no flush).
 */
export class RelationIndexFileReader implements IndexReader {
  private readonly cache = new Map<string, RelationIndexData>();

  constructor(private readonly paths: PathResolver) {}

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

    const filePath = this.paths.relationIndexFilePath(key);
    let data: RelationIndexData = { fwd: {}, rev: {} };

    try {
      const raw = await DiskAdapter.read(filePath, 'utf-8');
      data = JSON.parse(raw) as RelationIndexData;
    } catch (err) {
      if (!isNodeError(err) || err.code !== 'ENOENT') {
        throw new IndexerError(`Failed to read relation index "${key}"`, { cause: err });
      }
    }

    this.cache.set(key, data);
    return data;
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

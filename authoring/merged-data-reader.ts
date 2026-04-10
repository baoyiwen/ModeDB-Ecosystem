import type { ModelRecord } from '../common/types.js';
import type { DataReader } from '../common/provider.js';
import type { ModelStorage } from './storage.js';

/**
 * Exposes unflushed authoring rows for {@link MergedDataReader}.
 */
export interface BufferedModelSource {
  getPendingSnapshot(modelName: string): readonly ModelRecord[];
}

function mergeRecordLists(
  disk: readonly ModelRecord[],
  pending: readonly ModelRecord[],
): ModelRecord[] {
  const byId = new Map<string, ModelRecord>();
  const order: string[] = [];
  for (const r of disk) {
    byId.set(r._id, r);
    order.push(r._id);
  }
  for (const r of pending) {
    if (!byId.has(r._id)) {
      order.push(r._id);
    }
    byId.set(r._id, r);
  }
  return order.map((id) => byId.get(id)!);
}

/**
 * Merges on-disk `.mld` rows with the authoring persistence buffer so {@link QueryChain.execute}
 * sees inserts before background flush (read-your-writes).
 */
export class MergedDataReader implements DataReader {
  constructor(
    private readonly disk: ModelStorage,
    private readonly bufferSource: BufferedModelSource,
  ) {}

  async getAll(modelName: string): Promise<ModelRecord[]> {
    const [fromDisk, pending] = await Promise.all([
      this.disk.getAll(modelName),
      Promise.resolve([...this.bufferSource.getPendingSnapshot(modelName)]),
    ]);
    return mergeRecordLists(fromDisk, pending);
  }

  async getByIds(modelName: string, ids: string[]): Promise<ModelRecord[]> {
    if (ids.length === 0) {
      return [];
    }
    const fromDisk = await this.disk.getByIds(modelName, ids);
    const byId = new Map(fromDisk.map((r) => [r._id, r] as const));
    for (const r of this.bufferSource.getPendingSnapshot(modelName)) {
      if (ids.includes(r._id)) {
        byId.set(r._id, r);
      }
    }
    return ids.map((id) => byId.get(id)).filter((x): x is ModelRecord => x !== undefined);
  }

  async scanModelRecords(
    modelName: string,
    visitor: (record: ModelRecord) => void | Promise<void>,
  ): Promise<void> {
    const merged = await this.getAll(modelName);
    for (const r of merged) {
      await visitor(r);
    }
  }

  async findFirstByFieldEq(
    modelName: string,
    field: string,
    value: unknown,
  ): Promise<ModelRecord | undefined> {
    let hit: ModelRecord | undefined;
    await this.disk.scanModelRecords(modelName, (rec) => {
      if (hit) {
        return;
      }
      if ((rec as Record<string, unknown>)[field] === value) {
        hit = rec;
      }
    });
    if (hit) {
      return hit;
    }
    for (const r of this.bufferSource.getPendingSnapshot(modelName)) {
      if ((r as Record<string, unknown>)[field] === value) {
        return r;
      }
    }
    return undefined;
  }
}

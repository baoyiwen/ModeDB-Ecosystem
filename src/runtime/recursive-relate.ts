import type { IndexReader, ModelRecord } from '@mode-db/common';
import type { ResolvedRelation } from './relation-resolve.js';

/**
 * 自关联 / 管网式 BFS：每层只累计 **ID 集合**，用全局 **seen** 防止环；不包含再次访问已见节点。
 *
 * @param maxDepth - 最多前进的**关系跳数**（边数）；`1` 等价于一步 `relate` 的可达目标集合（不含仅重复指向已见节点的边）。
 * @returns 从所有种子出发、在 `maxDepth` 跳内可达的 **全部** `_id`（**含**种子自身），已去重。
 */
export async function collectRecursiveRelationIdsBFS(
  indexReader: IndexReader,
  resolved: ResolvedRelation,
  seedRecords: readonly ModelRecord[],
  maxDepth: number,
): Promise<readonly string[]> {
  if (maxDepth < 1) {
    return [...new Set(seedRecords.map((r) => r._id))];
  }

  const linkedIds = async (id: string): Promise<string[]> => {
    return resolved.direction === 'forward'
      ? indexReader.getForward(resolved.definition, id)
      : indexReader.getReverse(resolved.definition, id);
  };

  const globalSeen = new Set<string>(seedRecords.map((r) => r._id));
  let frontier = [...globalSeen];

  for (let depth = 0; depth < maxDepth; depth++) {
    const nextFrontier: string[] = [];
    for (const id of frontier) {
      const linked = await linkedIds(id);
      for (const lid of linked) {
        if (!globalSeen.has(lid)) {
          globalSeen.add(lid);
          nextFrontier.push(lid);
        }
      }
    }
    if (nextFrontier.length === 0) {
      break;
    }
    frontier = nextFrontier;
  }

  return [...globalSeen];
}

/**
 * 自 `startId` 出发的 BFS（不含 `startId` 在返回集合中可选）— 用于 **includeRelates** 下列出「后代」边目标。
 *
 * @returns 可达的 **非根** `_id`（根在 `seen` 中阻止回边，不进入结果集）。
 */
export async function collectDescendantIdsFromSeed(
  indexReader: IndexReader,
  resolved: ResolvedRelation,
  startId: string,
  maxDepth: number,
): Promise<ReadonlySet<string>> {
  const linkedIds = async (id: string): Promise<string[]> => {
    return resolved.direction === 'forward'
      ? indexReader.getForward(resolved.definition, id)
      : indexReader.getReverse(resolved.definition, id);
  };

  const globalSeen = new Set<string>([startId]);
  let frontier = [startId];
  const collected = new Set<string>();

  for (let depth = 0; depth < maxDepth; depth++) {
    const nextFrontier: string[] = [];
    for (const id of frontier) {
      const linked = await linkedIds(id);
      for (const lid of linked) {
        if (!globalSeen.has(lid)) {
          globalSeen.add(lid);
          nextFrontier.push(lid);
          collected.add(lid);
        }
      }
    }
    if (nextFrontier.length === 0) {
      break;
    }
    frontier = nextFrontier;
  }

  return collected;
}

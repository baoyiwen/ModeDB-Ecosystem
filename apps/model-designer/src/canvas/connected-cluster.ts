import type { EngineRelationEdge } from '../types/engine-schema.js';

/** 无向连通分量：与 `rootId` 经关系边相连的所有模型 id（不含锁定节点可选跳过）。 */
export function collectConnectedModelIds(
  rootId: string,
  relations: readonly EngineRelationEdge[],
  isLocked?: (id: string) => boolean,
): string[] {
  const adj = new Map<string, Set<string>>();
  const addEdge = (a: string, b: string): void => {
    if (!adj.has(a)) {
      adj.set(a, new Set());
    }
    adj.get(a)!.add(b);
  };
  for (const r of relations) {
    addEdge(r.source_model_id, r.target_model_id);
    addEdge(r.target_model_id, r.source_model_id);
  }
  const out = new Set<string>();
  const q = [rootId];
  out.add(rootId);
  while (q.length > 0) {
    const id = q.shift()!;
    for (const nb of adj.get(id) ?? []) {
      if (out.has(nb)) {
        continue;
      }
      if (isLocked?.(nb)) {
        continue;
      }
      out.add(nb);
      q.push(nb);
    }
  }
  return [...out];
}

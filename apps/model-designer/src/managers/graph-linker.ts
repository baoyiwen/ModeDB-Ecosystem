import type { DataManager } from './data-manager.js';

/** 与 `ensureDesignerCatalog`（`designer-storage-init.ts`）中 Node↔Node 关系 `nodeLinksOut` / `nodeLinksIn` 对齐。 */
export const GRAPH_NODE_LINK_KIND = 'nodeLinksOut' as const;

/**
 * Canvas 拖拽连线：在引擎/快照层创建一条有向 Node 链接（画布侧为 {@link EngineRelationEdge}）。
 */
export class GraphLinker {
  constructor(private readonly data: DataManager) {}

  linkNodes(sourceModelId: string, targetModelId: string): void {
    if (sourceModelId === targetModelId) {
      return;
    }
    this.data.addRelation({
      id: crypto.randomUUID(),
      source_model_id: sourceModelId,
      target_model_id: targetModelId,
      kind: GRAPH_NODE_LINK_KIND,
    });
  }
}

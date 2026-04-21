import type { DataManager } from './data-manager.js';
import { GRAPH_NODE_LINK_KIND } from '../config/graph-edge-kinds.js';

export { GRAPH_NODE_LINK_KIND } from '../config/graph-edge-kinds.js';

/**
 * Canvas 拖拽连线：在引擎/快照层创建一条有向 Node 链接（画布侧为 {@link EngineRelationEdge}）。
 */
export class GraphLinker {
  constructor(private readonly data: DataManager) {}

  linkNodes(sourceModelId: string, targetModelId: string): string | undefined {
    if (sourceModelId === targetModelId) {
      return undefined;
    }
    const id = crypto.randomUUID();
    this.data.addRelation({
      id,
      source_model_id: sourceModelId,
      target_model_id: targetModelId,
      kind: GRAPH_NODE_LINK_KIND,
    });
    return id;
  }
}

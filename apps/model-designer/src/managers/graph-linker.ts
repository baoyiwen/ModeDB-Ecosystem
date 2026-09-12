import type { DataManager } from './data-manager.js';
import { GRAPH_NODE_LINK_KIND } from '../config/graph-edge-kinds.js';
import {
  RELATION_CARDINALITY_MANY,
  RELATION_CARDINALITY_ONE,
} from '../config/relation-cardinality.js';
import { makeUniqueName, sanitizeUniqueNameFragment } from '../utils/name-validation.js';
import { relationNamesUsedInScope } from '../utils/relation-identity.js';
import { createUuid } from '../utils/random-id.js';

export { GRAPH_NODE_LINK_KIND } from '../config/graph-edge-kinds.js';

/**
 * Canvas 拖拽连线：在引擎/快照层创建一条有向 Node 链接（画布侧为 {@link EngineRelationEdge}）。
 *
 * 关系**永远成对**：每条 `EngineRelationEdge` 同时持有 `forward_name` 与 `reverse_name`。
 * 默认命名（与产品约定 d/e 对齐）：
 * - **自关联**（source === target）：`children` / `parent`。
 * - **非自关联**：`<source.model_name>-<target.model_name>` / `<target.model_name>-<source.model_name>`。
 *
 * 若候选名已被其他关系占用（无论 forward 还是 reverse 位），追加 `-<base36 时间戳>` 直至唯一。
 */
export class GraphLinker {
  constructor(private readonly data: DataManager) {}

  linkNodes(sourceModelId: string, targetModelId: string): string | undefined {
    const isSelf = sourceModelId === targetModelId;
    let forwardBase: string;
    let reverseBase: string;
    if (isSelf) {
      forwardBase = 'children';
      reverseBase = 'parent';
    } else {
      const src = this.data.models.find((m) => m.id === sourceModelId);
      const tgt = this.data.models.find((m) => m.id === targetModelId);
      if (!src || !tgt) {
        return undefined;
      }
      // `model_name` 已受 UNIQUE_NAME_RE 约束；这里再 sanitize 一次防御异常历史数据。
      const s = sanitizeUniqueNameFragment(src.model_name) || 'source';
      const t = sanitizeUniqueNameFragment(tgt.model_name) || 'target';
      forwardBase = `${s}-${t}`;
      reverseBase = `${t}-${s}`;
    }
    // 已占用的名字集合（在所有现有关系的 forward / reverse 两侧合并去重）。
    const used = relationNamesUsedInScope(this.data.relations, sourceModelId, targetModelId);
    const forwardName = makeUniqueName(forwardBase, used);
    used.add(forwardName);
    const reverseName = makeUniqueName(reverseBase, used);

    const id = createUuid();
    this.data.addRelation({
      id,
      source_model_id: sourceModelId,
      target_model_id: targetModelId,
      forward_name: forwardName,
      reverse_name: reverseName,
      engine_forward_name: forwardName,
      engine_reverse_name: reverseName,
      kind: GRAPH_NODE_LINK_KIND,
      self_cardinality: RELATION_CARDINALITY_MANY,
      source_cardinality: RELATION_CARDINALITY_ONE,
      target_cardinality: RELATION_CARDINALITY_MANY,
    });
    return id;
  }
}

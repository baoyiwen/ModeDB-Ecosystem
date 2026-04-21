import type { EngineModelNode, EngineRelationEdge } from '../types/engine-schema.js';
import type { MldgDocument } from '../types/mldg-document.js';

/**
 * 引擎侧可识别的「模型 + 关系」纯结构（不含画布布局）。
 * 在序列化为 Uint8Array 或推送到 ModelDBServer 前，DataManager 应通过此形状对齐逻辑域。
 */
export interface EngineModelRelationPayload {
  readonly models: readonly EngineModelNode[];
  readonly relations: readonly EngineRelationEdge[];
}

/**
 * 从完整 MLDG 文档提取结构域；发送给引擎前用于校验与日志。
 */
export function extractEngineModelRelationPayload(doc: MldgDocument): EngineModelRelationPayload {
  return {
    models: doc.engine_schema.models.map((m) => ({ ...m })),
    relations: doc.engine_schema.relations.map((r) => ({ ...r })),
  };
}

/**
 * 从 DataManager 内存视图构建同一结构（与 {@link extractEngineModelRelationPayload} 一致）。
 */
export function buildEngineModelRelationPayload(
  models: readonly EngineModelNode[],
  relations: readonly EngineRelationEdge[],
): EngineModelRelationPayload {
  return {
    models: models.map((m) => ({ ...m })),
    relations: relations.map((r) => ({ ...r })),
  };
}

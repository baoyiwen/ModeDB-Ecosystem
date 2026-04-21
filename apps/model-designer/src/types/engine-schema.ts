import type { PropObject } from './prop-object.js';

/** 逻辑域：引擎可导入还原的结构图谱 */
export interface EngineModelNode {
  id: string;
  model_name: string;
  parent_id: string | null;
  props_objects_array: PropObject[];
}

export interface EngineRelationEdge {
  id: string;
  source_model_id: string;
  target_model_id: string;
  kind: string;
  metadata?: Record<string, unknown>;
}

export interface EngineSchema {
  models: EngineModelNode[];
  relations: EngineRelationEdge[];
}

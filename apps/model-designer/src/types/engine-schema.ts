import type { PropObject } from './prop-object.js';

/** 逻辑域：引擎可导入还原的结构图谱（`sys_model` / 画布边） */
export interface EngineModelNode {
  id: string;
  model_name: string;
  parent_id: string | null;
  props_objects_array: PropObject[];
  /** `sys_model.name`（I18N）；未设时仅用 `model_name` 作默认文案 */
  name_i18n?: Record<string, string>;
  /** `sys_model.description`（I18N） */
  description_i18n?: Record<string, string>;
  /** `sys_model.color`（hex，如 `#2563eb`） */
  color_value?: string;
}

/** 画布连线；`kind` 为实例语义；其余对齐 `sys_relation` 关系定义行 */
export interface EngineRelationEdge {
  id: string;
  source_model_id: string;
  target_model_id: string;
  kind: string;
  metadata?: Record<string, unknown>;
  /** `sys_relation.name`（I18N） */
  name_i18n?: Record<string, string>;
  /** `sys_relation.description`（I18N） */
  description_i18n?: Record<string, string>;
  /** `sys_relation.selfCardinality`（与 `kind` 可并存：kind=画布语义，此项为基数侧） */
  self_cardinality?: string;
  /** `sys_relation.posX` / `posY`（标签锚点等） */
  pos_x?: number;
  pos_y?: number;
  /** `sys_relation.canvas_meta`（JSON 字符串） */
  canvas_meta_str?: string;
}

export interface EngineSchema {
  models: EngineModelNode[];
  relations: EngineRelationEdge[];
}

import type { PropObject } from './prop-object.js';

/** 逻辑域：引擎可导入还原的结构图谱（`sys_model` / 画布边） */
export interface EngineModelNode {
  id: string;
  /** 注册到引擎的唯一标识（如 `model_173…`），与展示用 `name_i18n` 独立 */
  model_name: string;
  parent_id: string | null;
  props_objects_array: PropObject[];
  /** `sys_model.name`（I18N）；画布标题按当前界面语言从此解析 */
  name_i18n?: Record<string, string>;
  /** `sys_model.description`（I18N） */
  description_i18n?: Record<string, string>;
  /** `sys_model.color`（hex，如 `#2563eb`） */
  color_value?: string;
}

/**
 * 画布连线 / 关系边。关系**永远是成对**的：`forward_name`（source → target）和
 * `reverse_name`（target → source）。两者均为唯一名（参见 `utils/name-validation.ts` 的正则），
 * 在画布上各画一条带箭头的线表示对应方向。展示名走 `*_name_i18n`，缺省回落到唯一名。
 */
export interface EngineRelationEdge {
  id: string;
  source_model_id: string;
  target_model_id: string;
  /**
   * 正向（source → target）唯一名；自关联默认 `children`，非自关联默认 `<source>-<target>`。
   * **新建关系一定写入**；标记 optional 仅为兼容旧 mldg 序列化（缺省时回退到 `kind`）。
   */
  forward_name?: string;
  /**
   * 逆向（target → source）唯一名；自关联默认 `parent`，非自关联默认 `<target>-<source>`。
   * **新建关系一定写入**；标记 optional 仅为兼容旧 mldg 序列化（缺省时回退到 `kind`）。
   */
  reverse_name?: string;
  /** 正向展示名（I18N），优先于 `forward_name` 显示。 */
  forward_name_i18n?: Record<string, string>;
  /** 逆向展示名（I18N），优先于 `reverse_name` 显示。 */
  reverse_name_i18n?: Record<string, string>;
  /**
   * 画布语义分类（连线 / 继承等）。继承边由 `createChildModel` 写为 `GRAPH_INHERIT_KIND`，
   * 普通连线为 `GRAPH_NODE_LINK_KIND`。运行时仍用于决定虚实线 / 颜色。
   */
  kind: string;
  metadata?: Record<string, unknown>;
  /** @deprecated 旧版本的"关系整体名"。新代码请用 `forward_name_i18n` / `reverse_name_i18n`。 */
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

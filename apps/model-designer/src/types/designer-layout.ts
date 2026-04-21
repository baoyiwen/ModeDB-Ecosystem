import type { LayerTreeNode } from './layer-tree.js';

/** 与引擎 `sys_layers` 对齐的画图层（画布侧缓存）。 */
export interface DesignerLayerRow {
  id: string;
  label: string;
  order: number;
  isVisible: boolean;
}

/** 表现域：画布坐标、主题、层级；可选连线折点与视口 */
export interface DesignerModelLayout {
  uuid: string;
  position: { x: number; y: number };
  color_theme: string;
  z_index: number;
  edge_bend_hints?: Array<{ edge_id: string; points: Array<{ x: number; y: number }> }>;
}

export interface DesignerViewport {
  zoom: number;
  pan_x: number;
  pan_y: number;
}

export interface DesignerLayout {
  models: DesignerModelLayout[];
  viewport?: DesignerViewport;
  /** 图层列表；未写入则由 DataManager 按需默认一层。 */
  layers?: DesignerLayerRow[];
  /** 模型节点 id → 所属 layer id 列表（多对多，与 `layerHasNodes` 语义一致）。 */
  model_layers?: Record<string, string[]>;
  /** 分组 / 页 层级树（与 flat `layers` 同步维护）。 */
  layer_tree?: LayerTreeNode[];
}

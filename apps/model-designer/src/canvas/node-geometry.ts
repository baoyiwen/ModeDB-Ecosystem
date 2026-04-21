import type { EngineModelNode } from '../types/engine-schema.js';

/** 节点为圆形时的半径（像素）；位置为外接正方形左上角。 */
export const NODE_RADIUS = 56;

/** 外接正方形边长 = 直径，用于布局与命中测试。 */
export const NODE_DIAMETER = NODE_RADIUS * 2;

export function computeNodeHeight(_model: EngineModelNode): number {
  return NODE_DIAMETER;
}

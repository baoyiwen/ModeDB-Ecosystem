import type { DesignerToolMode } from '../managers/mode-manager.js';
import type { InteractionState } from '../managers/state-manager.js';

/** 工具模式 → 空闲态 FSM（与左侧工具栏一一对应；`LINKING` 为拖线中的临时态）。 */
export function interactionStateForToolMode(mode: DesignerToolMode): InteractionState {
  switch (mode) {
    case 'select':
      return 'SELECT';
    case 'add':
      return 'ADD_NODE';
    case 'delete':
      return 'DELETING';
    case 'link':
      return 'LINK';
    case 'inherit':
      return 'INHERITING';
    case 'page':
    case 'query-select':
    case 'query-create':
    case 'query-inspect':
    case 'query-preview':
      return 'SELECT';
  }
}

/** 非拖线中的画布空闲交互态（可平移、悬停高亮等）。 */
export function isIdleCanvasInteractionState(st: InteractionState): boolean {
  return st !== 'LINKING';
}

/** 连线工具下可发起连线的空闲态。 */
export function canStartLinkGesture(st: InteractionState): boolean {
  return st === 'SELECT' || st === 'ADD_NODE' || st === 'LINK';
}

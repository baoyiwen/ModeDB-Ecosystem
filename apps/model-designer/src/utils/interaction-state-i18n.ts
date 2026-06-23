import type { I18nManager } from '../managers/i18n-manager.js';
import type { InteractionState } from '../managers/state-manager.js';

const STATE_KEYS: Record<InteractionState, string> = {
  SELECT: 'state_SELECT',
  ADD_NODE: 'state_ADD_NODE',
  DELETING: 'state_DELETING',
  LINK: 'state_LINK',
  LINKING: 'state_LINKING',
  INHERITING: 'state_INHERITING',
};

/** 交互 FSM 状态 → i18n 展示文案。 */
export function formatInteractionState(i18n: I18nManager, state: InteractionState): string {
  const key = STATE_KEYS[state];
  const label = i18n.t('ui', key);
  return label === key ? state : label;
}

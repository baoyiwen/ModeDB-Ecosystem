export type InteractionState = 'SELECT' | 'ADD_NODE' | 'LINKING' | 'INHERITING';

export type StateListener = (state: InteractionState) => void;

/**
 * 中心化 FSM：所有交互态切换经由此类，禁止在组件内写死分支。
 */
export class StateManager {
  private _state: InteractionState = 'SELECT';
  private readonly _listeners = new Set<StateListener>();

  get state(): InteractionState {
    return this._state;
  }

  transition(next: InteractionState): void {
    if (this._state === next) {
      return;
    }
    this._state = next;
    for (const fn of this._listeners) {
      fn(this._state);
    }
  }

  subscribe(fn: StateListener): () => void {
    this._listeners.add(fn);
    return () => {
      this._listeners.delete(fn);
    };
  }
}

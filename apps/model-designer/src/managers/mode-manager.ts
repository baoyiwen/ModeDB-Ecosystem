/**
 * 工具模式：决定**下一步**操作语义（非即时动作）。
 * 例如 `add` 时空白处点击新建模型；`delete` 时点击已有模型即删除。
 */
export type ModelDesignerToolMode = 'select' | 'add' | 'delete' | 'link' | 'inherit' | 'page';

export type QueryDesignerToolMode =
  | 'query-select'
  | 'query-create'
  | 'query-rewire'
  | 'query-inspect'
  | 'query-preview';

export type DesignerToolMode = ModelDesignerToolMode | QueryDesignerToolMode;

export function isQueryDesignerMode(mode: DesignerToolMode): mode is QueryDesignerToolMode {
  return mode.startsWith('query-');
}

/**
 * 侧栏表单（Info / Props / Relation）是否只读。
 * 选择模式下仍允许编辑已选实体的元数据。
 */
export function isSidePanelReadOnly(_mode: DesignerToolMode): boolean {
  return false;
}

/**
 * 画布是否禁止**结构变更**（空白处新建、删除实体、连线等）。
 * 选择模式下可拖拽、编辑侧栏，但不触发增删。
 */
export function isCanvasStructureLocked(mode: DesignerToolMode): boolean {
  return mode === 'select' || mode === 'page' || isQueryDesignerMode(mode);
}

/** @deprecated 使用 {@link isSidePanelReadOnly} / {@link isCanvasStructureLocked} */
export function isReadOnlyToolMode(mode: DesignerToolMode): boolean {
  return isSidePanelReadOnly(mode);
}

export type ModeManagerListener = () => void;

export class ModeManager {
  private _mode: DesignerToolMode = 'select';
  private readonly _listeners = new Set<ModeManagerListener>();

  get mode(): DesignerToolMode {
    return this._mode;
  }

  setMode(next: DesignerToolMode): void {
    if (this._mode === next) {
      return;
    }
    this._mode = next;
    for (const fn of this._listeners) {
      fn();
    }
  }

  subscribe(fn: ModeManagerListener): () => void {
    this._listeners.add(fn);
    return () => {
      this._listeners.delete(fn);
    };
  }
}

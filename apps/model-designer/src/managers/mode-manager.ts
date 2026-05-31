/**
 * 工具模式：决定**下一步**操作语义（非即时动作）。
 * 例如 `add` 时空白处点击新建模型；`delete` 时点击已有模型即删除。
 */
export type DesignerToolMode = 'select' | 'add' | 'delete' | 'link' | 'inherit';

/** 选择模式：仅查看与选中，禁止增删改（画布与侧栏表单均为只读）。 */
export function isReadOnlyToolMode(mode: DesignerToolMode): boolean {
  return mode === 'select';
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

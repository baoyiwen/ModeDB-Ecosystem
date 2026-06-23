export type AsyncOperationKey =
  | 'save'
  | 'pull'
  | 'loadCanvas'
  | 'clearAllData'
  | 'clearModelData'
  | 'openLibrary'
  | 'reconnect';

export type AsyncOperationPhase = 'running' | 'success' | 'error';

export interface AsyncRunOptions {
  /** 成功副标题，或需填入标题占位符（如库名、模型名）。 */
  detail?: string;
}

export interface AsyncOperationSnapshot {
  readonly key: AsyncOperationKey | null;
  readonly phase: AsyncOperationPhase | null;
  readonly detail?: string;
  readonly errorMessage?: string;
  readonly startedAt: number;
}

export type AsyncOperationListener = () => void;

const EMPTY_SNAPSHOT: AsyncOperationSnapshot = {
  key: null,
  phase: null,
  startedAt: 0,
};

/**
 * 跟踪耗时远程操作（保存 / 拉取 / 加载画布等），供右侧 toast 展示进度并在完成后切换状态。
 */
export class AsyncOperationManager {
  private readonly _stack: AsyncOperationKey[] = [];
  private readonly _listeners = new Set<AsyncOperationListener>();
  private _snapshot: AsyncOperationSnapshot = EMPTY_SNAPSHOT;

  get isBusy(): boolean {
    return this._stack.length > 0;
  }

  /** 栈顶操作（嵌套时显示最内层）。 */
  get current(): AsyncOperationKey | null {
    return this._stack[this._stack.length - 1] ?? null;
  }

  get snapshot(): AsyncOperationSnapshot {
    return this._snapshot;
  }

  isActive(key: AsyncOperationKey): boolean {
    return this._stack.includes(key);
  }

  subscribe(fn: AsyncOperationListener): () => void {
    this._listeners.add(fn);
    return () => {
      this._listeners.delete(fn);
    };
  }

  dismiss(): void {
    this._snapshot = EMPTY_SNAPSHOT;
    this._notify();
  }

  async run<T>(key: AsyncOperationKey, fn: () => Promise<T>, opts?: AsyncRunOptions): Promise<T> {
    this._snapshot = {
      key,
      phase: 'running',
      detail: opts?.detail,
      startedAt: Date.now(),
    };
    this._begin(key);
    let outcome: AsyncOperationPhase = 'success';
    let errorMessage: string | undefined;
    try {
      return await fn();
    } catch (e) {
      outcome = 'error';
      errorMessage = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      this._end(key);
      if (this._stack.length > 0) {
        const parent = this._stack[this._stack.length - 1]!;
        this._snapshot = {
          key: parent,
          phase: 'running',
          detail: opts?.detail,
          startedAt: Date.now(),
        };
      } else {
        this._snapshot = {
          key,
          phase: outcome,
          detail: opts?.detail,
          errorMessage,
          startedAt: this._snapshot.startedAt,
        };
      }
      this._notify();
    }
  }

  private _begin(key: AsyncOperationKey): void {
    this._stack.push(key);
    this._notify();
  }

  private _end(key: AsyncOperationKey): void {
    const index = this._stack.lastIndexOf(key);
    if (index >= 0) {
      this._stack.splice(index, 1);
    }
  }

  private _notify(): void {
    for (const fn of this._listeners) {
      fn();
    }
  }
}

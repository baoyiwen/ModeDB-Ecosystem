import type { EngineApplyOutcome, EngineOperation, RemoteExecuteSnapshot } from '@mode-db/shared';

import type { ImportRowFailure } from './insert-many-failures.js';

/** Pluggable transport for headless {@link BindingSession} (typically SDK `apply` / `executeQuery`). */
export interface BindingExecutor {
  executeQuery(snapshot: RemoteExecuteSnapshot): Promise<unknown>;
  applyAll(
    ops: readonly EngineOperation[],
    options?: { failFast?: boolean },
  ): Promise<readonly EngineApplyOutcome[]>;
}

export interface ApplyBatchResult {
  readonly ok: boolean;
  readonly outcomes: readonly EngineApplyOutcome[];
  readonly committedCount: number;
  readonly error?: string;
  readonly partialSuccess?: boolean;
  readonly importFailures?: readonly ImportRowFailure[];
}

/** Snapshot change listener for UI refresh. */
export type BindingListener = () => void;

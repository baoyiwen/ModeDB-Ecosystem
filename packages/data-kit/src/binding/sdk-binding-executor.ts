import type {
  EngineApplyOutcome,
  EngineOperation,
  EngineOperationResult,
  WireExecuteResultJson,
} from '@mode-db/shared';

import type { BindingExecutor } from './binding-executor.js';

/** Minimal SDK surface required for {@link createSdkBindingExecutor}. */
export interface SdkBindingClient {
  apply(op: EngineOperation): Promise<EngineOperationResult>;
  applyAll(
    ops: readonly EngineOperation[],
    opts?: { failFast?: boolean },
  ): Promise<EngineApplyOutcome[]>;
}

function isWireExecuteResultJson(x: unknown): x is WireExecuteResultJson {
  if (typeof x !== 'object' || x === null || !('kind' in x)) {
    return false;
  }
  const kind = (x as { kind: unknown }).kind;
  return (
    kind === 'rows' ||
    kind === 'analysis' ||
    kind === 'groups' ||
    kind === 'paginated' ||
    kind === 'mutation' ||
    kind === 'previewBind' ||
    kind === 'relationStats'
  );
}

/**
 * Adapts {@link RemoteModelDBClient.apply} / `applyAll` to {@link BindingExecutor}.
 */
export function createSdkBindingExecutor(client: SdkBindingClient): BindingExecutor {
  return {
    async executeQuery(snapshot) {
      const result = await client.apply({ op: 'executeQuery', snapshot });
      if (!isWireExecuteResultJson(result)) {
        throw new Error('executeQuery: unexpected result shape from SDK apply.');
      }
      return result;
    },
    applyAll(ops, opts) {
      return client.applyAll(ops, opts);
    },
  };
}

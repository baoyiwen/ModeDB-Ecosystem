import type { RemoteExecuteSnapshot } from '@mode-db/shared';

import { WIRE_EMPTY_TRAILING } from './wire-trailing.js';

/** Returns a copy of the snapshot with an updated page (and optional limit). */
export function withQueryPage(
  snapshot: RemoteExecuteSnapshot,
  page: number,
  limit?: number,
): RemoteExecuteSnapshot {
  const nextLimit = limit ?? snapshot.execute.limit;
  return {
    ...snapshot,
    execute: {
      ...snapshot.execute,
      page: Math.max(0, page),
      ...(nextLimit !== undefined ? { limit: nextLimit } : {}),
    },
  };
}

/** Origin model + all-rows start spec for a simple tabular view. */
export function createTabularSnapshot(
  originModel: string,
  options?: { page?: number; limit?: number },
): RemoteExecuteSnapshot {
  const page = options?.page ?? 0;
  const limit = options?.limit ?? 50;
  return {
    plan: {
      version: 2,
      originModel,
      start: { kind: 'all' },
      hops: [],
      trailing: WIRE_EMPTY_TRAILING,
    },
    execute: { page, limit },
    analysis: { groupBy: null, compute: null },
  };
}

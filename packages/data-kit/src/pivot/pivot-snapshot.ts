import type { AggregateInputEntry, RemoteExecuteSnapshot } from '@mode-db/shared';

import { wireTrailingFromDrill } from '../binding/wire-trailing.js';
/** One applied pivot drill filter (dimension = value). */
export interface PivotDrillStep {
  readonly dimension: string;
  readonly value: unknown;
}

/** Pivot view configuration for an origin model. */
export interface PivotViewConfig {
  readonly originModel: string;
  readonly dimensions: readonly string[];
  readonly compute: Readonly<Record<string, AggregateInputEntry>>;
}

export interface BuildPivotSnapshotResult {
  readonly snapshot: RemoteExecuteSnapshot;
  /** True when drill reached entity grain (tabular fetch, leaf edit allowed). */
  readonly isLeafGrain: boolean;
  readonly remainingDimensions: readonly string[];
}

/**
 * Builds a wire snapshot for the current pivot drill level.
 * When all dimensions are drilled, returns a tabular snapshot (no groupBy).
 */
export function buildPivotSnapshot(
  config: PivotViewConfig,
  drillPath: readonly PivotDrillStep[],
  options?: { page?: number; limit?: number },
): BuildPivotSnapshotResult {
  const page = options?.page ?? 0;
  const limit = options?.limit ?? 50;
  const remainingDimensions = config.dimensions.slice(drillPath.length);
  const isLeafGrain = remainingDimensions.length === 0;
  const trailing = wireTrailingFromDrill(drillPath);

  const basePlan = {
    version: 2 as const,
    originModel: config.originModel,
    start: { kind: 'all' as const },
    hops: [] as const,
    trailing,
  };

  if (isLeafGrain) {
    return {
      isLeafGrain: true,
      remainingDimensions: [],
      snapshot: {
        plan: basePlan,
        execute: { page, limit },
        analysis: { groupBy: null, compute: null },
      },
    };
  }

  return {
    isLeafGrain: false,
    remainingDimensions,
    snapshot: {
      plan: basePlan,
      execute: { page, limit },
      analysis: {
        groupBy: [...remainingDimensions],
        compute: { ...config.compute },
      },
    },
  };
}

/** Append one drill step (must match the next dimension in order). */
export function appendPivotDrill(
  path: readonly PivotDrillStep[],
  config: PivotViewConfig,
  value: unknown,
): readonly PivotDrillStep[] {
  const nextDim = config.dimensions[path.length];
  if (!nextDim) {
    return path;
  }
  return [...path, { dimension: nextDim, value }];
}

/** Remove the last N drill steps (default 1). */
export function popPivotDrill(
  path: readonly PivotDrillStep[],
  steps = 1,
): readonly PivotDrillStep[] {
  if (steps <= 0 || path.length === 0) {
    return path;
  }
  return path.slice(0, Math.max(0, path.length - steps));
}

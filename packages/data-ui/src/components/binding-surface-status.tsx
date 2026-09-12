import type { ReactElement } from 'react';
import { useBindingSurface } from '../context/binding-surface-context.js';

export interface BindingSurfaceStatusLabels {
  readonly loading: string;
  readonly mutating: string;
  readonly needsRefresh: string;
  readonly refreshFailed: string;
  readonly error: string;
  readonly refresh: string;
}

export interface BindingSurfaceStatusProps {
  readonly labels?: Partial<BindingSurfaceStatusLabels>;
  readonly onError?: (error: unknown) => void;
}

const DEFAULT_LABELS: BindingSurfaceStatusLabels = {
  loading: 'Loading data',
  mutating: 'Saving change',
  needsRefresh: 'The change was committed, but the view needs to be refreshed.',
  refreshFailed: 'The change was committed, but refresh failed.',
  error: 'Binding Surface request failed.',
  refresh: 'Refresh',
};

/** Distinguishes request failure from a committed mutation whose refresh failed. */
export function BindingSurfaceStatus(props: BindingSurfaceStatusProps): ReactElement | null {
  const surface = useBindingSurface();
  const labels = { ...DEFAULT_LABELS, ...props.labels };
  const refreshFailure = surface.refreshError;
  const state = refreshFailure
    ? 'refresh-failed'
    : surface.lastError
      ? 'error'
      : surface.needsRefresh
        ? 'needs-refresh'
        : surface.isMutating
          ? 'mutating'
          : surface.isRefreshing
            ? 'loading'
            : undefined;

  if (!state) {
    return null;
  }

  const message =
    state === 'refresh-failed'
      ? `${labels.refreshFailed} ${refreshFailure?.message ?? ''}`.trim()
      : state === 'error'
        ? `${labels.error} ${surface.lastError ?? ''}`.trim()
        : state === 'needs-refresh'
          ? labels.needsRefresh
          : state === 'mutating'
            ? labels.mutating
            : labels.loading;
  const canRefresh =
    (state === 'refresh-failed' || state === 'needs-refresh' || state === 'error') &&
    !surface.isRefreshing &&
    !surface.isMutating;

  return (
    <div className="binding-surface-status" data-state={state} role="status">
      <span>{message}</span>
      {canRefresh ? (
        <button
          type="button"
          onClick={() => {
            void surface.refresh().catch((error: unknown) => props.onError?.(error));
          }}
        >
          {labels.refresh}
        </button>
      ) : null}
    </div>
  );
}

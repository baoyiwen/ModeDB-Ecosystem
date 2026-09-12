import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from 'react';
import type {
  BindingSurfaceMutationInput,
  BindingSurfaceSession,
  PublishedBindingSurfaceContract,
  ViewDataShape,
} from '@mode-db/data-kit';

export interface BindingSurfaceContextValue {
  readonly contract: PublishedBindingSurfaceContract;
  readonly session: BindingSurfaceSession;
  readonly viewData: ViewDataShape | null;
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly isRefreshing: boolean;
  readonly isMutating: boolean;
  readonly needsRefresh: boolean;
  readonly lastError: string | null;
  readonly refreshError: BindingSurfaceSession['refreshError'];
  refresh(page?: Parameters<BindingSurfaceSession['refresh']>[0]): Promise<ViewDataShape>;
  mutate(input: BindingSurfaceMutationInput): ReturnType<BindingSurfaceSession['mutate']>;
}

export interface BindingSurfaceProviderProps {
  readonly contract: PublishedBindingSurfaceContract;
  readonly session: BindingSurfaceSession;
  readonly autoRefresh?: boolean;
  readonly children: ReactNode;
  readonly onError?: (error: unknown) => void;
}

const BindingSurfaceContext = createContext<BindingSurfaceContextValue | null>(null);

/** React adapter for one stable headless BindingSurfaceSession. */
export function BindingSurfaceProvider(props: BindingSurfaceProviderProps): ReactElement {
  const { contract, session, autoRefresh = true, children, onError } = props;
  const subscribe = useCallback(
    (onStoreChange: () => void) => session.subscribe(onStoreChange),
    [session],
  );
  const getSnapshot = useCallback(() => session.revision, [session]);
  const revision = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (
      autoRefresh &&
      session.viewData === null &&
      !session.isRefreshing &&
      !session.isMutating &&
      session.lastError === null
    ) {
      void session.refresh().catch((error: unknown) => onError?.(error));
    }
  }, [autoRefresh, onError, session]);

  const refresh = useCallback(
    (page?: Parameters<BindingSurfaceSession['refresh']>[0]) => session.refresh(page),
    [session],
  );
  const mutate = useCallback(
    (input: BindingSurfaceMutationInput) => session.mutate(input),
    [session],
  );

  const value = useMemo<BindingSurfaceContextValue>(
    () => ({
      contract,
      session,
      viewData: session.viewData,
      rows: session.rows,
      isRefreshing: session.isRefreshing,
      isMutating: session.isMutating,
      needsRefresh: session.needsRefresh,
      lastError: session.lastError,
      refreshError: session.refreshError,
      refresh,
      mutate,
    }),
    [contract, mutate, refresh, revision, session],
  );

  return <BindingSurfaceContext.Provider value={value}>{children}</BindingSurfaceContext.Provider>;
}

/** Access the nearest BindingSurfaceProvider. */
export function useBindingSurface(): BindingSurfaceContextValue {
  const value = useContext(BindingSurfaceContext);
  if (!value) {
    throw new Error('useBindingSurface must be used within BindingSurfaceProvider');
  }
  return value;
}

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from 'react';
import type { PivotDrillStep, PivotViewConfig, RemoteExecuteSnapshot } from '@mode-db/data-kit';
import type { ApplyBatchResult } from '@mode-db/data-kit';
import {
  appendPivotDrill,
  buildPivotSnapshot,
  canEnterMode,
  createBindingSession,
  DEFAULT_ALLOWED_MODES,
  popPivotDrill,
  withQueryPage,
  type BindingExecutor,
  type BindingSession,
  type DataPageMode,
  type ViewDataShape,
} from '@mode-db/data-kit';
import { DataPageContext, type DataPageContextValue } from './data-page-context.js';

export type { DataPageContextValue } from './data-page-context.js';
export { useDataPage } from './data-page-context.js';

export interface DataPageProviderProps {
  readonly executor: BindingExecutor;
  readonly querySnapshot?: RemoteExecuteSnapshot;
  readonly pivotConfig?: PivotViewConfig | null;
  readonly propFields?: readonly string[];
  readonly allowedModes?: readonly DataPageMode[];
  readonly initialMode?: DataPageMode;
  readonly children: ReactNode;
  readonly onModeBlocked?: (reason: 'dirty') => void;
}

/** Page-root provider: global mode + batch {@link BindingSession}. */
export function DataPageProvider(props: DataPageProviderProps): ReactElement {
  const {
    executor,
    querySnapshot,
    pivotConfig = null,
    propFields,
    allowedModes = DEFAULT_ALLOWED_MODES,
    initialMode = 'view',
    children,
    onModeBlocked,
  } = props;

  const [drillPath, setDrillPath] = useState<readonly PivotDrillStep[]>([]);

  const built = useMemo(() => {
    if (pivotConfig) {
      return buildPivotSnapshot(pivotConfig, drillPath);
    }
    if (!querySnapshot) {
      throw new Error('DataPageProvider: provide querySnapshot or pivotConfig.');
    }
    return {
      snapshot: querySnapshot,
      isLeafGrain: false,
      remainingDimensions: [] as readonly string[],
    };
  }, [pivotConfig, drillPath, querySnapshot]);

  const binding = useMemo(
    () =>
      createBindingSession({
        querySnapshot: built.snapshot,
        executor,
        pivotLeafGrain: built.isLeafGrain,
        propFields,
      }),
    [built.snapshot, built.isLeafGrain, executor, propFields],
  );

  const safeInitial = canEnterMode(initialMode, allowedModes) ? initialMode : 'view';
  const [mode, setModeState] = useState<DataPageMode>(safeInitial);

  const subscribe = useCallback(
    (onStoreChange: () => void) => binding.subscribe(onStoreChange),
    [binding],
  );
  const getSnapshot = useCallback(() => binding.revision, [binding]);
  const bindingRevision = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    void binding.refresh();
  }, [binding]);

  const nextDrillDimension = pivotConfig
    ? (pivotConfig.dimensions[drillPath.length] ?? null)
    : null;

  const guardDirty = useCallback((): boolean => {
    if (binding.isDirty) {
      onModeBlocked?.('dirty');
      return true;
    }
    return false;
  }, [binding.isDirty, onModeBlocked]);

  const setMode = useCallback(
    (next: DataPageMode) => {
      if (!canEnterMode(next, allowedModes)) {
        return;
      }
      if (binding.isDirty && next !== mode) {
        onModeBlocked?.('dirty');
        return;
      }
      setModeState(next);
    },
    [allowedModes, binding.isDirty, mode, onModeBlocked],
  );

  const refresh = useCallback(async (): Promise<ViewDataShape> => binding.refresh(), [binding]);

  const setPage = useCallback(
    async (page: number): Promise<ViewDataShape> => {
      if (guardDirty()) {
        throw new Error('Cannot change page while pending edits exist.');
      }
      const next = withQueryPage(built.snapshot, Math.max(0, page));
      binding.setQuerySnapshot(next);
      return binding.refresh();
    },
    [binding, built.snapshot, guardDirty],
  );

  const drillInto = useCallback(
    async (value: unknown): Promise<ViewDataShape> => {
      if (!pivotConfig || !nextDrillDimension) {
        return binding.refresh();
      }
      if (guardDirty()) {
        throw new Error('Cannot drill while pending edits exist.');
      }
      setDrillPath(appendPivotDrill(drillPath, pivotConfig, value));
      return binding.viewData ?? { kind: 'empty' };
    },
    [binding, drillPath, guardDirty, nextDrillDimension, pivotConfig],
  );

  const drillUp = useCallback(
    async (steps = 1): Promise<ViewDataShape> => {
      if (!pivotConfig) {
        return binding.refresh();
      }
      if (guardDirty()) {
        throw new Error('Cannot drill while pending edits exist.');
      }
      setDrillPath(popPivotDrill(drillPath, steps));
      return binding.viewData ?? { kind: 'empty' };
    },
    [binding, drillPath, guardDirty, pivotConfig],
  );

  const resetDrill = useCallback(async (): Promise<ViewDataShape> => {
    if (!pivotConfig) {
      return binding.refresh();
    }
    if (guardDirty()) {
      throw new Error('Cannot drill while pending edits exist.');
    }
    setDrillPath([]);
    return binding.viewData ?? { kind: 'empty' };
  }, [binding, guardDirty, pivotConfig]);

  const stageCellUpdate = useCallback(
    (
      ref: Parameters<DataPageContextValue['stageCellUpdate']>[0],
      column: string,
      value: unknown,
    ): void => {
      if (mode !== 'edit') {
        return;
      }
      binding.stageCellUpdate(ref, column, value, 'edit');
    },
    [binding, mode],
  );

  const stageRowDelete = useCallback(
    (ref: Parameters<DataPageContextValue['stageRowDelete']>[0]): void => {
      if (mode !== 'delete') {
        return;
      }
      binding.stageRowDelete(ref);
    },
    [binding, mode],
  );

  const unstageRowDelete = useCallback(
    (ref: Parameters<DataPageContextValue['unstageRowDelete']>[0]): void => {
      binding.unstageRowDelete(ref);
    },
    [binding],
  );

  const stageImportOps = useCallback(
    (
      ops: Parameters<DataPageContextValue['stageImportOps']>[0],
      bindOnlyStaging?: Parameters<DataPageContextValue['stageImportOps']>[1],
    ): void => {
      if (mode !== 'edit') {
        setModeState('edit');
      }
      binding.stageImportBatch(ops, bindOnlyStaging, 'edit');
    },
    [binding, mode],
  );

  const discard = useCallback((): void => binding.discard(), [binding]);
  const commitBatch = useCallback(
    async (): Promise<ApplyBatchResult> => binding.commit(),
    [binding],
  );
  const commit = useCallback(async (): Promise<void> => {
    const result = await binding.commit();
    if (!result.ok) {
      throw new Error(result.error ?? 'Commit failed');
    }
  }, [binding]);

  const replacePendingOps = useCallback(
    (ops: Parameters<BindingSession['replacePendingOps']>[0]): void => {
      binding.replacePendingOps(ops);
    },
    [binding],
  );

  const updateImportRow = useCallback(
    (opIndex: number, rowIndex: number, field: string, value: unknown): void => {
      binding.updateImportRow(opIndex, rowIndex, field, value);
    },
    [binding],
  );

  const value = useMemo<DataPageContextValue>(
    () => ({
      mode,
      allowedModes,
      binding,
      viewData: binding.viewData,
      isDirty: binding.isDirty,
      isRefreshing: binding.isRefreshing,
      lastError: binding.lastError,
      importFailures: binding.importFailures,
      pivotConfig,
      drillPath,
      nextDrillDimension,
      setMode,
      refresh,
      setPage,
      drillInto,
      drillUp,
      resetDrill,
      stageCellUpdate,
      stageRowDelete,
      unstageRowDelete,
      stageImportOps,
      replacePendingOps,
      updateImportRow,
      discard,
      commit,
      commitBatch,
    }),
    [
      mode,
      allowedModes,
      binding,
      bindingRevision,
      pivotConfig,
      drillPath,
      nextDrillDimension,
      setMode,
      refresh,
      setPage,
      drillInto,
      drillUp,
      resetDrill,
      stageCellUpdate,
      stageRowDelete,
      unstageRowDelete,
      stageImportOps,
      replacePendingOps,
      updateImportRow,
      discard,
      commit,
      commitBatch,
    ],
  );

  return <DataPageContext.Provider value={value}>{children}</DataPageContext.Provider>;
}

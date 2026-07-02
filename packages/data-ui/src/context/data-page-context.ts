import { createContext, useContext } from 'react';
import type {
  ApplyBatchResult,
  BindingSession,
  DataPageMode,
  EntityRowRef,
  ImportRowFailure,
  PivotDrillStep,
  PivotViewConfig,
  ViewDataShape,
} from '@mode-db/data-kit';

export interface DataPageContextValue {
  readonly mode: DataPageMode;
  readonly allowedModes: readonly DataPageMode[];
  readonly binding: BindingSession;
  readonly viewData: ViewDataShape | null;
  readonly isDirty: boolean;
  readonly isRefreshing: boolean;
  readonly lastError: string | null;
  readonly importFailures: readonly ImportRowFailure[] | null;
  readonly pivotConfig: PivotViewConfig | null;
  readonly drillPath: readonly PivotDrillStep[];
  readonly nextDrillDimension: string | null;
  setMode(next: DataPageMode): void;
  refresh(): Promise<ViewDataShape>;
  setPage(page: number): Promise<ViewDataShape>;
  drillInto(value: unknown): Promise<ViewDataShape>;
  drillUp(steps?: number): Promise<ViewDataShape>;
  resetDrill(): Promise<ViewDataShape>;
  stageCellUpdate(ref: EntityRowRef, column: string, value: unknown): void;
  stageRowDelete(ref: EntityRowRef): void;
  unstageRowDelete(ref: EntityRowRef): void;
  stageImportOps(
    ops: Parameters<BindingSession['stageMany']>[0],
    bindOnlyStaging?: Parameters<BindingSession['stageImportBatch']>[1],
  ): void;
  replacePendingOps(ops: Parameters<BindingSession['replacePendingOps']>[0]): void;
  updateImportRow(opIndex: number, rowIndex: number, field: string, value: unknown): void;
  discard(): void;
  commit(): Promise<void>;
  commitBatch(): Promise<ApplyBatchResult>;
}

export const DataPageContext = createContext<DataPageContextValue | null>(null);

/** Access the nearest {@link DataPageProvider} value. */
export function useDataPage(): DataPageContextValue {
  const ctx = useContext(DataPageContext);
  if (!ctx) {
    throw new Error('useDataPage must be used within DataPageProvider');
  }
  return ctx;
}

import type { RemoteExecuteSnapshot } from '@mode-db/shared';

import type { DataPageMode } from './page-mode.js';

/** Declarative configuration for a data view embedded in Designer pages or data-studio. */
export interface ViewSpec {
  /** Stable id within a page (Designer layer / page entity). */
  readonly id: string;
  /** Registered UI component key (`DataTable`, `PivotTable`, `ImportPanel`, …). */
  readonly component: string;
  /** Engine query snapshot — serialized {@link RemoteExecuteSnapshot}. */
  readonly querySnapshot: RemoteExecuteSnapshot;
  /** Component-specific presentation props (column widths, default sort, …). */
  readonly props?: Readonly<Record<string, unknown>>;
  /** Subset of {@link DataPageMode} enabled for this view. */
  readonly allowedModes?: readonly DataPageMode[];
  /** Import / clean profiles referenced by ingest views. */
  readonly importProfileId?: string;
}

/** Page-level composition: multiple views + shared defaults. */
export interface DataPageSpec {
  readonly pageId: string;
  readonly title?: string;
  readonly defaultMode?: DataPageMode;
  readonly allowedModes?: readonly DataPageMode[];
  readonly views: readonly ViewSpec[];
}

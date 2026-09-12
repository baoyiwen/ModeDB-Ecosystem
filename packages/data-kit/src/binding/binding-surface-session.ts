import type {
  QueryInterfaceErrorDetail,
  WireBindingSurfacePageOptions,
  WireBindingSurfaceResult,
  WireRowRef,
} from '@mode-db/shared';

import type { AdaptQueryResultOptions } from '../view-data/query-result-adapter.js';
import { adaptQueryResult } from '../view-data/query-result-adapter.js';
import type { ViewDataShape } from '../view-data/view-data-shape.js';
import type { BindingListener } from './binding-executor.js';

export interface BindingSurfaceExecutor {
  invokeBindingSurface(
    surfaceId: string,
    options: {
      readonly action:
        | ({ readonly kind: 'read' } & WireBindingSurfacePageOptions)
        | ({
            readonly kind: 'mutate';
            readonly mutationId: string;
            readonly row?: Readonly<Record<string, unknown>>;
            readonly recordRefs?: Readonly<Record<string, WireRowRef>>;
            readonly editedValue?: unknown;
          } & WireBindingSurfacePageOptions);
      readonly version?: string;
      readonly parameters?: Readonly<Record<string, unknown>>;
      readonly accessKey?: string;
      readonly accessKeys?: Readonly<Record<string, string>>;
    },
  ): Promise<WireBindingSurfaceResult>;
}

export interface BindingSurfaceSessionOptions {
  readonly surfaceId: string;
  readonly executor: BindingSurfaceExecutor;
  readonly version?: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly accessKey?: string;
  readonly accessKeys?: Readonly<Record<string, string>>;
  readonly adapt?: AdaptQueryResultOptions;
  readonly initialResult?: WireBindingSurfaceResult;
}

export interface BindingSurfaceMutationInput extends WireBindingSurfacePageOptions {
  readonly mutationId: string;
  readonly rowIndex?: number;
  readonly row?: Readonly<Record<string, unknown>>;
  readonly recordRefs?: Readonly<Record<string, WireRowRef>>;
  readonly editedValue?: unknown;
}

export interface BindingSurfaceSession {
  readonly surfaceId: string;
  readonly requestedVersion: string | undefined;
  readonly resolvedVersion: string | undefined;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly accessKeys: Readonly<Record<string, string>>;
  readonly revision: number;
  readonly viewData: ViewDataShape | null;
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly isRefreshing: boolean;
  readonly isMutating: boolean;
  readonly needsRefresh: boolean;
  readonly lastResult: WireBindingSurfaceResult | null;
  readonly lastError: string | null;
  readonly refreshError: QueryInterfaceErrorDetail | null;

  subscribe(listener: BindingListener): () => void;
  setVersion(version: string | undefined): void;
  setParameters(parameters: Readonly<Record<string, unknown>>): void;
  setAccessKeys(accessKeys: Readonly<Record<string, string>>): void;
  recordRefsForRow(rowIndex: number): Readonly<Record<string, WireRowRef>>;
  refresh(page?: WireBindingSurfacePageOptions): Promise<ViewDataShape>;
  mutate(input: BindingSurfaceMutationInput): Promise<WireBindingSurfaceResult>;
}

/**
 * Creates a headless session around one published BindingSurface.
 * Mutation success and refresh success are deliberately tracked separately.
 */
export function createBindingSurfaceSession(
  options: BindingSurfaceSessionOptions,
): BindingSurfaceSession {
  const surfaceId = options.surfaceId.trim();
  if (!surfaceId) {
    throw new Error('BindingSurfaceSession: surfaceId is required.');
  }
  let requestedVersion = normalizeOptional(options.version);
  let resolvedVersion: string | undefined;
  let parameters = { ...(options.parameters ?? {}) };
  let accessKeys = { ...(options.accessKeys ?? {}) };
  let revision = 0;
  let viewData: ViewDataShape | null = null;
  let rows: readonly Readonly<Record<string, unknown>>[] = [];
  let isRefreshing = false;
  let isMutating = false;
  let needsRefresh = false;
  let lastResult: WireBindingSurfaceResult | null = null;
  let lastError: string | null = null;
  let refreshError: QueryInterfaceErrorDetail | null = null;
  const listeners = new Set<BindingListener>();

  const notify = (): void => {
    revision += 1;
    for (const listener of listeners) {
      listener();
    }
  };

  const applyResult = (result: WireBindingSurfaceResult): void => {
    lastResult = result;
    resolvedVersion = result.version;
    lastError = null;
    refreshError = result.refreshError ?? null;
    if (result.query) {
      rows = result.query.rows;
      viewData = adaptQueryResult(result.query, options.adapt);
      needsRefresh = false;
    } else if (result.action === 'mutate') {
      needsRefresh = true;
    }
    if (result.status === 'refreshFailed') {
      needsRefresh = true;
    }
  };

  if (options.initialResult) {
    applyResult(options.initialResult);
  }

  const refresh = async (page: WireBindingSurfacePageOptions = {}): Promise<ViewDataShape> => {
    isRefreshing = true;
    lastError = null;
    notify();
    try {
      const result = await options.executor.invokeBindingSurface(surfaceId, {
        action: { kind: 'read', ...page },
        ...(requestedVersion ? { version: requestedVersion } : {}),
        ...(Object.keys(parameters).length > 0 ? { parameters } : {}),
        ...(options.accessKey ? { accessKey: options.accessKey } : {}),
        ...(Object.keys(accessKeys).length > 0 ? { accessKeys } : {}),
      });
      applyResult(result);
      if (!result.query) {
        throw new Error('BindingSurfaceSession: read result did not include query data.');
      }
      return viewData ?? { kind: 'empty', reason: 'no_rows' };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      isRefreshing = false;
      notify();
    }
  };

  const mutate = async (input: BindingSurfaceMutationInput): Promise<WireBindingSurfaceResult> => {
    const mutationId = input.mutationId.trim();
    if (!mutationId) {
      throw new Error('BindingSurfaceSession: mutationId is required.');
    }
    const row = input.row ?? rowAt(rows, input.rowIndex);
    const recordRefs = input.recordRefs ?? (row ? bindingSurfaceRecordRefs(row) : {});
    isMutating = true;
    lastError = null;
    refreshError = null;
    notify();
    try {
      const result = await options.executor.invokeBindingSurface(surfaceId, {
        action: {
          kind: 'mutate',
          mutationId,
          ...(row ? { row } : {}),
          ...(Object.keys(recordRefs).length > 0 ? { recordRefs } : {}),
          ...('editedValue' in input ? { editedValue: input.editedValue } : {}),
          ...(input.page !== undefined ? { page: input.page } : {}),
          ...(Object.prototype.hasOwnProperty.call(input, 'cursor')
            ? { cursor: input.cursor ?? null }
            : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        },
        ...(requestedVersion ? { version: requestedVersion } : {}),
        ...(Object.keys(parameters).length > 0 ? { parameters } : {}),
        ...(options.accessKey ? { accessKey: options.accessKey } : {}),
        ...(Object.keys(accessKeys).length > 0 ? { accessKeys } : {}),
      });
      applyResult(result);
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      isMutating = false;
      notify();
    }
  };

  const assertIdle = (): void => {
    if (isRefreshing || isMutating) {
      throw new Error(
        'BindingSurfaceSession: cannot change configuration while a request is active.',
      );
    }
  };

  return {
    surfaceId,
    get requestedVersion() {
      return requestedVersion;
    },
    get resolvedVersion() {
      return resolvedVersion;
    },
    get parameters() {
      return parameters;
    },
    get accessKeys() {
      return accessKeys;
    },
    get revision() {
      return revision;
    },
    get viewData() {
      return viewData;
    },
    get rows() {
      return rows;
    },
    get isRefreshing() {
      return isRefreshing;
    },
    get isMutating() {
      return isMutating;
    },
    get needsRefresh() {
      return needsRefresh;
    },
    get lastResult() {
      return lastResult;
    },
    get lastError() {
      return lastError;
    },
    get refreshError() {
      return refreshError;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setVersion(version) {
      assertIdle();
      requestedVersion = normalizeOptional(version);
      notify();
    },
    setParameters(nextParameters) {
      assertIdle();
      parameters = { ...nextParameters };
      notify();
    },
    setAccessKeys(nextAccessKeys) {
      assertIdle();
      accessKeys = { ...nextAccessKeys };
      notify();
    },
    recordRefsForRow(rowIndex) {
      return bindingSurfaceRecordRefs(rowAt(rows, rowIndex, true));
    },
    refresh,
    mutate,
  };
}

/** Extracts unambiguous node record refs from one projected BindingSurface row. */
export function bindingSurfaceRecordRefs(
  row: Readonly<Record<string, unknown>>,
): Readonly<Record<string, WireRowRef>> {
  const refs = new Map<string, WireRowRef>();
  const ambiguous = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object') {
      return;
    }
    const record = value as Readonly<Record<string, unknown>>;
    const ref = parseProjectedRecordRef(record.$recordRef);
    if (ref) {
      const existing = refs.get(ref.nodeId);
      if (existing && (existing.model !== ref.model || existing.id !== ref.id)) {
        ambiguous.add(ref.nodeId);
        refs.delete(ref.nodeId);
      } else if (!ambiguous.has(ref.nodeId)) {
        refs.set(ref.nodeId, { model: ref.model, id: ref.id });
      }
    }
    for (const [key, child] of Object.entries(record)) {
      if (key !== '$recordRef') {
        visit(child);
      }
    }
  };
  visit(row);
  return Object.fromEntries(refs);
}

function parseProjectedRecordRef(
  value: unknown,
): { readonly nodeId: string; readonly model: string; readonly id: string } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const ref = value as Readonly<Record<string, unknown>>;
  return typeof ref.nodeId === 'string' &&
    ref.nodeId.length > 0 &&
    typeof ref.model === 'string' &&
    ref.model.length > 0 &&
    typeof ref.id === 'string' &&
    ref.id.length > 0
    ? { nodeId: ref.nodeId, model: ref.model, id: ref.id }
    : undefined;
}

function rowAt(
  rows: readonly Readonly<Record<string, unknown>>[],
  index: number | undefined,
  required: true,
): Readonly<Record<string, unknown>>;
function rowAt(
  rows: readonly Readonly<Record<string, unknown>>[],
  index: number | undefined,
  required?: false,
): Readonly<Record<string, unknown>> | undefined;
function rowAt(
  rows: readonly Readonly<Record<string, unknown>>[],
  index: number | undefined,
  required = false,
): Readonly<Record<string, unknown>> | undefined {
  if (index === undefined) {
    return undefined;
  }
  const row = Number.isInteger(index) && index >= 0 ? rows[index] : undefined;
  if (!row && required) {
    throw new Error(`BindingSurfaceSession: row index ${String(index)} is unavailable.`);
  }
  return row;
}

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

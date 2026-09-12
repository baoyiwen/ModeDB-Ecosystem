import { useMemo, useState, type ReactElement } from 'react';
import type { PublishedBindingSurfaceMutation } from '@mode-db/data-kit';
import { useBindingSurface } from '../context/binding-surface-context.js';
import {
  coerceSurfaceValue,
  formatSurfaceValue,
  mutationUsesEditedValue,
  surfaceDeleteMutation,
  surfaceUpdateMutation,
} from './binding-surface-utils.js';

export interface BindingSurfaceTableLabels {
  readonly loading: string;
  readonly empty: string;
  readonly incompatible: string;
  readonly save: string;
  readonly remove: string;
  readonly actions: string;
  readonly previous: string;
  readonly next: string;
  readonly page: string;
}

export interface BindingSurfaceTableProps {
  readonly columnMutationIds?: Readonly<Record<string, string>>;
  readonly deleteMutationId?: string;
  readonly labels?: Partial<BindingSurfaceTableLabels>;
  readonly onMutationSuccess?: (
    mutation: PublishedBindingSurfaceMutation,
    rowIndex: number,
  ) => void;
  readonly onError?: (error: unknown) => void;
}

const DEFAULT_LABELS: BindingSurfaceTableLabels = {
  loading: 'Loading data',
  empty: 'No data.',
  incompatible: 'BindingSurfaceTable requires tabular data.',
  save: 'Save',
  remove: 'Delete',
  actions: 'Actions',
  previous: 'Previous',
  next: 'Next',
  page: 'Page',
};

/** Tabular Binding Surface renderer with explicit, route-driven writes. */
export function BindingSurfaceTable(props: BindingSurfaceTableProps): ReactElement {
  const surface = useBindingSurface();
  const labels = { ...DEFAULT_LABELS, ...props.labels };
  const shape = surface.viewData;
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const deleteMutation = useMemo(
    () => surfaceDeleteMutation(surface.contract, props.deleteMutationId),
    [props.deleteMutationId, surface.contract],
  );
  const busy = surface.isRefreshing || surface.isMutating;

  if (!shape) {
    return (
      <div className="binding-surface-empty">
        {surface.lastError ?? (surface.isRefreshing ? labels.loading : labels.empty)}
      </div>
    );
  }
  if (shape.kind === 'empty') {
    return <div className="binding-surface-empty">{labels.empty}</div>;
  }
  if (shape.kind !== 'tabular') {
    return <div className="binding-surface-empty">{labels.incompatible}</div>;
  }

  const updateMutations = new Map(
    shape.columns.map((column) => [
      column.key,
      surfaceUpdateMutation(surface.contract, column.key, props.columnMutationIds?.[column.key]),
    ]),
  );
  const hasActions = deleteMutation !== undefined;

  const runMutation = (
    mutation: PublishedBindingSurfaceMutation,
    rowIndex: number,
    editedValue?: unknown,
  ): void => {
    void surface
      .mutate({
        mutationId: mutation.id,
        rowIndex,
        ...(mutationUsesEditedValue(mutation) ? { editedValue } : {}),
      })
      .then(() => {
        setDrafts((current) => {
          const next = { ...current };
          delete next[draftKey(rowIndex, mutation.id)];
          return next;
        });
        props.onMutationSuccess?.(mutation, rowIndex);
      })
      .catch((error: unknown) => props.onError?.(error));
  };

  return (
    <div className="binding-surface-table-wrap">
      <div className="binding-surface-table-scroll">
        <table className="binding-surface-table">
          <thead>
            <tr>
              {shape.columns.map((column) => (
                <th key={column.key} scope="col">
                  {column.label ?? column.key}
                </th>
              ))}
              {hasActions ? <th scope="col">{labels.actions}</th> : null}
            </tr>
          </thead>
          <tbody>
            {shape.rows.map((row, rowIndex) => (
              <tr key={rowIdentity(row, rowIndex)}>
                {shape.columns.map((column) => {
                  const mutation = updateMutations.get(column.key);
                  const value = row[column.key];
                  if (!mutation) {
                    return <td key={column.key}>{formatSurfaceValue(value)}</td>;
                  }
                  const key = draftKey(rowIndex, mutation.id);
                  const draft = drafts[key] ?? formatSurfaceValue(value);
                  const label = column.label ?? column.key;
                  return (
                    <td key={column.key}>
                      <div className="binding-surface-inline-editor">
                        {typeof value === 'boolean' ? (
                          <input
                            type="checkbox"
                            checked={draft === 'true'}
                            disabled={busy}
                            aria-label={`${label} row ${rowIndex + 1}`}
                            onChange={(event) =>
                              setDrafts((current) => ({
                                ...current,
                                [key]: String(event.target.checked),
                              }))
                            }
                          />
                        ) : (
                          <input
                            value={draft}
                            disabled={busy}
                            aria-label={`${label} row ${rowIndex + 1}`}
                            onChange={(event) =>
                              setDrafts((current) => ({
                                ...current,
                                [key]: event.target.value,
                              }))
                            }
                          />
                        )}
                        <button
                          type="button"
                          disabled={busy || draft === formatSurfaceValue(value)}
                          onClick={() =>
                            runMutation(mutation, rowIndex, coerceSurfaceValue(draft, value))
                          }
                        >
                          {labels.save}
                        </button>
                      </div>
                    </td>
                  );
                })}
                {deleteMutation ? (
                  <td>
                    <button
                      type="button"
                      className="binding-surface-danger-button"
                      disabled={busy}
                      onClick={() => runMutation(deleteMutation, rowIndex)}
                    >
                      {labels.remove}
                    </button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {shape.pagination ? (
        <div className="binding-surface-pagination">
          <button
            type="button"
            disabled={busy || shape.pagination.page <= 0}
            onClick={() =>
              void surface
                .refresh({ page: shape.pagination!.page - 1, limit: shape.pagination!.limit })
                .catch((error: unknown) => props.onError?.(error))
            }
          >
            {labels.previous}
          </button>
          <span>
            {labels.page} {shape.pagination.page + 1} / {Math.max(1, shape.pagination.pageCount)}
          </span>
          <button
            type="button"
            disabled={busy || shape.pagination.page + 1 >= shape.pagination.pageCount}
            onClick={() =>
              void surface
                .refresh({ page: shape.pagination!.page + 1, limit: shape.pagination!.limit })
                .catch((error: unknown) => props.onError?.(error))
            }
          >
            {labels.next}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function draftKey(rowIndex: number, mutationId: string): string {
  return `${rowIndex}\u0000${mutationId}`;
}

function rowIdentity(row: Readonly<Record<string, unknown>>, rowIndex: number): string | number {
  const recordRef = row.$recordRef;
  if (recordRef && typeof recordRef === 'object' && !Array.isArray(recordRef)) {
    const id = (recordRef as Readonly<Record<string, unknown>>).id;
    if (typeof id === 'string' && id) {
      return id;
    }
  }
  return rowIndex;
}

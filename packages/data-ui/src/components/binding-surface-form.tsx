import { useMemo, useState, type ReactElement } from 'react';
import type { PublishedBindingSurfaceMutation } from '@mode-db/data-kit';
import { useBindingSurface } from '../context/binding-surface-context.js';
import {
  coerceSurfaceValue,
  formatSurfaceValue,
  mutationUsesEditedValue,
  surfaceDeleteMutation,
} from './binding-surface-utils.js';

export interface BindingSurfaceFormLabels {
  readonly empty: string;
  readonly save: string;
  readonly run: string;
  readonly remove: string;
}

export interface BindingSurfaceFormProps {
  readonly rowIndex?: number;
  readonly mutationIds?: readonly string[];
  readonly deleteMutationId?: string;
  readonly fieldLabels?: Readonly<Record<string, string>>;
  readonly labels?: Partial<BindingSurfaceFormLabels>;
  readonly onMutationSuccess?: (mutation: PublishedBindingSurfaceMutation) => void;
  readonly onError?: (error: unknown) => void;
}

const DEFAULT_LABELS: BindingSurfaceFormLabels = {
  empty: 'No record is available.',
  save: 'Save',
  run: 'Run',
  remove: 'Delete record',
};

/** Single-record form where every submit maps to one explicit Surface mutation. */
export function BindingSurfaceForm(props: BindingSurfaceFormProps): ReactElement {
  const surface = useBindingSurface();
  const labels = { ...DEFAULT_LABELS, ...props.labels };
  const rowIndex = props.rowIndex ?? 0;
  const row = surface.rows[rowIndex];
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const mutations = useMemo(() => {
    const selected = props.mutationIds ? new Set(props.mutationIds) : undefined;
    return surface.contract.writeback.mutations.filter(
      (mutation) => mutation.trigger.kind === 'update' && (!selected || selected.has(mutation.id)),
    );
  }, [props.mutationIds, surface.contract]);
  const deleteMutation = useMemo(
    () => surfaceDeleteMutation(surface.contract, props.deleteMutationId),
    [props.deleteMutationId, surface.contract],
  );
  const busy = surface.isRefreshing || surface.isMutating;

  if (!row) {
    return <div className="binding-surface-empty">{labels.empty}</div>;
  }

  const runMutation = (mutation: PublishedBindingSurfaceMutation, editedValue?: unknown): void => {
    void surface
      .mutate({
        mutationId: mutation.id,
        rowIndex,
        ...(mutationUsesEditedValue(mutation) ? { editedValue } : {}),
      })
      .then(() => {
        setDrafts((current) => {
          const next = { ...current };
          delete next[mutation.id];
          return next;
        });
        props.onMutationSuccess?.(mutation);
      })
      .catch((error: unknown) => props.onError?.(error));
  };

  return (
    <form className="binding-surface-form" onSubmit={(event) => event.preventDefault()}>
      {mutations.map((mutation) => {
        const fieldPath = mutation.trigger.kind === 'update' ? mutation.trigger.fieldPath : '';
        const value = readField(row, fieldPath);
        const draft = drafts[mutation.id] ?? formatSurfaceValue(value);
        const label = props.fieldLabels?.[fieldPath] ?? fieldPath;
        const takesValue = mutationUsesEditedValue(mutation);
        return (
          <div key={mutation.id} className="binding-surface-form-row">
            <label>
              <span>{label}</span>
              {takesValue ? (
                typeof value === 'boolean' ? (
                  <input
                    type="checkbox"
                    checked={draft === 'true'}
                    disabled={busy}
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [mutation.id]: String(event.target.checked),
                      }))
                    }
                  />
                ) : (
                  <input
                    value={draft}
                    disabled={busy}
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [mutation.id]: event.target.value,
                      }))
                    }
                  />
                )
              ) : (
                <code>{formatSurfaceValue(value)}</code>
              )}
            </label>
            <button
              type="button"
              disabled={busy || (takesValue && draft === formatSurfaceValue(value))}
              onClick={() =>
                runMutation(mutation, takesValue ? coerceSurfaceValue(draft, value) : undefined)
              }
            >
              {takesValue ? labels.save : labels.run}
            </button>
          </div>
        );
      })}
      {deleteMutation ? (
        <div className="binding-surface-form-actions">
          <button
            type="button"
            className="binding-surface-danger-button"
            disabled={busy}
            onClick={() => runMutation(deleteMutation)}
          >
            {labels.remove}
          </button>
        </div>
      ) : null}
    </form>
  );
}

function readField(row: Readonly<Record<string, unknown>>, fieldPath: string): unknown {
  if (Object.prototype.hasOwnProperty.call(row, fieldPath)) {
    return row[fieldPath];
  }
  let value: unknown = row;
  for (const segment of fieldPath.split('.')) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }
    value = (value as Readonly<Record<string, unknown>>)[segment];
  }
  return value;
}

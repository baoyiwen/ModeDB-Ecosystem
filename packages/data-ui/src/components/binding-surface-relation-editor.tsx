import { useMemo, useState, type ReactElement } from 'react';
import type { PublishedBindingSurfaceMutation } from '@mode-db/data-kit';
import { useBindingSurface } from '../context/binding-surface-context.js';
import { mutationUsesEditedValue, surfaceRelationMutations } from './binding-surface-utils.js';

export interface BindingSurfaceRelationLabels {
  readonly targetValue: string;
  readonly bind: string;
  readonly unbind: string;
  readonly rebind: string;
  readonly invalidJson: string;
  readonly empty: string;
}

export interface BindingSurfaceRelationEditorProps {
  readonly rowIndex?: number;
  readonly mutationIds?: readonly string[];
  readonly edgeLabels?: Readonly<Record<string, string>>;
  readonly inputMode?: 'text' | 'json';
  readonly labels?: Partial<BindingSurfaceRelationLabels>;
  readonly onMutationSuccess?: (mutation: PublishedBindingSurfaceMutation) => void;
  readonly onError?: (error: unknown) => void;
}

const DEFAULT_LABELS: BindingSurfaceRelationLabels = {
  targetValue: 'Related record',
  bind: 'Bind',
  unbind: 'Unbind',
  rebind: 'Rebind',
  invalidJson: 'Enter valid JSON for the related record value.',
  empty: 'No relationship operations are published for this Surface.',
};

/** Explicit bind, unbind, and rebind controls derived from published relation routes. */
export function BindingSurfaceRelationEditor(
  props: BindingSurfaceRelationEditorProps,
): ReactElement {
  const surface = useBindingSurface();
  const labels = { ...DEFAULT_LABELS, ...props.labels };
  const rowIndex = props.rowIndex ?? 0;
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const [localError, setLocalError] = useState<string | null>(null);
  const mutations = useMemo(() => {
    const selected = props.mutationIds ? new Set(props.mutationIds) : undefined;
    return surfaceRelationMutations(surface.contract).filter(
      (mutation) => !selected || selected.has(mutation.id),
    );
  }, [props.mutationIds, surface.contract]);
  const busy = surface.isRefreshing || surface.isMutating;

  if (mutations.length === 0) {
    return <div className="binding-surface-empty">{labels.empty}</div>;
  }

  const runMutation = (mutation: PublishedBindingSurfaceMutation): void => {
    const takesValue = mutationUsesEditedValue(mutation);
    let editedValue: unknown;
    if (takesValue) {
      const draft = drafts[mutation.id] ?? '';
      if (props.inputMode === 'json') {
        try {
          editedValue = JSON.parse(draft) as unknown;
        } catch {
          const error = new Error(labels.invalidJson);
          setLocalError(error.message);
          props.onError?.(error);
          return;
        }
      } else {
        editedValue = draft;
      }
    }
    setLocalError(null);
    void surface
      .mutate({
        mutationId: mutation.id,
        rowIndex,
        ...(takesValue ? { editedValue } : {}),
      })
      .then(() => {
        props.onMutationSuccess?.(mutation);
      })
      .catch((error: unknown) => props.onError?.(error));
  };

  return (
    <section className="binding-surface-relations">
      {mutations.map((mutation) => {
        const trigger = mutation.trigger;
        if (trigger.kind !== 'bind' && trigger.kind !== 'unbind' && trigger.kind !== 'rebind') {
          return null;
        }
        const takesValue = mutationUsesEditedValue(mutation);
        const edgeLabel = props.edgeLabels?.[trigger.edgeId] ?? trigger.edgeId;
        return (
          <div key={mutation.id} className="binding-surface-relation-row">
            <span className="binding-surface-relation-name">{edgeLabel}</span>
            {takesValue ? (
              <label>
                <span>{labels.targetValue}</span>
                <input
                  value={drafts[mutation.id] ?? ''}
                  disabled={busy}
                  onChange={(event) =>
                    setDrafts((current) => ({
                      ...current,
                      [mutation.id]: event.target.value,
                    }))
                  }
                />
              </label>
            ) : null}
            <button
              type="button"
              disabled={busy || (takesValue && !(drafts[mutation.id] ?? '').trim())}
              onClick={() => runMutation(mutation)}
            >
              {labels[trigger.kind]}
            </button>
          </div>
        );
      })}
      {localError ? (
        <div className="binding-surface-inline-error" role="alert">
          {localError}
        </div>
      ) : null}
    </section>
  );
}

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type DragEvent,
  type ReactElement,
} from 'react';
import { useDesigner } from '../context/designer-context.js';
import { I18nLocaleRows } from './i18n-locale-rows.js';
import { DesignerSelect } from './base/designer-select.js';
import type { PropObject } from '../types/prop-object.js';
import {
  DataType,
  DESIGNER_PROP_DATA_TYPES,
  dataTypeToEngineCode,
  normalizeLegacyPropType,
  propDataTypeLabelKey,
} from '../config/engine-prop-types.js';
import { resolveI18nForLocale } from '../utils/i18n-resolve.js';
import { filterUniqueNameInput, isValidUniqueName } from '../utils/name-validation.js';

function sortPropsBySort(props: readonly PropObject[]): PropObject[] {
  return [...props].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
}

function reorderProps(list: PropObject[], from: number, to: number): PropObject[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) {
    return list;
  }
  const arr = [...list];
  const [sp] = arr.splice(from, 1);
  arr.splice(to, 0, sp);
  return arr.map((p, i) => ({ ...p, sort: i }));
}

type DraftProp = {
  name: string;
  type: string;
  is_required: boolean;
  name_i18n: Record<string, string>;
  description_i18n: Record<string, string>;
};

function emptyDraft(): DraftProp {
  return {
    name: '',
    type: DataType.String,
    is_required: false,
    name_i18n: {},
    description_i18n: {},
  };
}

function GripIcon(): ReactElement {
  return (
    <svg viewBox="0 0 12 12" className="designer-prop-icon" aria-hidden>
      <circle cx="4" cy="3" r="1" fill="currentColor" />
      <circle cx="8" cy="3" r="1" fill="currentColor" />
      <circle cx="4" cy="6" r="1" fill="currentColor" />
      <circle cx="8" cy="6" r="1" fill="currentColor" />
      <circle cx="4" cy="9" r="1" fill="currentColor" />
      <circle cx="8" cy="9" r="1" fill="currentColor" />
    </svg>
  );
}

function ChevronIcon(props: { expanded: boolean }): ReactElement {
  return (
    <svg viewBox="0 0 12 12" className="designer-prop-icon" aria-hidden>
      <path
        d={props.expanded ? 'M3 7.5 6 4.5 9 7.5' : 'M3 4.5 6 7.5 9 4.5'}
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.4"
      />
    </svg>
  );
}

function TrashIcon(): ReactElement {
  return (
    <svg viewBox="0 0 12 12" className="designer-prop-icon" aria-hidden>
      <path
        d="M3.5 3.5v5.25c0 .41.34.75.75.75h3.5c.41 0 .75-.34.75-.75V3.5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.2"
      />
      <path
        d="M2.75 3.5h6.5M4.5 3.5V2.75h3v.75M5 5.25v2.5M7 5.25v2.5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.2"
      />
    </svg>
  );
}

function LockIcon(props: { unlocked: boolean }): ReactElement {
  return (
    <svg viewBox="0 0 12 12" className="designer-prop-icon" aria-hidden>
      <path
        d="M3.5 5h5a.75.75 0 0 1 .75.75v3a.75.75 0 0 1-.75.75h-5a.75.75 0 0 1-.75-.75v-3A.75.75 0 0 1 3.5 5Z"
        fill="none"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.2"
      />
      {props.unlocked ? (
        <path
          d="M4.25 5V3.9A1.75 1.75 0 0 1 7.3 2.74"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.2"
        />
      ) : (
        <path
          d="M4.25 5V4a1.75 1.75 0 1 1 3.5 0v1"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.2"
        />
      )}
    </svg>
  );
}

function PlusIcon(): ReactElement {
  return (
    <svg viewBox="0 0 12 12" className="designer-prop-icon" aria-hidden>
      <path
        d="M6 2.5v7M2.5 6h7"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.4"
      />
    </svg>
  );
}

export function PropsEditor(props: {
  modelId: string | undefined;
  readOnly?: boolean;
}): ReactElement {
  const { data, i18n, propVault } = useDesigner();
  const readOnly = props.readOnly ?? false;
  const [, bump] = useState(0);
  useEffect(() => data.subscribe(() => bump((n) => n + 1)), [data]);
  const model = props.modelId ? data.models.find((m) => m.id === props.modelId) : undefined;
  const parentModel = model?.parent_id
    ? data.models.find((m) => m.id === model.parent_id)
    : undefined;

  const [unlocked, setUnlocked] = useState<Record<string, boolean>>({});
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  const [draftExpanded, setDraftExpanded] = useState(false);
  const [draft, setDraft] = useState<DraftProp>(emptyDraft);
  const [dragFrom, setDragFrom] = useState<number | null>(null);

  useEffect(() => {
    setDraft(emptyDraft());
    setDragFrom(null);
    setExpandedIds({});
    setDraftExpanded(false);
  }, [model?.id]);

  const inheritedProps = parentModel ? sortPropsBySort(parentModel.props_objects_array) : [];
  const inheritedNames = new Set(inheritedProps.map((p) => p.name));
  const sortedOwn = model
    ? sortPropsBySort(model.props_objects_array).filter((p) => !inheritedNames.has(p.name))
    : [];

  const typeOptions = useMemo(
    () =>
      DESIGNER_PROP_DATA_TYPES.map((t) => ({
        value: t,
        label: i18n.t('engine', propDataTypeLabelKey(t)),
      })),
    [i18n],
  );

  const patchProp = useCallback(
    (pid: string, patch: Partial<PropObject>): void => {
      if (!model) {
        return;
      }
      const next = model.props_objects_array.map((x) => (x.id === pid ? { ...x, ...patch } : x));
      data.updateProps(model.id, next);
    },
    [data, model],
  );

  const removeProp = useCallback(
    (pid: string): void => {
      if (!model) {
        return;
      }
      const next = model.props_objects_array
        .filter((x) => x.id !== pid)
        .map((item, index) => ({ ...item, sort: index }));
      data.updateProps(model.id, next);
      setExpandedIds((prev) => {
        const { [pid]: _removed, ...rest } = prev;
        return rest;
      });
    },
    [data, model],
  );

  const applyReorder = useCallback(
    (from: number, to: number): void => {
      if (!model) {
        return;
      }
      const ordered = sortPropsBySort(model.props_objects_array);
      const next = reorderProps(ordered, from, to);
      data.updateProps(model.id, next);
    },
    [data, model],
  );

  const commitDraft = useCallback((): void => {
    if (!model || !draft.name.trim()) {
      return;
    }
    const ordered = sortPropsBySort(model.props_objects_array);
    const nt = normalizeLegacyPropType(draft.type);
    const newProp: PropObject = {
      id: crypto.randomUUID(),
      name: draft.name.trim(),
      type: nt,
      engine_type: dataTypeToEngineCode(nt),
      name_i18n: { ...draft.name_i18n },
      description_i18n: { ...draft.description_i18n },
      is_primary: ordered.length === 0,
      encrypt_level: 0,
      metadata: {},
      is_required: draft.is_required,
      vault_key: '',
      sort: ordered.length,
    };
    data.updateProps(model.id, [...model.props_objects_array, newProp]);
    setDraft(emptyDraft());
    setDraftExpanded(false);
  }, [data, draft, model]);

  const onDragStartOwn = (e: DragEvent, index: number): void => {
    setDragFrom(index);
    e.dataTransfer.setData('text/plain', String(index));
    e.dataTransfer.effectAllowed = 'move';
  };

  const onDragOverOwn = (e: DragEvent): void => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const onDropOwn = (e: DragEvent, toIndex: number): void => {
    e.preventDefault();
    const from = dragFrom ?? Number(e.dataTransfer.getData('text/plain'));
    setDragFrom(null);
    if (Number.isNaN(from)) {
      return;
    }
    applyReorder(from, toIndex);
  };

  const onDragEndOwn = (): void => {
    setDragFrom(null);
  };

  const isPropDragBlocked = (target: EventTarget | null): boolean => {
    if (!(target instanceof HTMLElement)) {
      return true;
    }
    return Boolean(
      target.closest(
        'input, textarea, button, summary, .designer-switch, .designer-i18n-details, .designer-selectbox',
      ),
    );
  };

  const toggleExpanded = (id: string): void => {
    setExpandedIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  if (!model) {
    return <div style={{ fontSize: 12, color: 'var(--designer-text-muted, #94a3b8)' }}>--</div>;
  }

  const locale = i18n.locale;

  return (
    <div className="designer-prop-layout">
      {parentModel && inheritedProps.length > 0 && (
        <section>
          <h4 className="designer-prop-section-title">{i18n.t('ui', 'propInheritedSection')}</h4>
          <div className="designer-prop-table designer-prop-table--inherited">
            <div className="designer-prop-table__header designer-prop-table__header--readonly">
              <span>{i18n.t('ui', 'propRegistryName')}</span>
              <span>{i18n.t('ui', 'propFieldType')}</span>
              <span>{i18n.t('ui', 'propFieldRequired')}</span>
              <span>{i18n.t('ui', 'propDisplayNameI18n')}</span>
            </div>
            <div className="designer-prop-table__body">
              {inheritedProps.map((p) => (
                <div key={p.id} className="designer-prop-static-row">
                  <span
                    className="designer-prop-static-row__cell designer-prop-static-row__name"
                    data-label={i18n.t('ui', 'propRegistryName')}
                  >
                    {p.name}
                  </span>
                  <span
                    className="designer-prop-static-row__cell"
                    data-label={i18n.t('ui', 'propFieldType')}
                  >
                    {i18n.t('engine', propDataTypeLabelKey(normalizeLegacyPropType(p.type)))}
                  </span>
                  <span
                    className="designer-prop-static-row__cell"
                    data-label={i18n.t('ui', 'propFieldRequired')}
                  >
                    {p.is_required
                      ? i18n.t('ui', 'propRequiredYes')
                      : i18n.t('ui', 'propRequiredNo')}
                  </span>
                  <span
                    className="designer-prop-static-row__cell designer-prop-static-row__meta"
                    data-label={i18n.t('ui', 'propDisplayNameI18n')}
                  >
                    {resolveI18nForLocale(p.name_i18n, locale, '--')}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      <section>
        <h4 className="designer-prop-section-title">
          {i18n.t('ui', 'propOwnSection')}
          <span className="designer-prop-drag-hint">{i18n.t('ui', 'propDragHint')}</span>
        </h4>
        <div className="designer-prop-table">
          <div className="designer-prop-table__header">
            <span>{i18n.t('ui', 'propRegistryName')}</span>
            <span>{i18n.t('ui', 'propFieldType')}</span>
            <span>{i18n.t('ui', 'propFieldRequired')}</span>
            <span>{i18n.t('ui', 'propActions')}</span>
          </div>
          <div className="designer-prop-table__body">
            {sortedOwn.map((p, index) => {
              const locked = propVault.isVaultField(p) && !unlocked[p.id];
              const canDragRow = !readOnly && !locked;
              const pTypeNorm = normalizeLegacyPropType(p.type);
              const expanded = !!expandedIds[p.id];
              const typeUnknown = !(DESIGNER_PROP_DATA_TYPES as readonly string[]).includes(
                pTypeNorm,
              );
              const rowOptions = typeUnknown
                ? [{ value: pTypeNorm, label: pTypeNorm }, ...typeOptions]
                : typeOptions;

              return (
                <div
                  key={p.id}
                  className={[
                    'designer-prop-row',
                    expanded ? 'designer-prop-row--expanded' : '',
                    dragFrom === index ? 'designer-prop-row--dragging' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  draggable={canDragRow}
                  onDragStart={(e) => {
                    if (!canDragRow || isPropDragBlocked(e.target)) {
                      e.preventDefault();
                      return;
                    }
                    onDragStartOwn(e, index);
                  }}
                  onDragEnd={onDragEndOwn}
                  onDragOver={onDragOverOwn}
                  onDrop={(e) => onDropOwn(e, index)}
                >
                  <div
                    className="designer-prop-row__main"
                    onDoubleClick={() => toggleExpanded(p.id)}
                  >
                    <div
                      className="designer-prop-row__cell designer-prop-row__cell--name"
                      data-label={i18n.t('ui', 'propRegistryName')}
                    >
                      {locked ? (
                        <div className="designer-prop-row__lock-note">
                          {i18n.t('ui', 'vaultLocked')} ({propVault.displayHandle(p)})
                        </div>
                      ) : null}
                      <div className="designer-prop-row__name-entry">
                        <button
                          type="button"
                          className="designer-prop-drag-handle"
                          disabled={!canDragRow}
                          tabIndex={-1}
                          aria-label="drag"
                          title={i18n.t('ui', 'propDragHint')}
                        >
                          <GripIcon />
                        </button>
                        <input
                          className="designer-input designer-input--compact"
                          value={p.name}
                          disabled={locked || readOnly}
                          onChange={(e) =>
                            patchProp(p.id, { name: filterUniqueNameInput(e.target.value) })
                          }
                        />
                      </div>
                      {p.name && !isValidUniqueName(p.name) ? (
                        <span className="designer-prop-row__error">
                          {i18n.t('ui', 'nameInvalidFormat')}
                        </span>
                      ) : null}
                    </div>

                    <div
                      className="designer-prop-row__cell designer-prop-row__cell--type"
                      data-label={i18n.t('ui', 'propFieldType')}
                    >
                      <DesignerSelect
                        compact
                        disabled={locked || readOnly}
                        value={pTypeNorm}
                        options={rowOptions}
                        onChange={(next) => {
                          const t = normalizeLegacyPropType(next);
                          patchProp(p.id, { type: t, engine_type: dataTypeToEngineCode(t) });
                        }}
                      />
                    </div>

                    <div
                      className="designer-prop-row__cell designer-prop-row__cell--switch"
                      data-label={i18n.t('ui', 'propFieldRequired')}
                    >
                      <input
                        type="checkbox"
                        className="designer-switch"
                        disabled={locked || readOnly}
                        checked={!!p.is_required}
                        onChange={(e) => patchProp(p.id, { is_required: e.target.checked })}
                      />
                    </div>

                    <div className="designer-prop-row__actions">
                      <button
                        type="button"
                        className="designer-prop-action"
                        onClick={() => toggleExpanded(p.id)}
                        aria-label={
                          expanded ? i18n.t('ui', 'propCollapse') : i18n.t('ui', 'propDetails')
                        }
                        title={
                          expanded ? i18n.t('ui', 'propCollapse') : i18n.t('ui', 'propDetails')
                        }
                      >
                        <ChevronIcon expanded={expanded} />
                      </button>
                      {propVault.isVaultField(p) && !readOnly ? (
                        <button
                          type="button"
                          className="designer-prop-action"
                          onClick={() =>
                            setUnlocked((u) => ({
                              ...u,
                              [p.id]: !u[p.id],
                            }))
                          }
                          aria-label={
                            unlocked[p.id] ? i18n.t('ui', 'propLock') : i18n.t('ui', 'propUnlock')
                          }
                          title={
                            unlocked[p.id] ? i18n.t('ui', 'propLock') : i18n.t('ui', 'propUnlock')
                          }
                        >
                          <LockIcon unlocked={!!unlocked[p.id]} />
                        </button>
                      ) : null}
                      {!readOnly ? (
                        <button
                          type="button"
                          className="designer-prop-action designer-prop-action--danger"
                          onClick={() => removeProp(p.id)}
                          aria-label={i18n.t('ui', 'propDelete')}
                          title={i18n.t('ui', 'propDelete')}
                        >
                          <TrashIcon />
                        </button>
                      ) : null}
                    </div>
                  </div>

                  <div
                    className={[
                      'designer-prop-row__details-shell',
                      expanded ? 'designer-prop-row__details-shell--expanded' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    aria-hidden={!expanded}
                  >
                    <div className="designer-prop-row__details">
                      <div className="designer-prop-row__detail-grid">
                        <I18nLocaleRows
                          disabled={locked || readOnly}
                          summary={i18n.t('ui', 'propDisplayNameI18n')}
                          value={(p.name_i18n as Record<string, string> | undefined) ?? {}}
                          onCommit={(next) => patchProp(p.id, { name_i18n: next })}
                          pickLocaleLabel={i18n.t('ui', 'i18nPickLocale')}
                          addRowHint={i18n.t('ui', 'i18nAddLocaleFill')}
                        />
                        <I18nLocaleRows
                          disabled={locked || readOnly}
                          multiline
                          summary={i18n.t('ui', 'propFieldDescription')}
                          value={(p.description_i18n as Record<string, string> | undefined) ?? {}}
                          onCommit={(next) => patchProp(p.id, { description_i18n: next })}
                          pickLocaleLabel={i18n.t('ui', 'i18nPickLocale')}
                          addRowHint={i18n.t('ui', 'i18nAddLocaleFill')}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}

            {!readOnly ? (
              <div
                className={[
                  'designer-prop-row',
                  'designer-prop-row--draft',
                  draftExpanded ? 'designer-prop-row--expanded' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <div
                  className="designer-prop-row__main"
                  onDoubleClick={() => setDraftExpanded((prev) => !prev)}
                >
                  <div
                    className="designer-prop-row__cell designer-prop-row__cell--name"
                    data-label={i18n.t('ui', 'propRegistryName')}
                  >
                    <div className="designer-prop-row__name-entry designer-prop-row__name-entry--draft">
                      <span className="designer-prop-draft-badge">
                        {i18n.t('ui', 'propNewField')}
                      </span>
                      <input
                        className="designer-input designer-input--compact"
                        placeholder={i18n.t('ui', 'propRegistryNameHint')}
                        value={draft.name}
                        onChange={(e) =>
                          setDraft((d) => ({ ...d, name: filterUniqueNameInput(e.target.value) }))
                        }
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            commitDraft();
                          }
                        }}
                      />
                    </div>
                    {draft.name && !isValidUniqueName(draft.name) ? (
                      <span className="designer-prop-row__error">
                        {i18n.t('ui', 'nameInvalidFormat')}
                      </span>
                    ) : null}
                  </div>

                  <div
                    className="designer-prop-row__cell designer-prop-row__cell--type"
                    data-label={i18n.t('ui', 'propFieldType')}
                  >
                    <DesignerSelect
                      compact
                      value={normalizeLegacyPropType(draft.type)}
                      options={typeOptions}
                      onChange={(next) => setDraft((d) => ({ ...d, type: next }))}
                    />
                  </div>

                  <div
                    className="designer-prop-row__cell designer-prop-row__cell--switch"
                    data-label={i18n.t('ui', 'propFieldRequired')}
                  >
                    <input
                      type="checkbox"
                      className="designer-switch"
                      checked={draft.is_required}
                      onChange={(e) => setDraft((d) => ({ ...d, is_required: e.target.checked }))}
                    />
                  </div>

                  <div className="designer-prop-row__actions">
                    <button
                      type="button"
                      className="designer-prop-action"
                      onClick={() => setDraftExpanded((prev) => !prev)}
                      aria-label={
                        draftExpanded ? i18n.t('ui', 'propCollapse') : i18n.t('ui', 'propDetails')
                      }
                      title={
                        draftExpanded ? i18n.t('ui', 'propCollapse') : i18n.t('ui', 'propDetails')
                      }
                    >
                      <ChevronIcon expanded={draftExpanded} />
                    </button>
                    <button
                      type="button"
                      className="designer-prop-action designer-prop-action--primary"
                      onClick={() => commitDraft()}
                      aria-label={i18n.t('ui', 'propAddField')}
                      title={i18n.t('ui', 'propAddField')}
                    >
                      <PlusIcon />
                    </button>
                  </div>
                </div>

                <div
                  className={[
                    'designer-prop-row__details-shell',
                    draftExpanded ? 'designer-prop-row__details-shell--expanded' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  aria-hidden={!draftExpanded}
                >
                  <div className="designer-prop-row__details">
                    <div className="designer-prop-row__detail-grid">
                      <I18nLocaleRows
                        disabled={false}
                        summary={i18n.t('ui', 'propDisplayNameI18n')}
                        value={draft.name_i18n}
                        onCommit={(next) => setDraft((d) => ({ ...d, name_i18n: next }))}
                        pickLocaleLabel={i18n.t('ui', 'i18nPickLocale')}
                        addRowHint={i18n.t('ui', 'i18nAddLocaleFill')}
                      />
                      <I18nLocaleRows
                        disabled={false}
                        multiline
                        summary={i18n.t('ui', 'propFieldDescription')}
                        value={draft.description_i18n}
                        onCommit={(next) => setDraft((d) => ({ ...d, description_i18n: next }))}
                        pickLocaleLabel={i18n.t('ui', 'i18nPickLocale')}
                        addRowHint={i18n.t('ui', 'i18nAddLocaleFill')}
                      />
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}

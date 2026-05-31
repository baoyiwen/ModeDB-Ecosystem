import { useCallback, useEffect, useState, type DragEvent, type ReactElement } from 'react';
import { useDesigner } from '../context/designer-context.js';
import { I18nLocaleRows } from './i18n-locale-rows.js';
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
  const [draft, setDraft] = useState<DraftProp>(emptyDraft);
  const [dragFrom, setDragFrom] = useState<number | null>(null);

  useEffect(() => {
    setDraft(emptyDraft());
    setDragFrom(null);
  }, [model?.id]);

  const inheritedProps = parentModel ? sortPropsBySort(parentModel.props_objects_array) : [];
  const sortedOwn = model ? sortPropsBySort(model.props_objects_array) : [];

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
        'input, textarea, select, button, summary, .designer-switch, .designer-i18n-details',
      ),
    );
  };

  if (!model) {
    return <div style={{ fontSize: 12, color: 'var(--designer-text-muted, #94a3b8)' }}>—</div>;
  }

  const locale = i18n.locale;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {parentModel && inheritedProps.length > 0 && (
        <section>
          <h4 className="designer-prop-section-title">{i18n.t('ui', 'propInheritedSection')}</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {inheritedProps.map((p) => (
              <div key={p.id} className="designer-prop-card designer-prop-card--inherited">
                <div className="designer-prop-inherited-grid">
                  <span className="designer-field-label">{i18n.t('ui', 'propRegistryName')}</span>
                  <span className="designer-prop-inherited-value">{p.name}</span>
                  <span className="designer-field-label">
                    {i18n.t('ui', 'propDisplayNameI18n')}
                  </span>
                  <span className="designer-prop-inherited-value">
                    {resolveI18nForLocale(p.name_i18n, locale, '—')}
                  </span>
                  <span className="designer-field-label">{i18n.t('ui', 'propFieldType')}</span>
                  <span className="designer-prop-inherited-value">
                    {normalizeLegacyPropType(p.type)}
                  </span>
                  <span className="designer-field-label">
                    {i18n.t('ui', 'propFieldDescription')}
                  </span>
                  <span className="designer-prop-inherited-value">
                    {resolveI18nForLocale(p.description_i18n, locale, '—')}
                  </span>
                  <span className="designer-field-label">{i18n.t('ui', 'propFieldRequired')}</span>
                  <span className="designer-prop-inherited-value">
                    {p.is_required
                      ? i18n.t('ui', 'propRequiredYes')
                      : i18n.t('ui', 'propRequiredNo')}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h4 className="designer-prop-section-title">
          {i18n.t('ui', 'propOwnSection')}
          <span className="designer-prop-drag-hint">{i18n.t('ui', 'propDragHint')}</span>
        </h4>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {sortedOwn.map((p, index) => {
            const locked = propVault.isVaultField(p) && !unlocked[p.id];
            const canDragCard = !readOnly && !locked;
            const pTypeNorm = normalizeLegacyPropType(p.type);
            const typeUnknown = !(DESIGNER_PROP_DATA_TYPES as readonly string[]).includes(
              pTypeNorm,
            );
            return (
              <div
                key={p.id}
                className="designer-prop-card designer-prop-card--own"
                draggable={canDragCard}
                data-dragging={dragFrom === index ? 'true' : undefined}
                onDragStart={(e) => {
                  if (!canDragCard || isPropDragBlocked(e.target)) {
                    e.preventDefault();
                    return;
                  }
                  onDragStartOwn(e, index);
                }}
                onDragEnd={onDragEndOwn}
                onDragOver={onDragOverOwn}
                onDrop={(e) => onDropOwn(e, index)}
              >
                {locked && (
                  <div style={{ fontSize: 11, color: 'var(--designer-text-muted, #94a3b8)' }}>
                    {i18n.t('ui', 'vaultLocked')} ({propVault.displayHandle(p)})
                  </div>
                )}

                <label className="designer-field">
                  <span className="designer-field-label">{i18n.t('ui', 'propRegistryName')}</span>
                  <input
                    className="designer-input"
                    value={p.name}
                    disabled={locked || readOnly}
                    onChange={(e) =>
                      patchProp(p.id, { name: filterUniqueNameInput(e.target.value) })
                    }
                  />
                  {p.name && !isValidUniqueName(p.name) ? (
                    <span style={{ fontSize: 11, color: '#dc2626', marginTop: 4 }}>
                      {i18n.t('ui', 'nameInvalidFormat')}
                    </span>
                  ) : null}
                </label>

                <I18nLocaleRows
                  disabled={locked || readOnly}
                  summary={i18n.t('ui', 'propDisplayNameI18n')}
                  value={(p.name_i18n as Record<string, string> | undefined) ?? {}}
                  onCommit={(next) => patchProp(p.id, { name_i18n: next })}
                  pickLocaleLabel={i18n.t('ui', 'i18nPickLocale')}
                  addRowHint={i18n.t('ui', 'i18nAddLocaleFill')}
                />

                <label className="designer-field">
                  <span className="designer-field-label">{i18n.t('ui', 'propFieldType')}</span>
                  <select
                    className="designer-select"
                    disabled={locked || readOnly}
                    value={pTypeNorm}
                    onChange={(e) => {
                      const t = normalizeLegacyPropType(e.target.value);
                      patchProp(p.id, { type: t, engine_type: dataTypeToEngineCode(t) });
                    }}
                  >
                    {typeUnknown ? <option value={pTypeNorm}>{pTypeNorm}</option> : null}
                    {DESIGNER_PROP_DATA_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {i18n.t('engine', propDataTypeLabelKey(t))}
                      </option>
                    ))}
                  </select>
                </label>

                <I18nLocaleRows
                  disabled={locked || readOnly}
                  multiline
                  summary={i18n.t('ui', 'propFieldDescription')}
                  value={(p.description_i18n as Record<string, string> | undefined) ?? {}}
                  onCommit={(next) => patchProp(p.id, { description_i18n: next })}
                  pickLocaleLabel={i18n.t('ui', 'i18nPickLocale')}
                  addRowHint={i18n.t('ui', 'i18nAddLocaleFill')}
                />

                <label className="designer-switch-row">
                  <span className="designer-field-label">{i18n.t('ui', 'propFieldRequired')}</span>
                  <input
                    type="checkbox"
                    className="designer-switch"
                    disabled={locked || readOnly}
                    checked={!!p.is_required}
                    onChange={(e) => patchProp(p.id, { is_required: e.target.checked })}
                  />
                </label>

                {propVault.isVaultField(p) && !readOnly && (
                  <button
                    type="button"
                    className="designer-btn"
                    style={{ fontSize: 11, alignSelf: 'flex-start', padding: '6px 12px' }}
                    onClick={() =>
                      setUnlocked((u) => ({
                        ...u,
                        [p.id]: !u[p.id],
                      }))
                    }
                  >
                    {unlocked[p.id] ? 'Lock' : 'Unlock (dev)'}
                  </button>
                )}
              </div>
            );
          })}

          {!readOnly && (
            <div className="designer-prop-card designer-prop-card--draft">
              <span className="designer-prop-draft-badge">{i18n.t('ui', 'propNewField')}</span>
              <label className="designer-field">
                <span className="designer-field-label">{i18n.t('ui', 'propRegistryName')}</span>
                <input
                  className="designer-input"
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
              </label>

              <I18nLocaleRows
                disabled={false}
                summary={i18n.t('ui', 'propDisplayNameI18n')}
                value={draft.name_i18n}
                onCommit={(next) => setDraft((d) => ({ ...d, name_i18n: next }))}
                pickLocaleLabel={i18n.t('ui', 'i18nPickLocale')}
                addRowHint={i18n.t('ui', 'i18nAddLocaleFill')}
              />

              <label className="designer-field">
                <span className="designer-field-label">{i18n.t('ui', 'propFieldType')}</span>
                <select
                  className="designer-select"
                  value={normalizeLegacyPropType(draft.type)}
                  onChange={(e) => setDraft((d) => ({ ...d, type: e.target.value }))}
                >
                  {DESIGNER_PROP_DATA_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {i18n.t('engine', propDataTypeLabelKey(t))}
                    </option>
                  ))}
                </select>
              </label>

              <I18nLocaleRows
                disabled={false}
                multiline
                summary={i18n.t('ui', 'propFieldDescription')}
                value={draft.description_i18n}
                onCommit={(next) => setDraft((d) => ({ ...d, description_i18n: next }))}
                pickLocaleLabel={i18n.t('ui', 'i18nPickLocale')}
                addRowHint={i18n.t('ui', 'i18nAddLocaleFill')}
              />

              <label className="designer-switch-row">
                <span className="designer-field-label">{i18n.t('ui', 'propFieldRequired')}</span>
                <input
                  type="checkbox"
                  className="designer-switch"
                  checked={draft.is_required}
                  onChange={(e) => setDraft((d) => ({ ...d, is_required: e.target.checked }))}
                />
              </label>

              <button
                type="button"
                className="designer-btn designer-btn-primary"
                onClick={() => commitDraft()}
              >
                {i18n.t('ui', 'propAddField')}
              </button>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

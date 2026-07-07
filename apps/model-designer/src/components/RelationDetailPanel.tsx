import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { useDesigner } from '../context/designer-context.js';
import { I18nLocaleRows } from './i18n-locale-rows.js';
import { resolveModelDisplayName } from '../utils/i18n-resolve.js';
import { isValidUniqueName, filterUniqueNameInput } from '../utils/name-validation.js';
import { isInheritRelation } from '../config/graph-edge-kinds.js';
import {
  RELATION_CARDINALITY_MANY,
  RELATION_CARDINALITY_ONE,
  type RelationCardinality,
} from '../config/relation-cardinality.js';
import {
  relationNamesUsedInScope,
  relationSourceCardinality,
  relationTargetCardinality,
} from '../utils/relation-identity.js';
import { collectLayerPages } from '../utils/layer-tree-pages.js';
import { DesignerSelect } from './base/designer-select.js';

function CardinalitySwitch(props: {
  label: string;
  value: RelationCardinality;
  disabled: boolean;
  onChange: (value: RelationCardinality) => void;
}): ReactElement {
  return (
    <div className="designer-relation-cardinality-side">
      <span className="designer-field-label">{props.label}</span>
      <div className="designer-cardinality-switch" role="group" aria-label={props.label}>
        <button
          type="button"
          className={`designer-cardinality-switch__btn${props.value === RELATION_CARDINALITY_ONE ? ' designer-cardinality-switch__btn--active' : ''}`}
          disabled={props.disabled}
          onClick={() => props.onChange(RELATION_CARDINALITY_ONE)}
        >
          1
        </button>
        <button
          type="button"
          className={`designer-cardinality-switch__btn${props.value === RELATION_CARDINALITY_MANY ? ' designer-cardinality-switch__btn--active' : ''}`}
          disabled={props.disabled}
          onClick={() => props.onChange(RELATION_CARDINALITY_MANY)}
        >
          N
        </button>
      </div>
    </div>
  );
}

export function RelationDetailPanel(props: {
  relationId: string;
  readOnly?: boolean;
}): ReactElement {
  const { data, i18n } = useDesigner();
  const readOnly = props.readOnly ?? false;
  const [, bump] = useState(0);
  useEffect(() => data.subscribe(() => bump((n) => n + 1)), [data]);

  const rel = data.relations.find((r) => r.id === props.relationId);
  const srcModel = rel ? data.models.find((m) => m.id === rel.source_model_id) : undefined;
  const tgtModel = rel ? data.models.find((m) => m.id === rel.target_model_id) : undefined;
  const srcName = srcModel
    ? resolveModelDisplayName(srcModel, i18n.locale)
    : (rel?.source_model_id ?? '');
  const tgtName = tgtModel
    ? resolveModelDisplayName(tgtModel, i18n.locale)
    : (rel?.target_model_id ?? '');

  const usedNames = useMemo(() => {
    if (!rel) {
      return new Set<string>();
    }
    return relationNamesUsedInScope(
      data.relations,
      rel.source_model_id,
      rel.target_model_id,
      rel.id,
    );
  }, [data.relations, rel]);

  const pages = useMemo(() => collectLayerPages(data.layerTreeRoots), [data.layerTreeRoots]);
  const assignedLayerIds = rel ? [...data.getLayersForRelation(rel.id)] : [];
  const primaryPageId = assignedLayerIds[0] ?? '';
  const pageOptions = useMemo(
    () => [
      { value: '', label: i18n.t('ui', 'layerPageNone') },
      ...pages.map((page) => ({ value: page.id, label: `${page.label} (${page.id})` })),
    ],
    [i18n, pages],
  );

  const [forwardDraft, setForwardDraft] = useState<string>(rel?.forward_name ?? '');
  const [reverseDraft, setReverseDraft] = useState<string>(rel?.reverse_name ?? '');
  useEffect(() => {
    setForwardDraft(rel?.forward_name ?? '');
    setReverseDraft(rel?.reverse_name ?? '');
  }, [rel?.id, rel?.forward_name, rel?.reverse_name]);

  if (!rel) {
    return <div style={{ fontSize: 12, color: '#64748b' }}>-</div>;
  }

  const relMeta = data.getRelationCanvasMeta(rel.id);
  const isInherit = isInheritRelation(rel.kind);

  const forwardErr =
    forwardDraft && !isValidUniqueName(forwardDraft)
      ? i18n.t('ui', 'nameInvalidFormat')
      : forwardDraft && (usedNames.has(forwardDraft) || forwardDraft === reverseDraft)
        ? i18n.t('ui', 'nameInvalidDuplicate')
        : '';
  const reverseErr =
    reverseDraft && !isValidUniqueName(reverseDraft)
      ? i18n.t('ui', 'nameInvalidFormat')
      : reverseDraft && (usedNames.has(reverseDraft) || reverseDraft === forwardDraft)
        ? i18n.t('ui', 'nameInvalidDuplicate')
        : '';

  const commitForward = (): void => {
    if (!forwardErr && forwardDraft && forwardDraft !== rel.forward_name) {
      data.updateRelation(rel.id, { forward_name: forwardDraft });
    } else {
      setForwardDraft(rel.forward_name ?? '');
    }
  };
  const commitReverse = (): void => {
    if (!reverseErr && reverseDraft && reverseDraft !== rel.reverse_name) {
      data.updateRelation(rel.id, { reverse_name: reverseDraft });
    } else {
      setReverseDraft(rel.reverse_name ?? '');
    }
  };

  if (isInherit) {
    const inheritErr =
      forwardDraft && !isValidUniqueName(forwardDraft)
        ? i18n.t('ui', 'nameInvalidFormat')
        : forwardDraft && usedNames.has(forwardDraft)
          ? i18n.t('ui', 'nameInvalidDuplicate')
          : '';
    const commitInherit = (): void => {
      if (!inheritErr && forwardDraft && forwardDraft !== rel.forward_name) {
        data.updateRelation(rel.id, { forward_name: forwardDraft });
      } else {
        setForwardDraft(rel.forward_name ?? '');
      }
    };
    return (
      <div className="designer-relation-detail">
        <div className="designer-relation-summary designer-glass-inset">
          <span className="designer-field-label">{i18n.t('ui', 'inheritRelationSection')}</span>
          <div className="designer-relation-summary__pair">
            <strong>{srcName}</strong>
            <span>{'->'}</span>
            <strong>{tgtName}</strong>
          </div>
        </div>
        <label className="designer-field">
          <span className="designer-field-label">{i18n.t('ui', 'inheritRelationName')}</span>
          <input
            className="designer-input"
            disabled={readOnly}
            value={forwardDraft}
            onChange={(e) => setForwardDraft(filterUniqueNameInput(e.target.value))}
            onBlur={commitInherit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
          />
          {inheritErr ? <span className="designer-field-error">{inheritErr}</span> : null}
        </label>
        <I18nLocaleRows
          disabled={readOnly}
          summary={i18n.t('ui', 'inheritRelationDisplayName')}
          value={(rel.forward_name_i18n as Record<string, string> | undefined) ?? {}}
          onCommit={(next) => data.updateRelation(rel.id, { forward_name_i18n: next })}
          pickLocaleLabel={i18n.t('ui', 'i18nPickLocale')}
          addRowHint={i18n.t('ui', 'i18nAddLocaleFill')}
        />
        <I18nLocaleRows
          disabled={readOnly}
          multiline
          summary={i18n.t('ui', 'relationPanelDescription')}
          value={(rel.description_i18n as Record<string, string> | undefined) ?? {}}
          onCommit={(next) => data.updateRelation(rel.id, { description_i18n: next })}
          pickLocaleLabel={i18n.t('ui', 'i18nPickLocale')}
          addRowHint={i18n.t('ui', 'i18nAddLocaleFill')}
        />
        <label className="designer-switch-row">
          <span className="designer-field-label">{i18n.t('ui', 'relationPositionLock')}</span>
          <input
            type="checkbox"
            className="designer-switch"
            disabled={readOnly}
            checked={!!relMeta.locked}
            onChange={(e) => data.patchRelationCanvasMeta(rel.id, { locked: e.target.checked })}
          />
        </label>
      </div>
    );
  }

  const sourceCardinality = relationSourceCardinality(rel);
  const targetCardinality = relationTargetCardinality(rel);

  return (
    <div className="designer-relation-detail">
      <div className="designer-relation-summary designer-glass-inset">
        <span className="designer-field-label">{i18n.t('ui', 'relationDirectionPair')}</span>
        <div className="designer-relation-summary__pair">
          <strong>{srcName}</strong>
          <span>{'<->'}</span>
          <strong>{tgtName}</strong>
        </div>
      </div>

      <div className="designer-field">
        <span className="designer-field-label">{i18n.t('ui', 'sysModelLayerPage')}</span>
        <DesignerSelect
          compact
          searchable
          disabled={readOnly}
          value={primaryPageId}
          options={pageOptions}
          searchPlaceholder={i18n.t('ui', 'layerPageFilter')}
          emptyLabel={i18n.t('ui', 'layerPageEmpty')}
          onChange={(value) => {
            if (!value) {
              data.assignRelationToLayers(rel.id, []);
            } else {
              data.assignRelationToPage(rel.id, value);
            }
          }}
        />
      </div>

      <label className="designer-switch-row designer-relation-policy-row">
        <span className="designer-switch-row__copy">
          <span className="designer-field-label">{i18n.t('ui', 'relationSelfLoopPolicy')}</span>
          <small>{i18n.t('ui', 'relationSelfLoopPolicyHint')}</small>
        </span>
        <input
          type="checkbox"
          className="designer-switch"
          disabled={readOnly}
          checked={rel.self_loop_policy === 'allow'}
          onChange={(e) =>
            data.updateRelation(rel.id, { self_loop_policy: e.target.checked ? 'allow' : 'deny' })
          }
        />
      </label>

      <div className="designer-relation-basic-stack">
        <fieldset className="designer-relation-side designer-glass-inset">
          <legend>{i18n.t('ui', 'relationForwardSection')}</legend>
          <div className="designer-relation-side__path">
            {srcName} {'->'} {tgtName}
          </div>
          <label className="designer-field">
            <span className="designer-field-label">{i18n.t('ui', 'relationForwardName')}</span>
            <input
              className="designer-input"
              disabled={readOnly}
              value={forwardDraft}
              onChange={(e) => setForwardDraft(filterUniqueNameInput(e.target.value))}
              onBlur={commitForward}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
            />
            {forwardErr ? <span className="designer-field-error">{forwardErr}</span> : null}
          </label>
          <I18nLocaleRows
            disabled={readOnly}
            summary={i18n.t('ui', 'relationForwardDisplayName')}
            value={(rel.forward_name_i18n as Record<string, string> | undefined) ?? {}}
            onCommit={(next) => data.updateRelation(rel.id, { forward_name_i18n: next })}
            pickLocaleLabel={i18n.t('ui', 'i18nPickLocale')}
            addRowHint={i18n.t('ui', 'i18nAddLocaleFill')}
          />
          <I18nLocaleRows
            disabled={readOnly}
            multiline
            summary={i18n.t('ui', 'relationForwardDescription')}
            value={
              (rel.forward_description_i18n as Record<string, string> | undefined) ??
              (rel.description_i18n as Record<string, string> | undefined) ??
              {}
            }
            onCommit={(next) => data.updateRelation(rel.id, { forward_description_i18n: next })}
            pickLocaleLabel={i18n.t('ui', 'i18nPickLocale')}
            addRowHint={i18n.t('ui', 'i18nAddLocaleFill')}
          />
          <CardinalitySwitch
            label={i18n.t('ui', 'relationCardinalityLabel')}
            value={sourceCardinality}
            disabled={readOnly}
            onChange={(value) =>
              data.updateRelation(rel.id, {
                source_cardinality: value,
                self_cardinality:
                  value === RELATION_CARDINALITY_MANY &&
                  targetCardinality === RELATION_CARDINALITY_ONE
                    ? RELATION_CARDINALITY_ONE
                    : targetCardinality,
              })
            }
          />
        </fieldset>

        <fieldset className="designer-relation-side designer-glass-inset">
          <legend>{i18n.t('ui', 'relationReverseSection')}</legend>
          <div className="designer-relation-side__path">
            {tgtName} {'->'} {srcName}
          </div>
          <label className="designer-field">
            <span className="designer-field-label">{i18n.t('ui', 'relationReverseName')}</span>
            <input
              className="designer-input"
              disabled={readOnly}
              value={reverseDraft}
              onChange={(e) => setReverseDraft(filterUniqueNameInput(e.target.value))}
              onBlur={commitReverse}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
            />
            {reverseErr ? <span className="designer-field-error">{reverseErr}</span> : null}
          </label>
          <I18nLocaleRows
            disabled={readOnly}
            summary={i18n.t('ui', 'relationReverseDisplayName')}
            value={(rel.reverse_name_i18n as Record<string, string> | undefined) ?? {}}
            onCommit={(next) => data.updateRelation(rel.id, { reverse_name_i18n: next })}
            pickLocaleLabel={i18n.t('ui', 'i18nPickLocale')}
            addRowHint={i18n.t('ui', 'i18nAddLocaleFill')}
          />
          <I18nLocaleRows
            disabled={readOnly}
            multiline
            summary={i18n.t('ui', 'relationReverseDescription')}
            value={
              (rel.reverse_description_i18n as Record<string, string> | undefined) ??
              (rel.description_i18n as Record<string, string> | undefined) ??
              {}
            }
            onCommit={(next) => data.updateRelation(rel.id, { reverse_description_i18n: next })}
            pickLocaleLabel={i18n.t('ui', 'i18nPickLocale')}
            addRowHint={i18n.t('ui', 'i18nAddLocaleFill')}
          />
          <CardinalitySwitch
            label={i18n.t('ui', 'relationCardinalityLabel')}
            value={targetCardinality}
            disabled={readOnly}
            onChange={(value) =>
              data.updateRelation(rel.id, {
                target_cardinality: value,
                self_cardinality:
                  sourceCardinality === RELATION_CARDINALITY_MANY &&
                  value === RELATION_CARDINALITY_ONE
                    ? RELATION_CARDINALITY_ONE
                    : value,
              })
            }
          />
        </fieldset>
      </div>

      <label className="designer-switch-row">
        <span className="designer-field-label">{i18n.t('ui', 'relationPositionLock')}</span>
        <input
          type="checkbox"
          className="designer-switch"
          disabled={readOnly}
          checked={!!relMeta.locked}
          onChange={(e) => data.patchRelationCanvasMeta(rel.id, { locked: e.target.checked })}
        />
      </label>
    </div>
  );
}

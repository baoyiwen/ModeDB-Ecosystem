import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { useDesigner } from '../context/designer-context.js';
import { I18nLocaleRows } from './i18n-locale-rows.js';
import { resolveModelDisplayName } from '../utils/i18n-resolve.js';
import { isValidUniqueName, filterUniqueNameInput } from '../utils/name-validation.js';
import { isInheritRelation } from '../config/graph-edge-kinds.js';
import {
  isManyToOneCardinality,
  RELATION_CARDINALITY_MANY,
  RELATION_CARDINALITY_ONE,
} from '../config/relation-cardinality.js';

/**
 * 关系详情面板。关系**永远成对**：
 * - **正向**：source → target，唯一名 `forward_name`，展示名 `forward_name_i18n`。
 * - **逆向**：target → source，唯一名 `reverse_name`，展示名 `reverse_name_i18n`。
 *
 * 源/目标模型名称按"显示名优先、回退唯一名"渲染（与画布一致，见 `resolveModelDisplayName`）。
 * 唯一名输入受 `UNIQUE_NAME_RE` 校验（英文字母数字下划线连字符），不通过时仅警告不阻止编辑，
 * 但 commit 时若两侧名重复（含与其他关系冲突）会被驳回保留旧值，避免破坏成对约定。
 */
export function RelationDetailPanel(props: {
  relationId: string;
  readOnly?: boolean;
}): ReactElement {
  const { data, i18n } = useDesigner();
  const readOnly = props.readOnly ?? false;
  const [, bump] = useState(0);
  useEffect(() => data.subscribe(() => bump((n) => n + 1)), [data]);

  const rel = data.relations.find((r) => r.id === props.relationId);

  // 在 effect / hook 之后做空值兜底，避免顶层 early return 影响 Hooks 顺序。
  const srcModel = rel ? data.models.find((m) => m.id === rel.source_model_id) : undefined;
  const tgtModel = rel ? data.models.find((m) => m.id === rel.target_model_id) : undefined;
  const srcName = srcModel
    ? resolveModelDisplayName(srcModel, i18n.locale)
    : (rel?.source_model_id ?? '');
  const tgtName = tgtModel
    ? resolveModelDisplayName(tgtModel, i18n.locale)
    : (rel?.target_model_id ?? '');

  // 跨关系的 forward/reverse 已占用名集合（排除当前关系自身的两侧）。
  const usedNames = useMemo(() => {
    const set = new Set<string>();
    for (const r of data.relations) {
      if (rel && r.id === rel.id) continue;
      if (r.forward_name) set.add(r.forward_name);
      if (r.reverse_name) set.add(r.reverse_name);
    }
    return set;
  }, [data.relations, rel]);

  const [forwardDraft, setForwardDraft] = useState<string>(rel?.forward_name ?? '');
  const [reverseDraft, setReverseDraft] = useState<string>(rel?.reverse_name ?? '');
  const [editingDirection, setEditingDirection] = useState<'forward' | 'reverse'>('forward');
  useEffect(() => {
    setForwardDraft(rel?.forward_name ?? '');
    setReverseDraft(rel?.reverse_name ?? '');
  }, [rel?.id, rel?.forward_name, rel?.reverse_name]);
  useEffect(() => {
    setEditingDirection('forward');
  }, [rel?.id]);

  if (!rel) {
    return <div style={{ fontSize: 12, color: '#64748b' }}>—</div>;
  }

  const relMeta = data.getRelationCanvasMeta(rel.id);
  const isInherit = isInheritRelation(rel.kind);

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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, fontSize: 12 }}>
        <div
          className="designer-glass-inset"
          style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}
        >
          <span className="designer-field-label">{i18n.t('ui', 'inheritRelationSection')}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <strong style={{ fontWeight: 650 }}>{srcName}</strong>
            <span style={{ color: '#94a3b8' }}>→</span>
            <strong style={{ fontWeight: 650 }}>{tgtName}</strong>
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
          {inheritErr ? (
            <span style={{ fontSize: 11, color: '#dc2626', marginTop: 4 }}>{inheritErr}</span>
          ) : null}
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, fontSize: 12 }}>
      <div
        className="designer-glass-inset"
        style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}
      >
        <span className="designer-field-label">{i18n.t('ui', 'relationDirectionPair')}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <strong style={{ fontWeight: 650 }}>{srcName}</strong>
          <span style={{ color: '#94a3b8' }}>⇄</span>
          <strong style={{ fontWeight: 650 }}>{tgtName}</strong>
        </div>
        <div
          className="designer-direction-switch"
          role="tablist"
          aria-label={i18n.t('ui', 'relationDirectionPair')}
        >
          <button
            type="button"
            role="tab"
            aria-selected={editingDirection === 'forward'}
            className={`designer-direction-switch__btn${editingDirection === 'forward' ? ' designer-direction-switch__btn--active' : ''}`}
            disabled={readOnly}
            onClick={() => setEditingDirection('forward')}
          >
            {i18n.t('ui', 'relationForwardSection')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={editingDirection === 'reverse'}
            className={`designer-direction-switch__btn${editingDirection === 'reverse' ? ' designer-direction-switch__btn--active' : ''}`}
            disabled={readOnly}
            onClick={() => setEditingDirection('reverse')}
          >
            {i18n.t('ui', 'relationReverseSection')}
          </button>
        </div>
      </div>

      {editingDirection === 'forward' ? (
        <fieldset
          className="designer-glass-inset"
          style={{
            padding: '10px 12px',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            border: 0,
          }}
        >
          <legend className="designer-field-label" style={{ padding: '0 4px' }}>
            {srcName} → {tgtName}
          </legend>
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
            {forwardErr ? (
              <span style={{ fontSize: 11, color: '#dc2626', marginTop: 4 }}>{forwardErr}</span>
            ) : null}
          </label>
          <I18nLocaleRows
            disabled={readOnly}
            summary={i18n.t('ui', 'relationForwardDisplayName')}
            value={(rel.forward_name_i18n as Record<string, string> | undefined) ?? {}}
            onCommit={(next) => data.updateRelation(rel.id, { forward_name_i18n: next })}
            pickLocaleLabel={i18n.t('ui', 'i18nPickLocale')}
            addRowHint={i18n.t('ui', 'i18nAddLocaleFill')}
          />
        </fieldset>
      ) : (
        <fieldset
          className="designer-glass-inset"
          style={{
            padding: '10px 12px',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            border: 0,
          }}
        >
          <legend className="designer-field-label" style={{ padding: '0 4px' }}>
            {tgtName} → {srcName}
          </legend>
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
            {reverseErr ? (
              <span style={{ fontSize: 11, color: '#dc2626', marginTop: 4 }}>{reverseErr}</span>
            ) : null}
          </label>
          <I18nLocaleRows
            disabled={readOnly}
            summary={i18n.t('ui', 'relationReverseDisplayName')}
            value={(rel.reverse_name_i18n as Record<string, string> | undefined) ?? {}}
            onCommit={(next) => data.updateRelation(rel.id, { reverse_name_i18n: next })}
            pickLocaleLabel={i18n.t('ui', 'i18nPickLocale')}
            addRowHint={i18n.t('ui', 'i18nAddLocaleFill')}
          />
        </fieldset>
      )}

      <I18nLocaleRows
        disabled={false}
        multiline
        summary={i18n.t('ui', 'relationPanelDescription')}
        value={(rel.description_i18n as Record<string, string> | undefined) ?? {}}
        onCommit={(next) => data.updateRelation(rel.id, { description_i18n: next })}
        pickLocaleLabel={i18n.t('ui', 'i18nPickLocale')}
        addRowHint={i18n.t('ui', 'i18nAddLocaleFill')}
      />

      <div
        className="designer-glass-inset"
        style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}
      >
        <span className="designer-field-label">{i18n.t('ui', 'relationCardinalityLabel')}</span>
        <div
          className="designer-direction-switch"
          role="tablist"
          aria-label={i18n.t('ui', 'relationCardinalityLabel')}
        >
          <button
            type="button"
            role="tab"
            aria-selected={!isManyToOneCardinality(rel.self_cardinality)}
            className={`designer-direction-switch__btn${!isManyToOneCardinality(rel.self_cardinality) ? ' designer-direction-switch__btn--active' : ''}`}
            disabled={readOnly}
            onClick={() =>
              data.updateRelation(rel.id, { self_cardinality: RELATION_CARDINALITY_MANY })
            }
          >
            {i18n.t('ui', 'relationCardinalityOneToMany')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={isManyToOneCardinality(rel.self_cardinality)}
            className={`designer-direction-switch__btn${isManyToOneCardinality(rel.self_cardinality) ? ' designer-direction-switch__btn--active' : ''}`}
            disabled={readOnly}
            onClick={() =>
              data.updateRelation(rel.id, { self_cardinality: RELATION_CARDINALITY_ONE })
            }
          >
            {i18n.t('ui', 'relationCardinalityManyToOne')}
          </button>
        </div>
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

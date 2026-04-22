import { useEffect, useState, type ReactElement } from 'react';
import { useDesigner } from '../context/designer-context.js';
import { I18nLocaleRows } from './i18n-locale-rows.js';
import { resolveModelDisplayName } from '../utils/i18n-resolve.js';

export function RelationDetailPanel(props: { relationId: string }): ReactElement {
  const { data, i18n } = useDesigner();
  const [, bump] = useState(0);
  useEffect(() => data.subscribe(() => bump((n) => n + 1)), [data]);

  const rel = data.relations.find((r) => r.id === props.relationId);
  if (!rel) {
    return <div style={{ fontSize: 12, color: '#64748b' }}>—</div>;
  }

  const srcModel = data.models.find((m) => m.id === rel.source_model_id);
  const tgtModel = data.models.find((m) => m.id === rel.target_model_id);
  const srcName = srcModel ? resolveModelDisplayName(srcModel, i18n.locale) : rel.source_model_id;
  const tgtName = tgtModel ? resolveModelDisplayName(tgtModel, i18n.locale) : rel.target_model_id;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, fontSize: 12 }}>
      <I18nLocaleRows
        disabled={false}
        summary={i18n.t('ui', 'relationPanelName')}
        value={(rel.name_i18n as Record<string, string> | undefined) ?? {}}
        onCommit={(next) => data.updateRelation(rel.id, { name_i18n: next })}
        pickLocaleLabel={i18n.t('ui', 'i18nPickLocale')}
        addRowHint={i18n.t('ui', 'i18nAddLocaleFill')}
      />

      <I18nLocaleRows
        disabled={false}
        multiline
        summary={i18n.t('ui', 'relationPanelDescription')}
        value={(rel.description_i18n as Record<string, string> | undefined) ?? {}}
        onCommit={(next) => data.updateRelation(rel.id, { description_i18n: next })}
        pickLocaleLabel={i18n.t('ui', 'i18nPickLocale')}
        addRowHint={i18n.t('ui', 'i18nAddLocaleFill')}
      />

      <label className="designer-field">
        <span className="designer-field-label">{i18n.t('ui', 'relationCanvasKind')}</span>
        <input
          className="designer-input"
          value={rel.kind}
          onChange={(e) => data.updateRelation(rel.id, { kind: e.target.value })}
        />
      </label>

      <label className="designer-field">
        <span className="designer-field-label">{i18n.t('ui', 'sysRelCardinality')}</span>
        <input
          className="designer-input"
          value={rel.self_cardinality ?? ''}
          placeholder="one | many"
          onChange={(e) => data.updateRelation(rel.id, { self_cardinality: e.target.value })}
        />
      </label>

      <div
        className="designer-glass-inset"
        style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}
      >
        <span className="designer-field-label">{i18n.t('ui', 'relationSource')}</span>
        <strong className="designer-prop-inherited-value" style={{ fontSize: 13, fontWeight: 650 }}>
          {srcName}
        </strong>
      </div>
      <div
        className="designer-glass-inset"
        style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}
      >
        <span className="designer-field-label">{i18n.t('ui', 'relationTarget')}</span>
        <strong className="designer-prop-inherited-value" style={{ fontSize: 13, fontWeight: 650 }}>
          {tgtName}
        </strong>
      </div>
    </div>
  );
}

import { useEffect, useState, type ReactElement } from 'react';
import { useDesigner } from '../context/designer-context.js';
import { resolveI18nForLocale } from '../utils/i18n-resolve.js';

export function RelationPanel(props: { modelId: string | undefined }): ReactElement {
  const { i18n, data } = useDesigner();
  const [, bump] = useState(0);
  useEffect(() => i18n.subscribe(() => bump((n) => n + 1)), [i18n]);
  useEffect(() => data.subscribe(() => bump((n) => n + 1)), [data]);

  const mid = props.modelId;
  const rels = mid
    ? data.relations.filter((r) => r.source_model_id === mid || r.target_model_id === mid)
    : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 12 }}>
      {rels.map((r) => {
        const label = resolveI18nForLocale(r.name_i18n, i18n.locale, r.kind);
        return (
          <div key={r.id} className="designer-rel-card designer-glass-inset">
            <div className="designer-prop-inherited-value" style={{ fontWeight: 650 }}>
              {label}
            </div>
            {r.self_cardinality ? (
              <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>
                {i18n.t('ui', 'sysRelCardinality')}: {r.self_cardinality}
              </div>
            ) : null}
            <div style={{ fontSize: 11, color: '#64748b', marginTop: 6 }}>{r.kind}</div>
          </div>
        );
      })}
      {rels.length === 0 && <div style={{ color: '#64748b' }}>—</div>}
      <button
        type="button"
        className="designer-btn designer-btn-primary"
        disabled={!mid}
        onClick={() => {
          if (!mid) {
            return;
          }
          const other = data.models.find((m) => m.id !== mid);
          if (!other) {
            return;
          }
          data.addRelation({
            id: crypto.randomUUID(),
            source_model_id: mid,
            target_model_id: other.id,
            kind: i18n.t('engine', 'relationDefault'),
          });
        }}
      >
        {i18n.t('ui', 'addRelation')}
      </button>
    </div>
  );
}

import { useDesigner } from '../context/designer-context.js';
import type { ReactElement } from 'react';

export function RelationPanel(props: { modelId: string | undefined }): ReactElement {
  const { i18n, data } = useDesigner();
  const mid = props.modelId;
  const rels = mid
    ? data.relations.filter((r) => r.source_model_id === mid || r.target_model_id === mid)
    : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12 }}>
      {rels.map((r) => (
        <div
          key={r.id}
          style={{
            padding: 8,
            background: '#f1f5f9',
            borderRadius: 8,
            border: '1px solid #e2e8f0',
            color: '#334155',
          }}
        >
          {r.source_model_id} → {r.target_model_id} ({r.kind})
        </div>
      ))}
      {rels.length === 0 && <div style={{ color: '#64748b' }}>—</div>}
      <button
        type="button"
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
        style={{
          padding: '8px 12px',
          cursor: 'pointer',
          borderRadius: 8,
          border: 'none',
          background: '#2563eb',
          color: '#fff',
          fontSize: 13,
        }}
      >
        {i18n.t('ui', 'addRelation')}
      </button>
    </div>
  );
}

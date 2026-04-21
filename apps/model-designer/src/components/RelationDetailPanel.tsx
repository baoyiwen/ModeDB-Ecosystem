import { useEffect, useState, type CSSProperties, type ReactElement } from 'react';
import { useDesigner } from '../context/designer-context.js';

function safeJsonStringify(obj: unknown): string {
  try {
    return JSON.stringify(obj ?? {}, null, 2);
  } catch {
    return '{}';
  }
}

export function RelationDetailPanel(props: { relationId: string }): ReactElement {
  const { data, i18n } = useDesigner();
  const [, bump] = useState(0);
  useEffect(() => data.subscribe(() => bump((n) => n + 1)), [data]);

  const rel = data.relations.find((r) => r.id === props.relationId);
  const [metaText, setMetaText] = useState('');
  const [nameI18nText, setNameI18nText] = useState('');
  const [descI18nText, setDescI18nText] = useState('');
  const [canvasMetaText, setCanvasMetaText] = useState('');
  const [metaErr, setMetaErr] = useState<string | null>(null);

  useEffect(() => {
    if (rel) {
      setMetaText(safeJsonStringify(rel.metadata));
      setNameI18nText(safeJsonStringify(rel.name_i18n ?? {}));
      setDescI18nText(safeJsonStringify(rel.description_i18n ?? {}));
      setCanvasMetaText(rel.canvas_meta_str ?? '');
      setMetaErr(null);
    }
  }, [rel?.id, rel?.metadata, rel?.name_i18n, rel?.description_i18n, rel?.canvas_meta_str]);

  if (!rel) {
    return <div style={{ fontSize: 12, color: '#64748b' }}>—</div>;
  }

  const srcName =
    data.models.find((m) => m.id === rel.source_model_id)?.model_name ?? rel.source_model_id;
  const tgtName =
    data.models.find((m) => m.id === rel.target_model_id)?.model_name ?? rel.target_model_id;

  const fieldStyle: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    color: '#475569',
    fontSize: 12,
  };

  const hint = (catalog: string): ReactElement => (
    <span style={{ fontSize: 10, color: '#94a3b8' }} title={catalog}>
      ({catalog})
    </span>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 12 }}>
      <div style={{ color: '#64748b' }}>
        _id: <code style={{ color: '#334155' }}>{rel.id}</code>
      </div>

      <label style={fieldStyle}>
        <span>
          {i18n.t('ui', 'relationCanvasKind')} {hint('canvas edge.kind')}
        </span>
        <input
          className="designer-input"
          value={rel.kind}
          onChange={(e) => data.updateRelation(rel.id, { kind: e.target.value })}
        />
      </label>

      <label style={fieldStyle}>
        <span>
          {i18n.t('ui', 'sysRelCardinality')} {hint('sys_relation.selfCardinality')}
        </span>
        <input
          className="designer-input"
          value={rel.self_cardinality ?? ''}
          placeholder="one | many"
          onChange={(e) => data.updateRelation(rel.id, { self_cardinality: e.target.value })}
        />
      </label>

      <label style={fieldStyle}>
        <span>
          {i18n.t('ui', 'sysRelNameI18n')} {hint('sys_relation.name')}
        </span>
        <textarea
          className="designer-input"
          rows={2}
          style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11 }}
          value={nameI18nText}
          onChange={(e) => setNameI18nText(e.target.value)}
          onBlur={() => {
            try {
              const parsed =
                nameI18nText.trim() === ''
                  ? {}
                  : (JSON.parse(nameI18nText) as Record<string, string>);
              data.updateRelation(rel.id, { name_i18n: parsed });
              setMetaErr(null);
            } catch {
              setMetaErr(i18n.t('errors', 'invalidJson'));
            }
          }}
        />
      </label>

      <label style={fieldStyle}>
        <span>
          {i18n.t('ui', 'sysRelDescription')} {hint('sys_relation.description')}
        </span>
        <textarea
          className="designer-input"
          rows={2}
          style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11 }}
          value={descI18nText}
          onChange={(e) => setDescI18nText(e.target.value)}
          onBlur={() => {
            try {
              const parsed =
                descI18nText.trim() === ''
                  ? {}
                  : (JSON.parse(descI18nText) as Record<string, string>);
              data.updateRelation(rel.id, { description_i18n: parsed });
              setMetaErr(null);
            } catch {
              setMetaErr(i18n.t('errors', 'invalidJson'));
            }
          }}
        />
      </label>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <label style={fieldStyle}>
          <span>
            {i18n.t('ui', 'sysRelPosX')} {hint('sys_relation.posX')}
          </span>
          <input
            className="designer-input"
            type="number"
            value={rel.pos_x ?? 0}
            onChange={(e) => data.updateRelation(rel.id, { pos_x: Number(e.target.value) })}
          />
        </label>
        <label style={fieldStyle}>
          <span>
            {i18n.t('ui', 'sysRelPosY')} {hint('sys_relation.posY')}
          </span>
          <input
            className="designer-input"
            type="number"
            value={rel.pos_y ?? 0}
            onChange={(e) => data.updateRelation(rel.id, { pos_y: Number(e.target.value) })}
          />
        </label>
      </div>

      <label style={fieldStyle}>
        <span>
          {i18n.t('ui', 'sysRelCanvasMeta')} {hint('sys_relation.canvas_meta')}
        </span>
        <textarea
          className="designer-input"
          rows={4}
          style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11 }}
          value={canvasMetaText}
          onChange={(e) => setCanvasMetaText(e.target.value)}
          onBlur={() => {
            data.updateRelation(rel.id, { canvas_meta_str: canvasMetaText });
          }}
        />
      </label>

      <div style={fieldStyle}>
        <span>{i18n.t('ui', 'relationSource')}</span>
        <div>
          <strong>{srcName}</strong>{' '}
          <code style={{ fontSize: 10, color: '#64748b' }}>{rel.source_model_id}</code>
        </div>
      </div>
      <div style={fieldStyle}>
        <span>{i18n.t('ui', 'relationTarget')}</span>
        <div>
          <strong>{tgtName}</strong>{' '}
          <code style={{ fontSize: 10, color: '#64748b' }}>{rel.target_model_id}</code>
        </div>
      </div>

      <label style={fieldStyle}>
        <span>metadata (JSON) {hint('edge.metadata')}</span>
        <textarea
          className="designer-input"
          rows={6}
          style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11 }}
          value={metaText}
          onChange={(e) => setMetaText(e.target.value)}
          onBlur={() => {
            try {
              const parsed =
                metaText.trim() === '' ? {} : (JSON.parse(metaText) as Record<string, unknown>);
              data.updateRelation(rel.id, { metadata: parsed });
              setMetaErr(null);
            } catch {
              setMetaErr(i18n.t('errors', 'invalidJson'));
            }
          }}
        />
      </label>
      {metaErr && <div style={{ fontSize: 11, color: '#dc2626' }}>{metaErr}</div>}
    </div>
  );
}

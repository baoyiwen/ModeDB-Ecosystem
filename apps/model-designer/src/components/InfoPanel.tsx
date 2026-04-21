import { useDesigner } from '../context/designer-context.js';
import type { ReactElement } from 'react';

export function InfoPanel(props: { modelId: string | undefined }): ReactElement {
  const { i18n, data } = useDesigner();
  const model = props.modelId ? data.models.find((m) => m.id === props.modelId) : undefined;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <label
        style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: '#475569' }}
      >
        {i18n.t('ui', 'modelName')}
        <input
          className="designer-input"
          disabled={!model}
          value={model?.model_name ?? ''}
          onChange={(e) => {
            if (model) {
              data.updateModelName(model.id, e.target.value);
            }
          }}
        />
      </label>
      <div style={{ fontSize: 11, color: '#94a3b8' }}>id: {model?.id ?? '—'}</div>
      <div style={{ fontSize: 11, color: '#94a3b8' }}>
        {i18n.t('ui', 'parentId')}: {model?.parent_id ?? '—'}
      </div>
    </div>
  );
}

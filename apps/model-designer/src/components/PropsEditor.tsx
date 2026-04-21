import { useState, type ReactElement } from 'react';
import { useDesigner } from '../context/designer-context.js';
import type { PropObject } from '../types/prop-object.js';

export function PropsEditor(props: { modelId: string | undefined }): ReactElement {
  const { data, i18n, propVault } = useDesigner();
  const model = props.modelId ? data.models.find((m) => m.id === props.modelId) : undefined;
  const [unlocked, setUnlocked] = useState<Record<string, boolean>>({});

  const updateProp = (propId: string, patch: Partial<PropObject>): void => {
    if (!model) {
      return;
    }
    const next = model.props_objects_array.map((p) => (p.id === propId ? { ...p, ...patch } : p));
    data.updateProps(model.id, next);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {model?.props_objects_array.map((p) => {
        const locked = propVault.isVaultField(p) && !unlocked[p.id];
        return (
          <div
            key={p.id}
            style={{
              border: '1px solid #e2e8f0',
              borderRadius: 8,
              padding: 8,
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 6,
              background: locked ? '#f1f5f9' : '#f8fafc',
            }}
          >
            {locked && (
              <div style={{ gridColumn: '1 / -1', fontSize: 11, color: '#64748b' }}>
                {i18n.t('ui', 'vaultLocked')} ({propVault.displayHandle(p)})
              </div>
            )}
            <input
              className="designer-input"
              value={p.name}
              disabled={locked}
              onChange={(e) => updateProp(p.id, { name: e.target.value })}
            />
            <input
              className="designer-input"
              value={p.type}
              disabled={locked}
              onChange={(e) => updateProp(p.id, { type: e.target.value })}
            />
            <label
              style={{
                fontSize: 11,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                color: '#475569',
              }}
            >
              <input
                type="checkbox"
                checked={p.is_primary}
                disabled={locked}
                onChange={(e) => updateProp(p.id, { is_primary: e.target.checked })}
              />
              {i18n.t('ui', 'primaryField')}
            </label>
            <input
              className="designer-input"
              type="number"
              value={p.encrypt_level}
              disabled={locked}
              onChange={(e) => updateProp(p.id, { encrypt_level: Number(e.target.value) })}
            />
            {propVault.isVaultField(p) && (
              <button
                type="button"
                className="designer-input"
                style={{ gridColumn: '1 / -1', fontSize: 11 }}
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
      {(!model || model.props_objects_array.length === 0) && (
        <div style={{ fontSize: 12, color: '#64748b' }}>{i18n.t('ui', 'noFields')}</div>
      )}
    </div>
  );
}

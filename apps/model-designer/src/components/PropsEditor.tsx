import { useEffect, useState, type ReactElement } from 'react';
import { useDesigner } from '../context/designer-context.js';
import type { PropObject } from '../types/prop-object.js';

function safeJsonStringify(obj: unknown): string {
  try {
    return JSON.stringify(obj ?? {}, null, 2);
  } catch {
    return '{}';
  }
}

export function PropsEditor(props: { modelId: string | undefined }): ReactElement {
  const { data, i18n, propVault } = useDesigner();
  const [, bump] = useState(0);
  useEffect(() => data.subscribe(() => bump((n) => n + 1)), [data]);
  const model = props.modelId ? data.models.find((m) => m.id === props.modelId) : undefined;
  const [unlocked, setUnlocked] = useState<Record<string, boolean>>({});
  const [descText, setDescText] = useState<Record<string, string>>({});

  const propsVersion = model?.props_objects_array.map((p) => p.id).join('|') ?? '';

  useEffect(() => {
    if (!model) {
      return;
    }
    const next: Record<string, string> = {};
    for (const p of model.props_objects_array) {
      next[p.id] = safeJsonStringify(p.description_i18n ?? {});
    }
    setDescText(next);
  }, [model?.id, propsVersion]);

  const updateProp = (propId: string, patch: Partial<PropObject>): void => {
    if (!model) {
      return;
    }
    const next = model.props_objects_array.map((p) => (p.id === propId ? { ...p, ...patch } : p));
    data.updateProps(model.id, next);
  };

  const hint = (catalog: string): string => `(${catalog})`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {model?.props_objects_array.map((p) => {
        const locked = propVault.isVaultField(p) && !unlocked[p.id];
        return (
          <div
            key={p.id}
            style={{
              border: '1px solid #e2e8f0',
              borderRadius: 8,
              padding: 10,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              background: locked ? '#f1f5f9' : '#f8fafc',
            }}
          >
            {locked && (
              <div style={{ fontSize: 11, color: '#64748b' }}>
                {i18n.t('ui', 'vaultLocked')} ({propVault.displayHandle(p)})
              </div>
            )}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(100px,1fr) minmax(100px,1fr)',
                gap: 8,
                alignItems: 'start',
              }}
            >
              <label
                style={{
                  fontSize: 11,
                  color: '#475569',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                }}
              >
                <span title="sys_props.name">
                  {i18n.t('ui', 'sysPropsName')} {hint('sys_props.name')}
                </span>
                <input
                  className="designer-input"
                  value={p.name}
                  disabled={locked}
                  onChange={(e) => updateProp(p.id, { name: e.target.value })}
                />
              </label>
              <label
                style={{
                  fontSize: 11,
                  color: '#475569',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                }}
              >
                <span title="sys_props.engineType">
                  {i18n.t('ui', 'sysPropsEngineType')} {hint('sys_props.engineType')}
                </span>
                <input
                  className="designer-input"
                  type="number"
                  value={p.engine_type ?? 0}
                  disabled={locked}
                  onChange={(e) => updateProp(p.id, { engine_type: Number(e.target.value) })}
                />
              </label>
              <label
                style={{
                  fontSize: 11,
                  color: '#475569',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                }}
              >
                <span>{i18n.t('ui', 'propLogicalType')}</span>
                <input
                  className="designer-input"
                  value={p.type}
                  disabled={locked}
                  onChange={(e) => updateProp(p.id, { type: e.target.value })}
                />
              </label>
              <label
                style={{
                  fontSize: 11,
                  color: '#475569',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                }}
              >
                <span title="sys_props.sort">
                  {i18n.t('ui', 'sysPropsSort')} {hint('sys_props.sort')}
                </span>
                <input
                  className="designer-input"
                  type="number"
                  value={p.sort ?? 0}
                  disabled={locked}
                  onChange={(e) => updateProp(p.id, { sort: Number(e.target.value) })}
                />
              </label>
            </div>

            <label
              style={{
                fontSize: 11,
                color: '#475569',
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}
            >
              <span title="sys_props.description">
                {i18n.t('ui', 'sysPropsDescription')} {hint('sys_props.description · I18N')}
              </span>
              <textarea
                className="designer-input"
                rows={2}
                disabled={locked}
                style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11 }}
                value={descText[p.id] ?? safeJsonStringify(p.description_i18n ?? {})}
                onChange={(e) => setDescText((t) => ({ ...t, [p.id]: e.target.value }))}
                onBlur={() => {
                  try {
                    const raw = descText[p.id] ?? safeJsonStringify(p.description_i18n ?? {});
                    const parsed =
                      raw.trim() === '' ? {} : (JSON.parse(raw) as Record<string, string>);
                    updateProp(p.id, { description_i18n: parsed });
                  } catch {
                    /* keep */
                  }
                }}
              />
            </label>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
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
                  checked={p.is_required ?? false}
                  disabled={locked}
                  onChange={(e) => updateProp(p.id, { is_required: e.target.checked })}
                />
                <span title="sys_props.isRequired">
                  {i18n.t('ui', 'sysPropsRequired')} {hint('sys_props.isRequired')}
                </span>
              </label>
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
                <span title="sys_props.isPrimary">
                  {i18n.t('ui', 'sysPropsPrimary')} {hint('sys_props.isPrimary')}
                </span>
              </label>
            </div>

            <label
              style={{
                fontSize: 11,
                color: '#475569',
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}
            >
              <span title="sys_props.vaultKey">
                {i18n.t('ui', 'sysPropsVaultKey')} {hint('sys_props.vaultKey')}
              </span>
              <input
                className="designer-input"
                value={p.vault_key ?? ''}
                disabled={locked}
                onChange={(e) => updateProp(p.id, { vault_key: e.target.value })}
              />
            </label>

            <label
              style={{
                fontSize: 11,
                color: '#475569',
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}
            >
              <span>{i18n.t('ui', 'propEncryptLevel')}</span>
              <input
                className="designer-input"
                type="number"
                value={p.encrypt_level}
                disabled={locked}
                onChange={(e) => updateProp(p.id, { encrypt_level: Number(e.target.value) })}
              />
            </label>

            {propVault.isVaultField(p) && (
              <button
                type="button"
                className="designer-input"
                style={{ fontSize: 11 }}
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

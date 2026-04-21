import { useEffect, useState, type ReactElement } from 'react';
import { useDesigner } from '../context/designer-context.js';

/**
 * 最小图层列表：显隐切换与激活图层（新节点默认挂到激活层）。
 */
export function LayerPanel(): ReactElement {
  const { data, layers, i18n } = useDesigner();
  const [, bump] = useState(0);

  useEffect(() => {
    const u1 = data.subscribe(() => bump((n) => n + 1));
    const u2 = layers.subscribe(() => bump((n) => n + 1));
    return () => {
      u1();
      u2();
    };
  }, [data, layers]);

  const rows = data.designerLayers;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {rows.length === 0 && (
        <div style={{ fontSize: 12, color: '#64748b' }}>{i18n.t('ui', 'layersEmpty')}</div>
      )}
      {rows.map((layer) => (
        <label
          key={layer.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 12,
            cursor: 'pointer',
            color: '#334155',
          }}
        >
          <input
            type="radio"
            name="designer-active-layer"
            checked={layers.activeLayerId === layer.id}
            onChange={() => layers.setActiveLayer(layer.id)}
          />
          <span style={{ flex: 1 }}>{layer.label}</span>
          <button
            type="button"
            className="designer-input"
            style={{ fontSize: 11, padding: '2px 8px' }}
            onClick={() => layers.toggleLayer(layer.id)}
          >
            {layer.isVisible ? i18n.t('ui', 'layerHide') : i18n.t('ui', 'layerShow')}
          </button>
        </label>
      ))}
    </div>
  );
}

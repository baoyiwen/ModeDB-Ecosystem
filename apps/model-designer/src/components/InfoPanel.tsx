import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import { useDesigner } from '../context/designer-context.js';
import { I18nLocaleRows } from './i18n-locale-rows.js';
import { contrastTextOnHex, normalizeHex } from '../utils/color-utils.js';

export function InfoPanel(props: { modelId: string | undefined }): ReactElement {
  const { i18n, data } = useDesigner();
  const [, bump] = useState(0);
  useEffect(() => data.subscribe(() => bump((n) => n + 1)), [data]);

  const model = props.modelId ? data.models.find((m) => m.id === props.modelId) : undefined;

  const colorInputRef = useRef<HTMLInputElement>(null);
  const hex = normalizeHex(model?.color_value, '#2563eb');
  const textOnColor = contrastTextOnHex(hex);

  const fieldStyle: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    fontSize: 12,
    color: '#475569',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <label style={fieldStyle}>
        <span style={{ fontWeight: 600, color: '#334155' }}>{i18n.t('ui', 'sysModelName')}</span>
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

      <I18nLocaleRows
        disabled={!model}
        summary={i18n.t('ui', 'sysModelNameI18n')}
        value={(model?.name_i18n as Record<string, string> | undefined) ?? {}}
        onCommit={(next) => {
          if (model) {
            data.updateModelPatch(model.id, { name_i18n: next });
          }
        }}
        pickLocaleLabel={i18n.t('ui', 'i18nPickLocale')}
        addRowHint={i18n.t('ui', 'i18nAddLocaleFill')}
      />

      <I18nLocaleRows
        disabled={!model}
        summary={i18n.t('ui', 'sysModelDescription')}
        value={(model?.description_i18n as Record<string, string> | undefined) ?? {}}
        onCommit={(next) => {
          if (model) {
            data.updateModelPatch(model.id, { description_i18n: next });
          }
        }}
        pickLocaleLabel={i18n.t('ui', 'i18nPickLocale')}
        addRowHint={i18n.t('ui', 'i18nAddLocaleFill')}
      />

      <label style={{ ...fieldStyle, position: 'relative' }}>
        <span style={{ fontWeight: 600, color: '#334155' }}>{i18n.t('ui', 'sysModelColor')}</span>
        <input
          ref={colorInputRef}
          type="color"
          aria-hidden
          tabIndex={-1}
          style={{
            position: 'absolute',
            width: 1,
            height: 1,
            padding: 0,
            margin: -1,
            overflow: 'hidden',
            clip: 'rect(0,0,0,0)',
            border: 0,
            opacity: 0,
          }}
          value={hex}
          onChange={(e) => {
            if (model) {
              data.updateModelPatch(model.id, { color_value: e.target.value });
            }
          }}
        />
        <input
          className="designer-input"
          readOnly
          disabled={!model}
          value={hex}
          onClick={() => colorInputRef.current?.click()}
          title={i18n.t('ui', 'sysModelColorPickHint')}
          style={{
            cursor: model ? 'pointer' : 'not-allowed',
            backgroundColor: hex,
            color: textOnColor,
            border: '1px solid rgba(15, 23, 42, 0.12)',
            fontFamily: 'ui-monospace, monospace',
            fontSize: 12,
          }}
        />
      </label>

      <div style={fieldStyle}>
        <span style={{ fontWeight: 600, color: '#334155' }}>{i18n.t('ui', 'fieldId')}</span>
        <div style={{ fontSize: 11, color: '#64748b', wordBreak: 'break-all' }}>
          {model?.id ?? '—'}
        </div>
      </div>
      <div style={fieldStyle}>
        <span style={{ fontWeight: 600, color: '#334155' }}>{i18n.t('ui', 'parentId')}</span>
        <div style={{ fontSize: 11, color: '#64748b', wordBreak: 'break-all' }}>
          {model?.parent_id ?? '—'}
        </div>
      </div>
    </div>
  );
}

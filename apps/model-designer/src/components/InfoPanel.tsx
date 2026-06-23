import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import { useDesigner } from '../context/designer-context.js';
import { I18nLocaleRows } from './i18n-locale-rows.js';
import { contrastTextOnHex, normalizeHex } from '../utils/color-utils.js';
import { collectLayerPages } from '../utils/layer-tree-pages.js';
import { resolveModelDisplayName } from '../utils/i18n-resolve.js';
import { isValidUniqueName, filterUniqueNameInput } from '../utils/name-validation.js';

export function InfoPanel(props: {
  modelId: string | undefined;
  readOnly?: boolean;
}): ReactElement {
  const { i18n, data, config, asyncOps } = useDesigner();
  const readOnly = props.readOnly ?? false;
  const [, bump] = useState(0);
  useEffect(() => data.subscribe(() => bump((n) => n + 1)), [data]);

  const model = props.modelId ? data.models.find((m) => m.id === props.modelId) : undefined;
  const layout = model ? data.getLayout(model.id) : undefined;
  const parentModel = model?.parent_id
    ? data.models.find((m) => m.id === model.parent_id)
    : undefined;

  const pages = useMemo(() => collectLayerPages(data.layerTreeRoots), [data.layerTreeRoots]);
  const [pageFilter, setPageFilter] = useState('');
  useEffect(() => {
    setPageFilter('');
  }, [model?.id]);

  const filteredPages = useMemo(() => {
    const q = pageFilter.trim().toLowerCase();
    if (!q) {
      return pages;
    }
    return pages.filter((p) => p.label.toLowerCase().includes(q) || p.id.toLowerCase().includes(q));
  }, [pages, pageFilter]);

  const assignedLayerIds = model ? [...data.getLayersForNode(model.id)] : [];
  const primaryPageId = assignedLayerIds[0] ?? '';

  const pageOptions = useMemo(() => {
    const base = filteredPages;
    if (primaryPageId && !base.some((p) => p.id === primaryPageId)) {
      const hit = pages.find((p) => p.id === primaryPageId);
      if (hit) {
        return [hit, ...base];
      }
      return [{ id: primaryPageId, label: primaryPageId }, ...base];
    }
    return base;
  }, [filteredPages, pages, primaryPageId]);

  const colorInputRef = useRef<HTMLInputElement>(null);
  const hex = normalizeHex(model?.color_value, '#2563eb');
  const textOnColor = contrastTextOnHex(hex);

  const applyColor = (value: string): void => {
    if (readOnly || !model) {
      return;
    }
    data.updateModelPatch(model.id, { color_value: value });
  };

  const locale = i18n.locale;

  const colorFieldStyle: CSSProperties = {
    position: 'relative',
  };

  const parentLabel = parentModel ? resolveModelDisplayName(parentModel, locale) : '—';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <label className="designer-field">
        <span className="designer-field-label">{i18n.t('ui', 'sysModelRegistryName')}</span>
        <input
          className="designer-input"
          disabled={!model || readOnly}
          value={model?.model_name ?? ''}
          onChange={(e) => {
            if (model) {
              data.updateModelName(model.id, filterUniqueNameInput(e.target.value));
            }
          }}
        />
        {model && model.model_name && !isValidUniqueName(model.model_name) ? (
          <span style={{ fontSize: 11, color: '#dc2626', marginTop: 4 }}>
            {i18n.t('ui', 'nameInvalidFormat')}
          </span>
        ) : null}
      </label>

      <div className="designer-field">
        <span className="designer-field-label">{i18n.t('ui', 'sysModelParent')}</span>
        <div className="designer-input designer-readonly-inset">{parentLabel}</div>
      </div>

      <I18nLocaleRows
        disabled={!model || readOnly}
        summary={i18n.t('ui', 'sysModelDisplayNameI18n')}
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
        disabled={!model || readOnly}
        multiline
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

      <div className="designer-field">
        <span className="designer-field-label">{i18n.t('ui', 'sysModelLayerPage')}</span>
        <input
          className="designer-input"
          disabled={!model || readOnly}
          placeholder={i18n.t('ui', 'layerPageFilter')}
          value={pageFilter}
          onChange={(e) => setPageFilter(e.target.value)}
        />
        <select
          className="designer-select"
          style={{ width: '100%', marginTop: 6, padding: '9px 12px', fontSize: 13 }}
          disabled={!model || readOnly}
          value={primaryPageId}
          onChange={(e) => {
            if (!model) {
              return;
            }
            if (!e.target.value) {
              data.assignNodeToLayers(model.id, []);
            } else {
              data.assignModelToPage(model.id, e.target.value);
            }
          }}
        >
          <option value="">{i18n.t('ui', 'layerPageNone')}</option>
          {pageOptions.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label} ({p.id})
            </option>
          ))}
        </select>
      </div>

      <label className="designer-field" style={colorFieldStyle}>
        <span className="designer-field-label">{i18n.t('ui', 'sysModelColor')}</span>
        <input
          ref={colorInputRef}
          type="color"
          aria-hidden
          tabIndex={-1}
          value={hex}
          onChange={(e) => applyColor(e.target.value)}
          onInput={(e) => applyColor((e.target as HTMLInputElement).value)}
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
        />
        <input
          className="designer-input designer-color-swatch"
          readOnly
          disabled={!model || readOnly}
          value={hex}
          onClick={() => {
            if (!readOnly) {
              colorInputRef.current?.click();
            }
          }}
          title={i18n.t('ui', 'sysModelColorPickHint')}
          style={{
            backgroundColor: hex,
            color: textOnColor,
          }}
        />
      </label>

      <label className="designer-switch-row">
        <span className="designer-field-label">{i18n.t('ui', 'modelPositionLock')}</span>
        <input
          type="checkbox"
          className="designer-switch"
          disabled={!model || readOnly}
          checked={!!layout?.position_locked}
          onChange={(e) => {
            if (model) {
              data.patchLayout(model.id, { position_locked: e.target.checked });
            }
          }}
        />
      </label>

      <div
        className="designer-field"
        style={{ marginTop: 8, paddingTop: 12, borderTop: '1px solid var(--designer-border)' }}
      >
        <span className="designer-field-label">{i18n.t('ui', 'dataSectionTitle')}</span>
        <p style={{ fontSize: 12, color: 'var(--designer-text-soft)', margin: '6px 0 10px' }}>
          {i18n.t('ui', 'dataClearModelHint')}
        </p>
        <button
          type="button"
          className="designer-tree-action designer-tree-action--danger"
          disabled={!model?.model_name || !config.remoteClient || readOnly || asyncOps.isBusy}
          onClick={async () => {
            if (!model?.model_name || !config.remoteClient) {
              return;
            }
            if (
              !globalThis.confirm(i18n.t('ui', 'dataConfirmClearModel', { name: model.model_name }))
            ) {
              return;
            }
            try {
              await asyncOps.run(
                'clearModelData',
                () =>
                  config.remoteClient!.apply({
                    op: 'clearModelData',
                    model: model.model_name,
                  }),
                { detail: model.model_name },
              );
            } catch {
              /* 失败态由右侧 toast 展示 */
            }
          }}
        >
          {i18n.t('ui', 'dataClearModel')}
        </button>
      </div>
    </div>
  );
}

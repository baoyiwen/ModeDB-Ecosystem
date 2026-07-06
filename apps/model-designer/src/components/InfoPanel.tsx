import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import { useDesigner } from '../context/designer-context.js';
import { withBusinessLibrarySession } from '../engine/business-library-session.js';
import { I18nLocaleRows } from './i18n-locale-rows.js';
import { contrastTextOnHex, normalizeHex } from '../utils/color-utils.js';
import { collectLayerPages } from '../utils/layer-tree-pages.js';
import { resolveModelDisplayName } from '../utils/i18n-resolve.js';
import { isValidUniqueName, filterUniqueNameInput } from '../utils/name-validation.js';
import { DesignerSelect } from './base/designer-select.js';

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
  const assignedLayerIds = model ? [...data.getLayersForNode(model.id)] : [];
  const primaryPageId = assignedLayerIds[0] ?? '';

  const pageOptions = useMemo(() => {
    const base = pages.map((page) => ({ value: page.id, label: `${page.label} (${page.id})` }));
    if (primaryPageId && !base.some((p) => p.value === primaryPageId)) {
      const hit = pages.find((p) => p.id === primaryPageId);
      if (hit) {
        return [
          { value: '', label: i18n.t('ui', 'layerPageNone') },
          { value: hit.id, label: `${hit.label} (${hit.id})` },
          ...base,
        ];
      }
      return [
        { value: '', label: i18n.t('ui', 'layerPageNone') },
        { value: primaryPageId, label: primaryPageId },
        ...base,
      ];
    }
    return [{ value: '', label: i18n.t('ui', 'layerPageNone') }, ...base];
  }, [i18n, pages, primaryPageId]);

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
        <DesignerSelect
          compact
          searchable
          disabled={!model || readOnly}
          value={primaryPageId}
          options={pageOptions}
          searchPlaceholder={i18n.t('ui', 'layerPageFilter')}
          emptyLabel={i18n.t('ui', 'layerPageEmpty')}
          onChange={(value) => {
            if (!model) {
              return;
            }
            if (!value) {
              data.assignNodeToLayers(model.id, []);
            } else {
              data.assignModelToPage(model.id, value);
            }
          }}
        />
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
          disabled={
            !model?.model_name ||
            model.model_name.startsWith('sys_') ||
            !config.remoteClient ||
            !config.activeLibraryName ||
            readOnly ||
            asyncOps.isBusy
          }
          onClick={async () => {
            const libraryCode = config.activeLibraryName;
            if (!model?.model_name || !config.remoteClient || !libraryCode) {
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
                  withBusinessLibrarySession(libraryCode, (businessClient) =>
                    businessClient.apply({
                      op: 'clearModelData',
                      model: model.model_name,
                    }),
                  ),
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

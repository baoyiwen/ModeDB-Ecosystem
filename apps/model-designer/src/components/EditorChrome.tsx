import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react';
import { useDesigner } from '../context/designer-context.js';
import { isInheritRelation } from '../config/graph-edge-kinds.js';
import { isReadOnlyToolMode } from '../managers/mode-manager.js';
import { InfoPanel } from './InfoPanel.js';
import { PropsEditor } from './PropsEditor.js';
import { LayerTreePanel } from './LayerTreePanel.js';
import { RelationDetailPanel } from './RelationDetailPanel.js';
import type { LocaleCode } from '../managers/i18n-manager.js';
import { IconGrid, IconSettings } from './designer-icons.js';

export type ManualPanelKind = 'hierarchy' | 'settings';

export function EditorChrome(props: {
  selectedModelId: string | undefined;
  selectedRelationId: string | undefined;
  /** 关闭仅由画布选择打开的被动侧栏（清除选择）。 */
  onRequestClearCanvasSelection: () => void;
  children: ReactNode;
}): ReactElement {
  const { i18n, appearance, modes, data, config } = useDesigner();
  const [, bump] = useState(0);
  const [clearAllBusy, setClearAllBusy] = useState(false);
  useEffect(() => i18n.subscribe(() => bump((n) => n + 1)), [i18n]);
  useEffect(() => appearance.subscribe(() => bump((n) => n + 1)), [appearance]);
  useEffect(() => modes.subscribe(() => bump((n) => n + 1)), [modes]);
  useEffect(() => data.subscribe(() => bump((n) => n + 1)), [data]);

  const readOnly = isReadOnlyToolMode(modes.mode);
  const selectedRel = props.selectedRelationId
    ? data.relations.find((r) => r.id === props.selectedRelationId)
    : undefined;
  const inheritAsModelId =
    selectedRel && isInheritRelation(selectedRel.kind) ? selectedRel.target_model_id : undefined;
  const effectiveModelId = props.selectedModelId ?? inheritAsModelId;
  const showRelationDetail = Boolean(
    props.selectedRelationId && selectedRel && !isInheritRelation(selectedRel.kind),
  );

  const [manualPanel, setManualPanel] = useState<ManualPanelKind | null>(null);

  useEffect(() => {
    setManualPanel(null);
  }, [props.selectedModelId, props.selectedRelationId]);

  const passiveOpen = Boolean(effectiveModelId || showRelationDetail);
  const manualOpen = manualPanel !== null;
  const shellOpen = passiveOpen || manualOpen;

  const closeAll = useCallback((): void => {
    if (manualOpen) {
      setManualPanel(null);
      return;
    }
    if (passiveOpen) {
      props.onRequestClearCanvasSelection();
    }
  }, [manualOpen, passiveOpen, props]);

  const openManual = useCallback((kind: ManualPanelKind): void => {
    setManualPanel((p) => (p === kind ? null : kind));
  }, []);

  const title = (): string => {
    if (manualPanel === 'hierarchy') {
      return i18n.t('ui', 'panelHierarchy');
    }
    if (manualPanel === 'settings') {
      return i18n.t('ui', 'settings');
    }
    if (showRelationDetail) {
      return i18n.t('ui', 'relations');
    }
    if (effectiveModelId) {
      return i18n.t('ui', 'panelModelDetails');
    }
    return '';
  };

  const renderBody = (): ReactElement | null => {
    if (manualPanel === 'hierarchy') {
      return <LayerTreePanel selectedId={effectiveModelId} readOnly={readOnly} />;
    }
    if (manualPanel === 'settings') {
      const currentAccent = appearance.accent.toLowerCase();
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <label className="designer-settings-row">
            <span className="designer-panel-section-title" style={{ margin: 0 }}>
              {i18n.t('ui', 'locale')}
            </span>
            <select
              className="designer-select"
              value={i18n.locale}
              onChange={(e) => i18n.setLocale(e.target.value as LocaleCode)}
            >
              <option value="en">English</option>
              <option value="zh">中文</option>
              <option value="ja">日本語</option>
            </select>
          </label>

          <div className="designer-settings-row">
            <span className="designer-panel-section-title" style={{ margin: 0 }}>
              {i18n.t('ui', 'themeColor')}
            </span>
            <div className="designer-accent-row">
              {appearance.presets.map((preset) => {
                const swatchStyle = { '--swatch-color': preset.color } as CSSProperties;
                const selected = preset.color.toLowerCase() === currentAccent;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    className="designer-accent-swatch"
                    aria-pressed={selected}
                    aria-label={preset.id}
                    title={preset.color}
                    style={swatchStyle}
                    onClick={() => appearance.setAccent(preset.color)}
                  />
                );
              })}
              <input
                className="designer-accent-picker"
                type="color"
                aria-label={i18n.t('ui', 'themeColorCustom')}
                title={i18n.t('ui', 'themeColorCustom')}
                value={currentAccent}
                onChange={(e) => appearance.setAccent(e.target.value)}
              />
            </div>
          </div>

          <div
            className="designer-settings-row"
            style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}
          >
            <span className="designer-panel-section-title" style={{ margin: 0 }}>
              {i18n.t('ui', 'dataSectionTitle')}
            </span>
            <p style={{ fontSize: 12, color: 'var(--designer-text-soft)', margin: 0 }}>
              {i18n.t('ui', 'dataClearAllHint')}
            </p>
            <button
              type="button"
              className="designer-tree-action designer-tree-action--danger"
              disabled={!config.remoteClient || !config.activeLibraryName || clearAllBusy}
              onClick={async () => {
                const lib = config.activeLibraryName;
                if (!config.remoteClient || !lib) {
                  return;
                }
                if (!globalThis.confirm(i18n.t('ui', 'dataConfirmClearAll', { name: lib }))) {
                  return;
                }
                setClearAllBusy(true);
                try {
                  await config.remoteClient.apply({ op: 'clearAllData' });
                  window.alert(i18n.t('ui', 'dataClearAllDone', { name: lib }));
                } catch {
                  window.alert(i18n.t('errors', 'clearDataFailed'));
                } finally {
                  setClearAllBusy(false);
                }
              }}
            >
              {i18n.t('ui', 'dataClearAll')}
            </button>
          </div>
        </div>
      );
    }
    if (showRelationDetail && props.selectedRelationId) {
      return (
        <RelationDetailPanel
          key={props.selectedRelationId}
          relationId={props.selectedRelationId}
          readOnly={readOnly}
        />
      );
    }
    if (effectiveModelId) {
      return (
        <div className="designer-passive-panels">
          <section className="designer-passive-section">
            <h3 className="designer-panel-section-title">{i18n.t('ui', 'info')}</h3>
            <InfoPanel key={effectiveModelId} modelId={effectiveModelId} readOnly={readOnly} />
          </section>
          <section className="designer-passive-section">
            <h3 className="designer-panel-section-title">{i18n.t('ui', 'props')}</h3>
            <PropsEditor key={effectiveModelId} modelId={effectiveModelId} readOnly={readOnly} />
          </section>
        </div>
      );
    }
    return null;
  };

  const body = renderBody();

  return (
    <>
      {props.children}

      <div className="designer-panel-fabs designer-panel-fabs--row" aria-label="Panel toggles">
        <button
          type="button"
          className="designer-fab designer-fab--panel"
          data-active={manualPanel === 'hierarchy' ? 'true' : 'false'}
          title={i18n.t('ui', 'fabLayers')}
          onClick={() => openManual('hierarchy')}
        >
          <IconGrid />
        </button>
        <button
          type="button"
          className="designer-fab designer-fab--panel"
          data-active={manualPanel === 'settings' ? 'true' : 'false'}
          title={i18n.t('ui', 'fabSettings')}
          onClick={() => openManual('settings')}
        >
          <IconSettings />
        </button>
      </div>

      <div
        className={`designer-slide-shell${shellOpen ? ' designer-slide-shell--open' : ''}`}
        aria-hidden={!shellOpen}
      >
        <aside
          className="designer-slide-panel"
          role="dialog"
          aria-labelledby="designer-slide-title"
        >
          <header className="designer-slide-panel-header">
            <h2 id="designer-slide-title" className="designer-panel-title">
              {shellOpen ? title() : ''}
            </h2>
            <button type="button" className="designer-slide-close" onClick={closeAll}>
              ×
            </button>
          </header>
          <div className="designer-panel-body designer-scrollbar-hide">{body}</div>
        </aside>
      </div>
    </>
  );
}

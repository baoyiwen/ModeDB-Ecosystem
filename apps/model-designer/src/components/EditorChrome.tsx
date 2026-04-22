import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { useDesigner } from '../context/designer-context.js';
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
  const { i18n } = useDesigner();
  const [, bump] = useState(0);
  useEffect(() => i18n.subscribe(() => bump((n) => n + 1)), [i18n]);

  const [manualPanel, setManualPanel] = useState<ManualPanelKind | null>(null);

  useEffect(() => {
    setManualPanel(null);
  }, [props.selectedModelId, props.selectedRelationId]);

  const passiveOpen = Boolean(props.selectedModelId || props.selectedRelationId);
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
    if (props.selectedRelationId) {
      return i18n.t('ui', 'relations');
    }
    if (props.selectedModelId) {
      return i18n.t('ui', 'panelModelDetails');
    }
    return '';
  };

  const renderBody = (): ReactElement | null => {
    if (manualPanel === 'hierarchy') {
      return <LayerTreePanel selectedId={props.selectedModelId} />;
    }
    if (manualPanel === 'settings') {
      return (
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
      );
    }
    if (props.selectedRelationId) {
      return (
        <RelationDetailPanel key={props.selectedRelationId} relationId={props.selectedRelationId} />
      );
    }
    if (props.selectedModelId) {
      return (
        <div className="designer-passive-panels">
          <section className="designer-passive-section">
            <h3 className="designer-panel-section-title">{i18n.t('ui', 'info')}</h3>
            <InfoPanel key={props.selectedModelId} modelId={props.selectedModelId} />
          </section>
          <section className="designer-passive-section">
            <h3 className="designer-panel-section-title">{i18n.t('ui', 'props')}</h3>
            <PropsEditor key={props.selectedModelId} modelId={props.selectedModelId} />
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

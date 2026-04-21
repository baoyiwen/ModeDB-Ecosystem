import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { useDesigner } from '../context/designer-context.js';
import { LayerPanel } from './LayerPanel.js';
import { InfoPanel } from './InfoPanel.js';
import { PropsEditor } from './PropsEditor.js';
import { RelationPanel } from './RelationPanel.js';
import type { LocaleCode } from '../managers/i18n-manager.js';

export function PanelGroup(props: { selectedId: string | undefined }): ReactElement {
  const { i18n } = useDesigner();
  const [locale, setLocale] = useState<LocaleCode>(i18n.locale);
  const [, bump] = useState(0);

  useEffect(() => {
    return i18n.subscribe(() => bump((n) => n + 1));
  }, [i18n]);

  useEffect(() => {
    i18n.setLocale(locale);
  }, [i18n, locale]);

  const section = (title: string, child: ReactNode): ReactElement => (
    <section style={{ marginBottom: 16 }}>
      <h3 className="designer-panel-section-title">{title}</h3>
      {child}
    </section>
  );

  return (
    <>
      <div className="designer-panel-header">
        <h2 className="designer-panel-title">{i18n.t('ui', 'panelProperties')}</h2>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
          <span className="designer-panel-section-title" style={{ margin: 0 }}>
            {i18n.t('ui', 'locale')}
          </span>
          <select
            className="designer-select"
            value={locale}
            onChange={(e) => setLocale(e.target.value as LocaleCode)}
          >
            <option value="en">English</option>
            <option value="zh">中文</option>
            <option value="ja">日本語</option>
          </select>
        </label>
      </div>
      <div className="designer-panel-body">
        {section(i18n.t('ui', 'layers'), <LayerPanel />)}
        {section(i18n.t('ui', 'info'), <InfoPanel modelId={props.selectedId} />)}
        {section(i18n.t('ui', 'relations'), <RelationPanel modelId={props.selectedId} />)}
        {section(i18n.t('ui', 'props'), <PropsEditor modelId={props.selectedId} />)}
      </div>
    </>
  );
}

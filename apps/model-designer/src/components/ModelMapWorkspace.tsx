import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { AppDrawer } from '@mode-db/data-ui';
import { useDesigner } from '../context/designer-context.js';
import { normalizeLegacyPropType, propDataTypeLabelKey } from '../config/engine-prop-types.js';
import { buildModelMap, filterModelMap, matchesModelMapField } from '../model-map/model-map.js';
import { resolveI18nForLocale, resolveModelDisplayName } from '../utils/i18n-resolve.js';
import { IconExport, IconSearch } from './designer-icons.js';

export function ModelMapWorkspace(props: { readonly onClose: () => void }): ReactElement {
  const { data, i18n, config } = useDesigner();
  const [revision, redraw] = useState(0);
  const [search, setSearch] = useState('');
  const [scrollTarget, setScrollTarget] = useState<string>();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLElement>(null);
  const modelSections = useRef(new Map<string, HTMLElement>());
  const t = (key: string, params?: Record<string, string>): string => i18n.t('ui', key, params);

  useEffect(() => {
    const refresh = (): void => redraw((value) => value + 1);
    const subscriptions = [
      data.subscribe(refresh),
      i18n.subscribe(refresh),
      config.subscribeLibrary(refresh),
    ];
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    root.current?.querySelector<HTMLButtonElement>('.mode-ui-drawer-close')?.focus();
    return () => {
      subscriptions.forEach((unsubscribe) => unsubscribe());
      previous?.focus();
    };
  }, [data, i18n, config]);

  const entries = useMemo(() => buildModelMap(data.models, i18n.locale), [data, i18n, revision]);
  const visible = useMemo(() => filterModelMap(entries, search), [entries, search]);
  useEffect(() => {
    if (content.current) content.current.scrollTop = 0;
  }, [search]);
  useEffect(() => {
    if (!scrollTarget) return;
    modelSections.current.get(scrollTarget)?.scrollIntoView({ block: 'start' });
    setScrollTarget(undefined);
  }, [scrollTarget, visible]);

  const openModel = (id: string): void => {
    setSearch('');
    setCollapsed((current) => new Set([...current].filter((modelId) => modelId !== id)));
    setScrollTarget(id);
  };
  const libraryLabel = resolveI18nForLocale(
    config.activeLibraryNameI18n ?? undefined,
    i18n.locale,
    config.activeLibraryName ?? t('modelMapCurrentGraph'),
  );
  const exportExcel = async (): Promise<void> => {
    if (exporting) return;
    setExporting(true);
    setExportError('');
    try {
      const { exportModelMapExcel } = await import('../model-map/export-model-map.js');
      const bytes = await exportModelMapExcel(entries, i18n, libraryLabel);
      const blob = new Blob([bytes], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      const now = new Date();
      const stamp = [
        now.getFullYear(),
        now.getMonth() + 1,
        now.getDate(),
        now.getHours(),
        now.getMinutes(),
        now.getSeconds(),
      ]
        .map((part) => String(part).padStart(2, '0'))
        .join('');
      anchor.download = `${(config.activeLibraryName || 'model-map').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}-model-map-${stamp}.xlsx`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : t('modelMapExportFailed'));
    } finally {
      setExporting(false);
    }
  };

  return createPortal(
    <div
      ref={root}
      className="designer-model-map-root"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape') {
          event.preventDefault();
        }
        if (event.key === 'Tab') {
          const controls = [
            ...(root.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled), [tabindex="0"]',
            ) ?? []),
          ].filter((element) => !element.closest('[hidden], [inert]'));
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      }}
      onKeyUp={(event) => {
        event.stopPropagation();
        // Close after release so the canvas cannot consume the same Escape keyup.
        if (event.key === 'Escape') props.onClose();
      }}
    >
      <AppDrawer
        open
        title={t('modelMapTitle')}
        closeLabel={t('modelMapClose')}
        labelledById="model-map-title"
        className="designer-model-map-workspace"
        bodyClassName="designer-model-map-body"
        width="100vw"
        withScrim={false}
        onClose={props.onClose}
      >
        <div className="designer-model-map-toolbar">
          <div className="designer-model-map-graph">
            <strong>{libraryLabel}</strong>
            <span>
              {t('modelMapCount', {
                visible: String(visible.length),
                total: String(entries.length),
              })}
            </span>
          </div>
          <div className="designer-model-map-actions">
            <button
              type="button"
              className="designer-btn"
              disabled={
                visible.length === 0 || visible.every((entry) => !collapsed.has(entry.model.id))
              }
              onClick={() => setCollapsed(new Set())}
            >
              {t('modelMapExpandAll')}
            </button>
            <button
              type="button"
              className="designer-btn"
              disabled={
                visible.length === 0 || visible.every((entry) => collapsed.has(entry.model.id))
              }
              onClick={() => setCollapsed(new Set(entries.map((entry) => entry.model.id)))}
            >
              {t('modelMapCollapseAll')}
            </button>
            <button
              type="button"
              className="designer-btn"
              disabled={entries.length === 0 || exporting}
              title={t('modelMapExportHint')}
              onClick={() => void exportExcel()}
            >
              <IconExport />
              {t(exporting ? 'modelMapExporting' : 'modelMapExportExcel')}
            </button>
            <label className="designer-model-map-search">
              <IconSearch />
              <input
                type="search"
                className="designer-input"
                aria-label={t('modelMapSearch')}
                placeholder={t('modelMapSearch')}
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  if (event.target.value.trim()) setCollapsed(new Set());
                }}
              />
            </label>
          </div>
        </div>
        {exportError ? (
          <p className="designer-model-map-error" role="alert">
            {t('modelMapExportFailed')}: {exportError}
          </p>
        ) : null}
        <main
          ref={content}
          className="designer-model-map-content"
          aria-label={t('modelMapDirectory')}
          tabIndex={0}
        >
          {visible.map((entry) => (
            <section
              key={entry.model.id}
              ref={(element) => {
                if (element) modelSections.current.set(entry.model.id, element);
                else modelSections.current.delete(entry.model.id);
              }}
              className="designer-model-map-model"
              data-model-id={entry.model.id}
              aria-labelledby={`model-map-heading-${encodeURIComponent(entry.model.id)}`}
            >
              <header className="designer-model-map-heading">
                <h3 id={`model-map-heading-${encodeURIComponent(entry.model.id)}`}>
                  <button
                    type="button"
                    className="designer-model-map-toggle"
                    aria-expanded={!collapsed.has(entry.model.id)}
                    aria-controls={`model-map-body-${encodeURIComponent(entry.model.id)}`}
                    onClick={() =>
                      setCollapsed((current) => {
                        const next = new Set(current);
                        if (next.has(entry.model.id)) next.delete(entry.model.id);
                        else next.add(entry.model.id);
                        return next;
                      })
                    }
                  >
                    <svg
                      className="designer-model-map-chevron"
                      viewBox="0 0 20 20"
                      aria-hidden="true"
                    >
                      <path
                        d="m7 4 6 6-6 6"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.7"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    <span className="designer-model-map-model-name">
                      <strong>{entry.label}</strong>
                      <code>{entry.model.model_name}</code>
                    </span>
                    <span className="designer-model-map-field-count">
                      {t('modelMapFieldCount', { count: String(entry.fields.length) })}
                    </span>
                  </button>
                </h3>
              </header>
              <div
                id={`model-map-body-${encodeURIComponent(entry.model.id)}`}
                className="designer-model-map-model-body"
                data-expanded={!collapsed.has(entry.model.id)}
                aria-hidden={collapsed.has(entry.model.id)}
                inert={collapsed.has(entry.model.id)}
              >
                <div className="designer-model-map-model-body-content">
                  <section
                    className="designer-model-map-introduction"
                    aria-label={t('modelMapIntroduction')}
                  >
                    <h4>{t('modelMapIntroduction')}</h4>
                    <p>{entry.description || t('modelMapNoDescription')}</p>
                    {entry.parent ? (
                      <div className="designer-model-map-parent">
                        <span>{t('modelMapParent')}</span>
                        <button type="button" onClick={() => openModel(entry.parent!.id)}>
                          {resolveModelDisplayName(entry.parent, i18n.locale)}
                        </button>
                      </div>
                    ) : null}
                    {entry.inheritanceIssue ? (
                      <p className="designer-model-map-warning" role="status">
                        {t('modelMapInheritanceWarning')}
                      </p>
                    ) : null}
                  </section>
                  <h4 className="designer-model-map-fields-title">{t('modelMapFields')}</h4>
                  <div
                    className="designer-model-map-table-scroll"
                    tabIndex={0}
                    role="region"
                    aria-label={t('modelMapFields')}
                  >
                    <table className="designer-model-map-table">
                      <colgroup>
                        <col />
                        <col />
                        <col />
                        <col />
                        <col />
                        <col />
                      </colgroup>
                      <thead>
                        <tr>
                          <th scope="col">{t('modelMapFieldName')}</th>
                          <th scope="col">{t('modelMapType')}</th>
                          <th scope="col">{t('modelMapIntroduction')}</th>
                          <th scope="col">{t('modelMapRequired')}</th>
                          <th scope="col">{t('modelMapPrimary')}</th>
                          <th scope="col">{t('modelMapSource')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {entry.fields.map((field) => {
                          const type = normalizeLegacyPropType(field.prop.type);
                          const typeKey = propDataTypeLabelKey(type);
                          const typeLabel = i18n.t('engine', typeKey);
                          const inherited = field.ownerId !== entry.model.id;
                          return (
                            <tr
                              key={field.prop.name}
                              data-match={Boolean(
                                search.trim() && matchesModelMapField(field, search),
                              )}
                            >
                              <th scope="row">
                                <strong>{field.label}</strong>
                                <code>{field.prop.name}</code>
                              </th>
                              <td>{typeLabel === typeKey ? type : typeLabel}</td>
                              <td className="designer-model-map-field-description">
                                {field.description || t('modelMapNotSet')}
                              </td>
                              <td>{t(field.prop.is_required ? 'modelMapYes' : 'modelMapNo')}</td>
                              <td>{t(field.prop.is_primary ? 'modelMapYes' : 'modelMapNo')}</td>
                              <td>
                                {inherited ? (
                                  <button
                                    type="button"
                                    className="designer-model-map-source"
                                    title={t('modelMapInheritedFrom', { name: field.ownerLabel })}
                                    onClick={() => openModel(field.ownerId)}
                                  >
                                    {field.ownerLabel}
                                  </button>
                                ) : (
                                  <span className="designer-model-map-own">
                                    {t('modelMapOwnField')}
                                  </span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                        {entry.fields.length === 0 ? (
                          <tr>
                            <td colSpan={6} className="designer-model-map-empty">
                              {t('modelMapNoFields')}
                            </td>
                          </tr>
                        ) : null}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </section>
          ))}
          {visible.length === 0 ? (
            <p className="designer-model-map-empty" role="status">
              {t(entries.length ? 'modelMapNoResults' : 'modelMapEmpty')}
            </p>
          ) : null}
        </main>
      </AppDrawer>
    </div>,
    document.body,
  );
}

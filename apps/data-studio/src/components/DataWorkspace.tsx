import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { ManagementCatalogResponse, RemoteModelDBClient } from '@mode-db/sdk';
import {
  createSdkBindingExecutor,
  createTabularSnapshot,
  buildFieldColumnLabels,
  formatDisplayWithUnique,
  formatFieldDisplayLabel,
  importFieldTypesForProps,
  propFieldsFromCatalogFields,
  type FieldLabelMap,
  type ImportFieldTypeMap,
  type PivotViewConfig,
  type ViewDataShape,
} from '@mode-db/data-kit';
import { DataPageProvider, DataViewPanel, ImportPanel, useDataPage } from '@mode-db/data-ui';
import {
  getStoredModel,
  getStoredNameDisplayMode,
  persistModel,
  persistNameDisplayMode,
  type NameDisplayMode,
} from '../config/connection-prefs.js';
import { buildImportPanelLabels } from '../config/import-panel-labels.js';
import type { StudioI18n } from '../managers/i18n-manager.js';
import type { StudioNotificationManager } from '../managers/notification-manager.js';
import { useStudio, useStudioLocale, type StudioLocale } from '../context/studio-context.js';
import { notifyImportCommitResult } from '../utils/import-commit-notify.js';
import { StudioToolbar } from './StudioToolbar.js';

export interface DataWorkspaceProps {
  client: RemoteModelDBClient;
  library: string;
  catalog: ManagementCatalogResponse;
  onCatalogRefresh: () => Promise<ManagementCatalogResponse>;
  onCreateBackup: () => Promise<void>;
  onRestoreBackup: () => Promise<void>;
  onClearDatabase: () => Promise<void>;
  onForceResetDatabase: () => Promise<void>;
  onDisconnect: () => void;
}

type StudioView = 'table' | 'pivot' | 'import';
type CatalogModelInfo = ManagementCatalogResponse['models'][number];
type I18nDisplayMap = Readonly<Record<string, string>>;

function ownCatalogModelFields(info: CatalogModelInfo | undefined): readonly string[] {
  if (!info) {
    return [];
  }
  const fromFields = propFieldsFromCatalogFields(info.fields ?? []);
  if (fromFields.length > 0) {
    return fromFields;
  }
  return propFieldsFromCatalogFields(Object.keys(info.fieldTypes ?? {}));
}

function uniqueFields(fields: readonly string[]): readonly string[] {
  return [...new Set(fields)];
}

function displayNameForLocale(
  labels: I18nDisplayMap | undefined,
  locale: string,
): string | undefined {
  const label = labels?.[locale]?.trim();
  return label && label.length > 0 ? label : undefined;
}

function modelDisplayName(
  catalog: ManagementCatalogResponse,
  model: string,
  locale: string,
  mode: NameDisplayMode,
): string {
  if (mode === 'name') {
    return model;
  }
  const info = catalogModelInfo(catalog, model);
  return formatDisplayWithUnique(model, displayNameForLocale(info?.displayName, locale));
}

function databaseDisplayName(
  catalog: ManagementCatalogResponse,
  fallback: string,
  locale: string,
  mode: NameDisplayMode,
): string {
  if (mode === 'name') {
    return fallback;
  }
  return formatDisplayWithUnique(fallback, displayNameForLocale(catalog.displayName, locale));
}

function fieldDisplayName(
  fieldLabels: FieldLabelMap | undefined,
  fieldName: string,
  locale: string,
  mode: NameDisplayMode,
): string {
  if (mode === 'name') {
    return fieldName;
  }
  return formatFieldDisplayLabel(fieldLabels, fieldName, locale, true);
}

function columnLabelSignature(labels: Readonly<Record<string, string>> | undefined): string {
  if (!labels) {
    return 'none';
  }
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, label]) => `${key}:${label}`)
    .join('|');
}

function catalogModelInfo(
  catalog: ManagementCatalogResponse,
  model: string,
): CatalogModelInfo | undefined {
  return catalog.models.find((m) => m.name === model);
}

function catalogModelFields(
  catalog: ManagementCatalogResponse,
  model: string,
  seen = new Set<string>(),
): readonly string[] {
  const info = catalogModelInfo(catalog, model);
  if (!info || seen.has(model)) {
    return [];
  }
  seen.add(model);

  const inherited = info.parentId ? catalogModelFields(catalog, info.parentId, seen) : [];
  return uniqueFields([...inherited, ...ownCatalogModelFields(info)]);
}

function modelFields(catalog: ManagementCatalogResponse, model: string): readonly string[] {
  return catalogModelFields(catalog, model);
}

function modelFieldLabels(
  catalog: ManagementCatalogResponse,
  model: string,
): FieldLabelMap | undefined {
  const labels = catalogModelFieldLabels(catalog, model);
  return Object.keys(labels).length > 0 ? labels : undefined;
}

function modelFieldTypes(
  catalog: ManagementCatalogResponse,
  model: string,
): ImportFieldTypeMap | undefined {
  const types = catalogModelFieldTypes(catalog, model);
  return Object.keys(types).length > 0 ? types : undefined;
}

function catalogModelFieldLabels(
  catalog: ManagementCatalogResponse,
  model: string,
  seen = new Set<string>(),
): FieldLabelMap {
  const info = catalogModelInfo(catalog, model);
  if (!info || seen.has(model)) {
    return {};
  }
  seen.add(model);

  return {
    ...(info.parentId ? catalogModelFieldLabels(catalog, info.parentId, seen) : {}),
    ...(info.fieldLabels ?? {}),
  };
}

function catalogModelFieldTypes(
  catalog: ManagementCatalogResponse,
  model: string,
  seen = new Set<string>(),
): ImportFieldTypeMap {
  const info = catalogModelInfo(catalog, model);
  if (!info || seen.has(model)) {
    return {};
  }
  seen.add(model);

  return {
    ...(info.parentId ? catalogModelFieldTypes(catalog, info.parentId, seen) : {}),
    ...(info.fieldTypes ?? {}),
  };
}

function catalogModelsForImport(catalog: ManagementCatalogResponse): readonly {
  name: string;
  displayName?: I18nDisplayMap;
  fields: readonly string[];
  fieldLabels?: FieldLabelMap;
  fieldTypes?: ImportFieldTypeMap;
}[] {
  return catalog.models.map((m) => ({
    name: m.name,
    displayName: m.displayName,
    fields: catalogModelFields(catalog, m.name),
    fieldLabels: modelFieldLabels(catalog, m.name),
    fieldTypes: modelFieldTypes(catalog, m.name),
  }));
}

function fieldsFromViewData(shape: ViewDataShape | null | undefined): readonly string[] {
  if (!shape || shape.kind === 'empty') {
    return [];
  }
  return propFieldsFromCatalogFields(shape.columns.map((c) => c.key));
}

/** Connected workspace: table / pivot / import with batch binding. */
export function DataWorkspace(props: DataWorkspaceProps): ReactElement {
  const {
    client,
    library,
    catalog,
    onCatalogRefresh,
    onCreateBackup,
    onRestoreBackup,
    onClearDatabase,
    onForceResetDatabase,
    onDisconnect,
  } = props;
  const { i18n, notify } = useStudio();
  useStudioLocale();

  const models = useMemo(() => catalog.models.map((m) => m.name).sort(), [catalog.models]);
  const initialModel = models.includes(getStoredModel('')) ? getStoredModel('') : (models[0] ?? '');
  const [selectedModel, setSelectedModel] = useState(initialModel);
  const [view, setView] = useState<StudioView>('table');
  const [nameDisplayMode, setNameDisplayMode] = useState<NameDisplayMode>(() =>
    getStoredNameDisplayMode('display'),
  );
  const [catalogRefreshing, setCatalogRefreshing] = useState(false);
  const autoRefreshKeyRef = useRef('');
  const libraryLabel = useMemo(
    () => databaseDisplayName(catalog, library, i18n.locale, nameDisplayMode),
    [catalog, i18n.locale, library, nameDisplayMode],
  );

  const fields = useMemo(() => modelFields(catalog, selectedModel), [catalog, selectedModel]);
  const fieldLabels = useMemo(
    () => modelFieldLabels(catalog, selectedModel),
    [catalog, selectedModel],
  );
  const importCatalogModels = useMemo(() => catalogModelsForImport(catalog), [catalog]);
  const importFieldTypes = useMemo(
    () => importFieldTypesForProps(fields, modelFieldTypes(catalog, selectedModel)),
    [fields, catalog, selectedModel],
  );
  const columnLabels = useMemo(
    () => buildFieldColumnLabels(fields, fieldLabels, i18n.locale, nameDisplayMode === 'display'),
    [fieldLabels, fields, i18n.locale, nameDisplayMode],
  );
  const importLabels = useMemo(() => buildImportPanelLabels(i18n), [i18n, i18n.locale]);
  const [dimA, setDimA] = useState('');
  const [dimB, setDimB] = useState('');

  const effectiveDimA = dimA || fields[0] || '';
  const effectiveDimB = dimB || fields[1] || '';

  const executor = useMemo(() => createSdkBindingExecutor(client), [client]);

  const querySnapshot = useMemo(
    () => createTabularSnapshot(selectedModel, { page: 0, limit: 50 }),
    [selectedModel],
  );

  const pivotConfig = useMemo((): PivotViewConfig | null => {
    if (view !== 'pivot') {
      return null;
    }
    const dimensions = [effectiveDimA, effectiveDimB].filter(
      (d, i, arr) => d.length > 0 && arr.indexOf(d) === i,
    );
    if (dimensions.length === 0) {
      return null;
    }
    return {
      originModel: selectedModel,
      dimensions,
      compute: { count: 'count' },
    };
  }, [view, selectedModel, effectiveDimA, effectiveDimB]);

  const handleModelChange = useCallback((model: string) => {
    persistModel(model);
    setSelectedModel(model);
    setDimA('');
    setDimB('');
  }, []);

  const toggleNameDisplayMode = useCallback(() => {
    setNameDisplayMode((prev) => {
      const next: NameDisplayMode = prev === 'display' ? 'name' : 'display';
      persistNameDisplayMode(next);
      return next;
    });
  }, []);

  const refreshCatalog = useCallback(
    async (silent = false): Promise<void> => {
      setCatalogRefreshing(true);
      try {
        await onCatalogRefresh();
        if (!silent) {
          notify.success(i18n.t('refresh'), library);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        notify.error(i18n.t('refresh'), msg);
      } finally {
        setCatalogRefreshing(false);
      }
    },
    [i18n, library, notify, onCatalogRefresh],
  );

  useEffect(() => {
    if (view !== 'import' || !selectedModel) {
      return;
    }
    const key = `${library}\0${selectedModel}`;
    if (autoRefreshKeyRef.current === key) {
      return;
    }
    autoRefreshKeyRef.current = key;
    void refreshCatalog(true);
  }, [library, refreshCatalog, selectedModel, view]);

  const providerKey =
    view === 'pivot'
      ? `${selectedModel}:pivot:${effectiveDimA}:${effectiveDimB}:${i18n.locale}:${nameDisplayMode}:${columnLabelSignature(columnLabels)}`
      : `${selectedModel}:${i18n.locale}:${nameDisplayMode}:${columnLabelSignature(columnLabels)}`;

  if (!selectedModel) {
    return (
      <div className="studio-connect-wrap">
        <p>{i18n.t('noModels', { library })}</p>
        <button type="button" className="studio-btn" onClick={onDisconnect}>
          {i18n.t('disconnect')}
        </button>
      </div>
    );
  }

  return (
    <div className="studio-shell">
      <header className="studio-topbar">
        <span className="studio-topbar-title">{libraryLabel}</span>
        <label className="studio-topbar-field">
          {i18n.t('model')}
          <select
            className="studio-select"
            value={selectedModel}
            onChange={(e) => handleModelChange(e.target.value)}
          >
            {models.map((m) => (
              <option key={m} value={m}>
                {modelDisplayName(catalog, m, i18n.locale, nameDisplayMode)}
              </option>
            ))}
          </select>
        </label>
        <label className="studio-topbar-field">
          {i18n.t('locale')}
          <select
            className="studio-select"
            value={i18n.locale}
            onChange={(e) => i18n.setLocale(e.target.value as StudioLocale)}
          >
            <option value="en">English</option>
            <option value="zh">中文</option>
            <option value="ja">日本語</option>
          </select>
        </label>
        <span className="studio-topbar-spacer" />
        <button
          type="button"
          className="studio-btn studio-btn--ghost"
          onClick={toggleNameDisplayMode}
        >
          {i18n.t(nameDisplayMode === 'display' ? 'nameModeDisplay' : 'nameModeUnique')}
        </button>
        <button
          type="button"
          className="studio-btn studio-btn--ghost"
          disabled={catalogRefreshing}
          onClick={() => void refreshCatalog(false)}
        >
          {catalogRefreshing ? i18n.t('loading') : i18n.t('refresh')}
        </button>
        <button type="button" className="studio-btn studio-btn--ghost" onClick={onDisconnect}>
          {i18n.t('disconnect')}
        </button>
        <button
          type="button"
          className="studio-btn studio-btn--ghost"
          onClick={() => void onCreateBackup()}
        >
          {i18n.t('backupCreate')}
        </button>
        <button
          type="button"
          className="studio-btn studio-btn--ghost"
          onClick={() => void onRestoreBackup()}
        >
          {i18n.t('backupRestore')}
        </button>
        <button
          type="button"
          className="studio-btn studio-btn--ghost"
          onClick={() => void onClearDatabase()}
        >
          {i18n.t('backupClear')}
        </button>
        <button
          type="button"
          className="studio-btn studio-btn--ghost"
          onClick={() => void onForceResetDatabase()}
        >
          {i18n.t('backupForceReset')}
        </button>
      </header>

      <DataPageProvider
        key={providerKey}
        executor={executor}
        querySnapshot={view !== 'pivot' ? querySnapshot : undefined}
        pivotConfig={pivotConfig}
        propFields={fields}
        columnLabels={columnLabels}
      >
        <WorkspaceBody
          view={view}
          onViewChange={setView}
          fields={fields}
          fieldLabels={fieldLabels}
          nameDisplayMode={nameDisplayMode}
          importCatalogModels={importCatalogModels}
          importLabels={importLabels}
          importFieldTypes={importFieldTypes}
          selectedModel={selectedModel}
          catalog={catalog}
          effectiveDimA={effectiveDimA}
          effectiveDimB={effectiveDimB}
          onDimA={setDimA}
          onDimB={setDimB}
          notify={notify}
          i18n={i18n}
        />
      </DataPageProvider>
    </div>
  );
}

function WorkspaceBody(props: {
  readonly view: StudioView;
  readonly onViewChange: (v: StudioView) => void;
  readonly fields: readonly string[];
  readonly fieldLabels: FieldLabelMap | undefined;
  readonly nameDisplayMode: NameDisplayMode;
  readonly importCatalogModels: readonly {
    name: string;
    fields: readonly string[];
    fieldLabels?: FieldLabelMap;
    displayName?: I18nDisplayMap;
    fieldTypes?: ImportFieldTypeMap;
  }[];
  readonly importLabels: ReturnType<typeof buildImportPanelLabels>;
  readonly importFieldTypes: ImportFieldTypeMap;
  readonly selectedModel: string;
  readonly catalog: ManagementCatalogResponse;
  readonly effectiveDimA: string;
  readonly effectiveDimB: string;
  readonly onDimA: (v: string) => void;
  readonly onDimB: (v: string) => void;
  readonly notify: StudioNotificationManager;
  readonly i18n: StudioI18n;
}): ReactElement {
  const {
    view,
    onViewChange,
    fields,
    fieldLabels,
    nameDisplayMode,
    importCatalogModels,
    importLabels,
    importFieldTypes,
    selectedModel,
    catalog,
    effectiveDimA,
    effectiveDimB,
    onDimA,
    onDimB,
    notify,
    i18n,
  } = props;

  const dataPage = useDataPage();
  const effectiveFields = useMemo(() => {
    if (fields.length > 0) {
      return fields;
    }
    return fieldsFromViewData(dataPage.viewData);
  }, [dataPage.viewData, fields]);
  const effectiveImportCatalogModels = useMemo(() => {
    if (fields.length > 0 || effectiveFields.length === 0) {
      return importCatalogModels;
    }
    return importCatalogModels.map((m) =>
      m.name === selectedModel ? { ...m, fields: effectiveFields } : m,
    );
  }, [effectiveFields, fields.length, importCatalogModels, selectedModel]);

  const handleImportCommitResult = useCallback(
    (result: Parameters<typeof notifyImportCommitResult>[0]) => {
      notifyImportCommitResult(result, i18n, notify);
    },
    [i18n, notify],
  );

  const tryViewChange = useCallback(
    (next: StudioView) => {
      if (next === view) {
        return;
      }
      if (dataPage.isDirty) {
        notify.warning(i18n.t('dirtyBlocked'), i18n.t('dirtyBlockedDetail'));
        return;
      }
      onViewChange(next);
    },
    [view, dataPage.isDirty, onViewChange, notify, i18n],
  );

  const views: { id: StudioView; labelKey: string }[] = [
    { id: 'table', labelKey: 'viewTable' },
    { id: 'pivot', labelKey: 'viewPivot' },
    { id: 'import', labelKey: 'viewImport' },
  ];

  return (
    <div className="studio-main">
      <div className="studio-topbar" style={{ borderTop: 'none' }}>
        <div className="studio-view-segment" role="tablist" aria-label="View">
          {views.map((v) => (
            <button
              key={v.id}
              type="button"
              role="tab"
              className="studio-segment-btn"
              aria-selected={view === v.id}
              aria-pressed={view === v.id}
              onClick={() => tryViewChange(v.id)}
            >
              {i18n.t(v.labelKey)}
            </button>
          ))}
        </div>
        {view === 'pivot' ? (
          <>
            <label className="studio-topbar-field">
              {i18n.t('dim1')}
              <select
                className="studio-select"
                value={effectiveDimA}
                onChange={(e) => onDimA(e.target.value)}
              >
                {fields.map((f) => (
                  <option key={f} value={f}>
                    {fieldDisplayName(fieldLabels, f, i18n.locale, nameDisplayMode)}
                  </option>
                ))}
              </select>
            </label>
            {fields.length > 1 ? (
              <label className="studio-topbar-field">
                {i18n.t('dim2')}
                <select
                  className="studio-select"
                  value={effectiveDimB}
                  onChange={(e) => onDimB(e.target.value)}
                >
                  {fields.map((f) => (
                    <option key={f} value={f}>
                      {fieldDisplayName(fieldLabels, f, i18n.locale, nameDisplayMode)}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </>
        ) : null}
      </div>

      <StudioToolbar importFieldTypes={view === 'import' ? importFieldTypes : undefined} />

      <div className={`studio-content${view === 'import' ? ' studio-content--import' : ''}`}>
        {view === 'import' ? (
          <ImportPanel
            targetModel={selectedModel}
            propFields={effectiveFields}
            catalogRelations={catalog.relations}
            catalogModels={effectiveImportCatalogModels}
            labels={importLabels}
            locale={i18n.locale}
            fieldLabels={fieldLabels}
            nameDisplayMode={nameDisplayMode}
            fieldTypes={importFieldTypes}
            onImportCommitResult={handleImportCommitResult}
          />
        ) : (
          <DataViewPanel />
        )}
      </div>
    </div>
  );
}

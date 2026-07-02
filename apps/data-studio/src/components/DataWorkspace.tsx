import { useCallback, useMemo, useState, type ReactElement } from 'react';
import type { ManagementCatalogResponse, RemoteModelDBClient } from '@mode-db/sdk';
import {
  createSdkBindingExecutor,
  createTabularSnapshot,
  importFieldTypesForProps,
  propFieldsFromCatalogFields,
  type FieldLabelMap,
  type ImportFieldTypeMap,
  type PivotViewConfig,
} from '@mode-db/data-kit';
import { DataPageProvider, DataViewPanel, ImportPanel, useDataPage } from '@mode-db/data-ui';
import { getStoredModel, persistModel } from '../config/connection-prefs.js';
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
  onDisconnect: () => void;
}

type StudioView = 'table' | 'pivot' | 'import';

function modelFields(catalog: ManagementCatalogResponse, model: string): readonly string[] {
  const info = catalog.models.find((m) => m.name === model);
  return propFieldsFromCatalogFields(info?.fields ?? []);
}

function modelFieldLabels(
  catalog: ManagementCatalogResponse,
  model: string,
): FieldLabelMap | undefined {
  const info = catalog.models.find((m) => m.name === model);
  return info?.fieldLabels;
}

function modelFieldTypes(
  catalog: ManagementCatalogResponse,
  model: string,
): ImportFieldTypeMap | undefined {
  const info = catalog.models.find((m) => m.name === model);
  return info?.fieldTypes;
}

function catalogModelsForImport(catalog: ManagementCatalogResponse): readonly {
  name: string;
  fields: readonly string[];
  fieldLabels?: FieldLabelMap;
  fieldTypes?: ImportFieldTypeMap;
}[] {
  return catalog.models.map((m) => ({
    name: m.name,
    fields: m.fields,
    fieldLabels: m.fieldLabels,
    fieldTypes: m.fieldTypes,
  }));
}

/** Connected workspace: table / pivot / import with batch binding. */
export function DataWorkspace(props: DataWorkspaceProps): ReactElement {
  const { client, library, catalog, onDisconnect } = props;
  const { i18n, notify } = useStudio();
  useStudioLocale();

  const models = useMemo(() => catalog.models.map((m) => m.name).sort(), [catalog.models]);
  const initialModel = models.includes(getStoredModel('')) ? getStoredModel('') : (models[0] ?? '');
  const [selectedModel, setSelectedModel] = useState(initialModel);
  const [view, setView] = useState<StudioView>('table');

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

  const providerKey =
    view === 'pivot' ? `${selectedModel}:pivot:${effectiveDimA}:${effectiveDimB}` : selectedModel;

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
        <span className="studio-topbar-title">{library}</span>
        <label className="studio-topbar-field">
          {i18n.t('model')}
          <select
            className="studio-select"
            value={selectedModel}
            onChange={(e) => handleModelChange(e.target.value)}
          >
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
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
        <button type="button" className="studio-btn studio-btn--ghost" onClick={onDisconnect}>
          {i18n.t('disconnect')}
        </button>
      </header>

      <DataPageProvider
        key={providerKey}
        executor={executor}
        querySnapshot={view !== 'pivot' ? querySnapshot : undefined}
        pivotConfig={pivotConfig}
        propFields={fields}
      >
        <WorkspaceBody
          view={view}
          onViewChange={setView}
          fields={fields}
          fieldLabels={fieldLabels}
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
  readonly importCatalogModels: readonly {
    name: string;
    fields: readonly string[];
    fieldLabels?: FieldLabelMap;
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
                    {f}
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
                      {f}
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
            propFields={fields}
            catalogRelations={catalog.relations}
            catalogModels={importCatalogModels}
            labels={importLabels}
            locale={i18n.locale}
            fieldLabels={fieldLabels}
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

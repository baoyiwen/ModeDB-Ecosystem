import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { createBindingSurfaceSession, type BindingSurfaceExecutor } from '@mode-db/data-kit';
import { queryInterfaceAccessKeyDigest, type BindingSurfaceValueSource } from '@mode-db/sdk';
import {
  BindingSurfaceForm,
  BindingSurfaceProvider,
  BindingSurfaceRelationEditor,
  BindingSurfaceStatus,
  BindingSurfaceTable,
  useAppConfirm,
} from '@mode-db/data-ui';
import { useDesigner } from '../context/designer-context.js';
import { withBusinessLibrarySession } from '../engine/business-library-session.js';
import {
  bindingSurfacePublicationSignature,
  assessBindingSurfaceReleaseImpact,
  compileBindingSurface,
  type BindingSurface,
  type BindingSurfaceMutationBinding,
  type BindingSurfaceRelease,
  type InterfaceParameter,
  type OperationInterface,
  type OperationInterfaceRelease,
  type QueryInterface,
  type QueryInterfaceRelease,
  type QueryResultField,
} from '../query-designer/index.js';
import { DesignerSelect } from './base/designer-select.js';
import { IconPlus, IconSave, IconTrash } from './designer-icons.js';
import type { SavedOperationInterfaceView } from './OperationDesignerPanel.js';
import type { SavedQueryInterfaceView } from './QueryDesignerPanel.js';
import { interfaceDiagnosticMessage } from '../utils/interface-diagnostic-i18n.js';
import {
  listBindingSurfaceAuditSummaries,
  type BindingSurfaceAuditSummary,
} from '../sync/binding-surface-registry.js';

type SurfaceView = 'design' | 'assets' | 'execute';
type SurfaceSaveStatus = 'created' | 'updated' | 'unchanged';
type SurfaceTestView = 'table' | 'form' | 'relations';
type SurfaceI18n = ReturnType<typeof useDesigner>['i18n'];

export interface SavedBindingSurfaceView {
  id: string;
  storageId?: string;
  name: string;
  bindingSurface: BindingSurface;
  createdAt: string;
  updatedAt: string;
  signature?: string;
  publishedRelease?: BindingSurfaceRelease;
  releaseHistory?: BindingSurfaceRelease[];
  auditSummary?: BindingSurfaceAuditSummary;
}

export function BindingSurfaceDesignerPanel(props: {
  savedBindingSurfaces: readonly SavedBindingSurfaceView[];
  activeBindingSurface: SavedBindingSurfaceView | undefined;
  savedQueryInterfaces: readonly SavedQueryInterfaceView[];
  savedOperationInterfaces: readonly SavedOperationInterfaceView[];
  onSaveBindingSurface: (
    surface: BindingSurface,
    name: string,
    description: string,
    activeId?: string,
  ) => { status: SurfaceSaveStatus; id: string; name: string };
  onClearActiveBindingSurface: () => void;
  onOpenBindingSurface: (id: string) => void;
  onPublishBindingSurface: (id: string) => void;
  onRollbackBindingSurface: (id: string, version: string) => void;
  onDeprecateBindingSurface: (id: string) => void;
  onDeleteBindingSurface: (id: string) => void;
}): ReactElement {
  const { i18n, config } = useDesigner();
  const confirm = useAppConfirm();
  const [view, setView] = useState<SurfaceView>('design');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [queryKey, setQueryKey] = useState('');
  const [writeMode, setWriteMode] = useState<'readonly' | 'explicit'>('readonly');
  const [refresh, setRefresh] = useState<'manual' | 'afterMutation'>('afterMutation');
  const [permissionMode, setPermissionMode] = useState<'none' | 'key' | 'disabled'>('none');
  const [accessKey, setAccessKey] = useState('');
  const [rateLimitEnabled, setRateLimitEnabled] = useState(false);
  const [rateRequests, setRateRequests] = useState(60);
  const [rateWindow, setRateWindow] = useState(60);
  const [parameters, setParameters] = useState<InterfaceParameter[]>([]);
  const [mutations, setMutations] = useState<BindingSurfaceMutationBinding[]>([]);
  const [saveStatus, setSaveStatus] = useState<SurfaceSaveStatus | 'idle'>('idle');
  const [testValues, setTestValues] = useState<Record<string, string>>({});
  const [testSurfaceAccessKey, setTestSurfaceAccessKey] = useState('');
  const [testAccessKeys, setTestAccessKeys] = useState<Record<string, string>>({});
  const [testMutationId, setTestMutationId] = useState('');
  const [testRowIndex, setTestRowIndex] = useState(0);
  const [testEditedValue, setTestEditedValue] = useState('');
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<unknown>();
  const [testError, setTestError] = useState('');
  const [testView, setTestView] = useState<SurfaceTestView>('table');
  const [auditSummaries, setAuditSummaries] = useState<
    ReadonlyMap<string, BindingSurfaceAuditSummary>
  >(new Map());
  const [refreshingAudit, setRefreshingAudit] = useState(false);

  const queryReleases = useMemo(
    () => activeQueryReleases(props.savedQueryInterfaces),
    [props.savedQueryInterfaces],
  );
  const operationReleases = useMemo(
    () => activeOperationReleases(props.savedOperationInterfaces),
    [props.savedOperationInterfaces],
  );
  const selectedQuery = queryReleases.find((release) => releaseKey(release) === queryKey);
  const activeVersion = props.activeBindingSurface
    ? `${props.activeBindingSurface.id}:${props.activeBindingSurface.updatedAt}`
    : '';

  useEffect(() => {
    const active = props.activeBindingSurface;
    if (!active) {
      const first = queryReleases[0];
      setName('');
      setDescription('');
      setQueryKey(first ? releaseKey(first) : '');
      setWriteMode('readonly');
      setRefresh('afterMutation');
      setPermissionMode('none');
      setAccessKey('');
      setRateLimitEnabled(false);
      setRateRequests(60);
      setRateWindow(60);
      setParameters(first ? cloneParameters(first.queryInterface.contract.parameters) : []);
      setMutations([]);
      setSaveStatus('idle');
      setTestValues({});
      setTestSurfaceAccessKey('');
      setTestAccessKeys({});
      setTestMutationId('');
      setTestResult(undefined);
      setTestError('');
      setTestView('table');
      return;
    }
    const surface = active.bindingSurface;
    setName(active.name);
    setDescription(surface.description ?? '');
    setQueryKey(`${surface.query.interfaceId}@${surface.query.version}`);
    setWriteMode(surface.writeback.mode);
    setRefresh(surface.writeback.refresh);
    setPermissionMode(
      surface.permissions?.mode === 'key' || surface.permissions?.mode === 'disabled'
        ? surface.permissions.mode
        : 'none',
    );
    setAccessKey('');
    setRateLimitEnabled(Boolean(surface.permissions?.rateLimit));
    setRateRequests(surface.permissions?.rateLimit?.maxRequests ?? 60);
    setRateWindow(surface.permissions?.rateLimit?.windowSeconds ?? 60);
    setParameters(cloneParameters(surface.parameters));
    setMutations(structuredClone(surface.writeback.mutations));
    setSaveStatus('idle');
    setTestValues({});
    setTestSurfaceAccessKey('');
    setTestAccessKeys({});
    setTestMutationId(surface.writeback.mutations[0]?.id ?? '');
    setTestResult(undefined);
    setTestError('');
    setTestView('table');
  }, [activeVersion, props.activeBindingSurface, queryReleases]);

  const draft = useMemo(
    () =>
      buildSurfaceDraft({
        active: props.activeBindingSurface?.bindingSurface,
        name,
        description,
        queryRelease: selectedQuery,
        parameters,
        permissionMode,
        accessKey,
        rateLimitEnabled,
        rateRequests,
        rateWindow,
        writeMode,
        refresh,
        mutations: writeMode === 'explicit' ? mutations : [],
      }),
    [
      description,
      mutations,
      name,
      parameters,
      permissionMode,
      props.activeBindingSurface?.bindingSurface,
      accessKey,
      rateLimitEnabled,
      rateRequests,
      rateWindow,
      refresh,
      selectedQuery,
      writeMode,
    ],
  );
  const compilation = useMemo(
    () =>
      draft
        ? compileBindingSurface({
            surface: draft,
            queryReleases,
            operationReleases,
          })
        : { diagnostics: [] },
    [draft, operationReleases, queryReleases],
  );
  const blocking = !draft || compilation.diagnostics.some((item) => item.severity === 'error');
  const published = props.activeBindingSurface?.publishedRelease;
  const testExecutor = useMemo<BindingSurfaceExecutor | undefined>(() => {
    const libraryName = config.activeLibraryName;
    if (!libraryName) {
      return undefined;
    }
    return {
      invokeBindingSurface(surfaceId, options) {
        return withBusinessLibrarySession(libraryName, (client) =>
          client.invokeBindingSurface(surfaceId, options),
        );
      },
    };
  }, [config.activeLibraryName]);
  const testSession = useMemo(
    () =>
      published && testExecutor
        ? createBindingSurfaceSession({
            surfaceId: published.contract.surfaceId,
            version: published.version,
            parameters: parameterValues(published.contract.parameters, testValues),
            accessKey: testSurfaceAccessKey.trim() || undefined,
            accessKeys: nonEmptyRecord(testAccessKeys),
            executor: testExecutor,
          })
        : undefined,
    [published, testAccessKeys, testExecutor, testSurfaceAccessKey, testValues],
  );

  const refreshAudit = async (): Promise<void> => {
    if (!config.remoteClient || !config.activeLibraryName || refreshingAudit) {
      return;
    }
    setRefreshingAudit(true);
    try {
      setAuditSummaries(
        await listBindingSurfaceAuditSummaries(config.remoteClient, config.activeLibraryName),
      );
    } finally {
      setRefreshingAudit(false);
    }
  };

  const selectQuery = (value: string): void => {
    const release = queryReleases.find((candidate) => releaseKey(candidate) === value);
    setQueryKey(value);
    if (release) {
      setParameters(cloneParameters(release.queryInterface.contract.parameters));
      setMutations([]);
      setWriteMode('readonly');
    }
  };

  const addMutation = (): void => {
    if (!selectedQuery) {
      return;
    }
    const release = operationReleases.find((candidate) =>
      operationCanTargetQuery(candidate.operationInterface, selectedQuery.queryInterface),
    );
    if (!release) {
      return;
    }
    const mutation = defaultMutation(release, selectedQuery.queryInterface, parameters, mutations);
    setMutations((current) => [...current, mutation]);
    setWriteMode('explicit');
    setTestMutationId(mutation.id);
  };

  const save = (): void => {
    if (!draft || blocking || !name.trim()) {
      return;
    }
    const result = props.onSaveBindingSurface(
      draft,
      name,
      description,
      props.activeBindingSurface?.id,
    );
    setSaveStatus(result.status);
  };

  const execute = async (action: 'read' | 'mutate'): Promise<void> => {
    if (!published || !testSession) {
      return;
    }
    setTestBusy(true);
    setTestError('');
    try {
      await testSession.refresh();
      const result =
        action === 'read'
          ? testSession.lastResult
          : await testSession.mutate({
              mutationId: testMutationId,
              rowIndex: testRowIndex,
              editedValue: parseLooseValue(testEditedValue),
            });
      setTestResult(result);
      await refreshAudit();
    } catch (error) {
      setTestError(error instanceof Error ? error.message : String(error));
    } finally {
      setTestBusy(false);
    }
  };

  return (
    <div className="binding-surface-panel">
      <div className="query-designer-tabs binding-surface-tabs" role="tablist">
        {(['design', 'assets', 'execute'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            className="query-designer-tab"
            data-active={view === tab}
            onClick={() => setView(tab)}
          >
            {i18n.t('ui', `bindingSurface${capitalize(tab)}`)}
            {tab === 'assets' ? ` (${props.savedBindingSurfaces.length})` : ''}
          </button>
        ))}
      </div>

      {view === 'design' ? (
        <div className="binding-surface-stack">
          <div className="operation-designer-toolbar">
            <button
              type="button"
              className="query-designer-button"
              onClick={() => props.onClearActiveBindingSurface()}
            >
              <IconPlus />
              {i18n.t('ui', 'bindingSurfaceNew')}
            </button>
            {props.activeBindingSurface ? (
              <span className="operation-designer-version">
                v{props.activeBindingSurface.bindingSurface.version.current}
              </span>
            ) : null}
          </div>

          <section className="query-designer-section operation-designer-contract-grid">
            <label className="operation-designer-field operation-designer-wide">
              <span>{i18n.t('ui', 'bindingSurfaceName')}</span>
              <input
                className="query-interface-name-input"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="operation-designer-field operation-designer-wide">
              <span>{i18n.t('ui', 'bindingSurfaceDescription')}</span>
              <textarea
                className="query-interface-description-input"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
            <label className="operation-designer-field operation-designer-wide">
              <span>{i18n.t('ui', 'bindingSurfaceQuery')}</span>
              <DesignerSelect
                value={queryKey}
                searchable
                options={queryReleases.map((release) => ({
                  value: releaseKey(release),
                  label: `${release.queryInterface.displayName ?? release.callableName} v${release.version}`,
                }))}
                onChange={selectQuery}
              />
            </label>
            <label className="operation-designer-field">
              <span>{i18n.t('ui', 'bindingSurfaceWriteMode')}</span>
              <DesignerSelect
                value={writeMode}
                options={(['readonly', 'explicit'] as const).map((value) => ({
                  value,
                  label: i18n.t('ui', `bindingSurfaceMode${capitalize(value)}`),
                }))}
                onChange={(value) => {
                  const mode = value as 'readonly' | 'explicit';
                  setWriteMode(mode);
                  if (mode === 'readonly') {
                    setMutations([]);
                  }
                }}
              />
            </label>
            <label className="operation-designer-field">
              <span>{i18n.t('ui', 'bindingSurfaceRefresh')}</span>
              <DesignerSelect
                value={refresh}
                options={(['afterMutation', 'manual'] as const).map((value) => ({
                  value,
                  label: i18n.t('ui', `bindingSurfaceRefresh${capitalize(value)}`),
                }))}
                onChange={(value) => setRefresh(value as 'manual' | 'afterMutation')}
              />
            </label>
            <label className="operation-designer-field">
              <span>{i18n.t('ui', 'operationAccess')}</span>
              <DesignerSelect
                value={permissionMode}
                options={(['none', 'key', 'disabled'] as const).map((value) => ({
                  value,
                  label: i18n.t(
                    'ui',
                    value === 'none'
                      ? 'operationAccessNone'
                      : value === 'key'
                        ? 'operationAccessKey'
                        : 'operationAccessDisabled',
                  ),
                }))}
                onChange={(value) => setPermissionMode(value as 'none' | 'key' | 'disabled')}
              />
            </label>
            {permissionMode === 'key' ? (
              <input
                className="query-interface-name-input operation-designer-wide"
                type="password"
                value={accessKey}
                placeholder={i18n.t('ui', 'operationAccessKeyPlaceholder')}
                onChange={(event) => setAccessKey(event.target.value)}
              />
            ) : null}
            <label className="query-interface-rate-limit-toggle operation-designer-wide">
              <input
                type="checkbox"
                checked={rateLimitEnabled}
                onChange={(event) => setRateLimitEnabled(event.target.checked)}
              />
              {i18n.t('ui', 'operationRateLimit')}
            </label>
            {rateLimitEnabled ? (
              <div className="query-interface-rate-limit-fields operation-designer-wide">
                <label className="operation-designer-field">
                  <span>{i18n.t('ui', 'operationRateRequests')}</span>
                  <input
                    className="query-interface-name-input"
                    type="number"
                    min={1}
                    value={rateRequests}
                    onChange={(event) => setRateRequests(Number(event.target.value))}
                  />
                </label>
                <label className="operation-designer-field">
                  <span>{i18n.t('ui', 'operationRateWindow')}</span>
                  <input
                    className="query-interface-name-input"
                    type="number"
                    min={1}
                    value={rateWindow}
                    onChange={(event) => setRateWindow(Number(event.target.value))}
                  />
                </label>
              </div>
            ) : null}
          </section>

          <section className="query-designer-section">
            <div className="query-designer-section-heading">
              <h3 className="designer-panel-section-title">
                {i18n.t('ui', 'bindingSurfaceMutations')}
              </h3>
              <button
                type="button"
                className="query-designer-button"
                disabled={!selectedQuery || operationReleases.length === 0}
                onClick={addMutation}
              >
                <IconPlus />
                {i18n.t('ui', 'bindingSurfaceAddMutation')}
              </button>
            </div>
            <div className="binding-surface-mutations">
              {mutations.map((mutation, index) => (
                <MutationEditor
                  key={`${mutation.id}:${index}`}
                  mutation={mutation}
                  query={selectedQuery?.queryInterface}
                  surfaceParameters={parameters}
                  operationReleases={operationReleases}
                  onChange={(next) =>
                    setMutations((current) =>
                      current.map((candidate, candidateIndex) =>
                        candidateIndex === index ? next : candidate,
                      ),
                    )
                  }
                  onDelete={() =>
                    setMutations((current) =>
                      current.filter((_candidate, candidateIndex) => candidateIndex !== index),
                    )
                  }
                />
              ))}
              {mutations.length === 0 ? (
                <p className="query-designer-empty">
                  {i18n.t('ui', 'bindingSurfaceMutationEmpty')}
                </p>
              ) : null}
            </div>
          </section>

          {compilation.diagnostics.length > 0 ? (
            <section className="query-designer-section">
              <h3 className="designer-panel-section-title">
                {i18n.t('ui', 'bindingSurfaceValidation')}
              </h3>
              <ul className="query-designer-issues">
                {compilation.diagnostics.map((issue, index) => (
                  <li
                    key={`${issue.code}:${issue.path ?? ''}:${index}`}
                    data-severity={issue.severity}
                  >
                    {interfaceDiagnosticMessage(i18n, issue)}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <div className="operation-designer-savebar">
            <button
              type="button"
              className="query-designer-button operation-designer-primary"
              disabled={blocking || !name.trim()}
              onClick={save}
            >
              <IconSave />
              {i18n.t('ui', 'bindingSurfaceSave')}
            </button>
            {saveStatus !== 'idle' ? (
              <span className="query-interface-save-feedback" data-status={saveStatus}>
                {i18n.t('ui', 'bindingSurfaceSaved')}
              </span>
            ) : null}
          </div>
        </div>
      ) : view === 'assets' ? (
        <div className="binding-surface-stack">
          <div className="operation-designer-toolbar">
            <button
              type="button"
              className="query-designer-button"
              disabled={refreshingAudit}
              onClick={() => void refreshAudit()}
            >
              {i18n.t('ui', 'bindingSurfaceAuditRefresh')}
            </button>
          </div>
          {props.savedBindingSurfaces.length === 0 ? (
            <p className="query-designer-empty">{i18n.t('ui', 'bindingSurfaceEmpty')}</p>
          ) : (
            props.savedBindingSurfaces.map((item) => (
              <section
                key={item.id}
                className="query-interface-card operation-interface-card"
                data-active={item.id === props.activeBindingSurface?.id}
              >
                <div className="query-interface-card-header">
                  <div>
                    <strong>{item.name}</strong>
                    <code>{item.bindingSurface.name}</code>
                  </div>
                  <span
                    className="operation-interface-status"
                    data-status={item.publishedRelease?.bindingSurface.status ?? 'draft'}
                  >
                    {item.publishedRelease?.bindingSurface.status ?? 'draft'}
                  </span>
                </div>
                <div className="query-interface-card-meta">
                  <span>
                    v{item.publishedRelease?.version ?? item.bindingSurface.version.current}
                  </span>
                  <span>
                    {i18n.t('ui', 'bindingSurfaceMutationCount', {
                      count: String(item.bindingSurface.writeback.mutations.length),
                    })}
                  </span>
                </div>
                <div className="binding-surface-ledger">
                  {[item.publishedRelease, ...(item.releaseHistory ?? [])]
                    .filter((release): release is BindingSurfaceRelease => Boolean(release))
                    .sort((left, right) =>
                      right.version.localeCompare(left.version, undefined, { numeric: true }),
                    )
                    .map((release) => (
                      <span key={`${release.version}:${release.signature}`}>
                        <code>v{release.version}</code>
                        <small>
                          {release.version === item.publishedRelease?.version
                            ? i18n.t('ui', 'releaseCurrent')
                            : i18n.t(
                                'ui',
                                `releaseImpact${capitalize(
                                  assessBindingSurfaceReleaseImpact(
                                    release.bindingSurface,
                                    item.publishedRelease,
                                  ).level,
                                )}`,
                              )}
                        </small>
                        <time dateTime={release.publishedAt}>
                          {new Date(release.publishedAt).toLocaleDateString(i18n.locale)}
                        </time>
                        {item.publishedRelease &&
                        release.version !== item.publishedRelease.version &&
                        release.signature !== item.publishedRelease.signature ? (
                          <button
                            type="button"
                            className="query-interface-release-rollback"
                            onClick={async () => {
                              if (
                                await confirm({
                                  title: `${i18n.t('ui', 'releaseRollback')} v${release.version}`,
                                  message: i18n.t('ui', 'releaseRollbackConfirm'),
                                  tone: 'danger',
                                })
                              ) {
                                props.onRollbackBindingSurface(item.id, release.version);
                              }
                            }}
                          >
                            {i18n.t('ui', 'releaseRollback')}
                          </button>
                        ) : null}
                      </span>
                    ))}
                </div>
                <BindingSurfaceAuditView
                  summary={auditSummaries.get(item.id) ?? item.auditSummary}
                />
                <div className="query-designer-actions operation-interface-actions">
                  <button
                    type="button"
                    className="query-designer-button"
                    onClick={() => {
                      props.onOpenBindingSurface(item.id);
                      setView('design');
                    }}
                  >
                    {i18n.t('ui', 'bindingSurfaceOpen')}
                  </button>
                  <button
                    type="button"
                    className="query-designer-button operation-designer-primary"
                    onClick={() => props.onPublishBindingSurface(item.id)}
                  >
                    {i18n.t('ui', 'bindingSurfacePublish')}
                  </button>
                  {item.publishedRelease?.bindingSurface.status === 'active' ? (
                    <button
                      type="button"
                      className="query-designer-button"
                      onClick={() => props.onDeprecateBindingSurface(item.id)}
                    >
                      {i18n.t('ui', 'bindingSurfaceDeprecate')}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="query-designer-button operation-interface-delete"
                    title={i18n.t('ui', 'bindingSurfaceRemove')}
                    aria-label={i18n.t('ui', 'bindingSurfaceRemove')}
                    onClick={async () => {
                      if (
                        await confirm({
                          title: i18n.t('ui', 'bindingSurfaceRemoveConfirm', { name: item.name }),
                          tone: 'danger',
                        })
                      ) {
                        props.onDeleteBindingSurface(item.id);
                      }
                    }}
                  >
                    <IconTrash />
                  </button>
                </div>
              </section>
            ))
          )}
        </div>
      ) : (
        <div className="binding-surface-stack">
          {!published ? (
            <p className="query-designer-empty">
              {i18n.t('ui', 'bindingSurfaceExecuteUnpublished')}
            </p>
          ) : (
            <>
              <section className="query-designer-section operation-designer-contract-grid">
                {published.contract.permissions?.mode === 'key' ? (
                  <label className="operation-designer-field">
                    <span>{i18n.t('ui', 'bindingSurfacePolicyAccessKey')}</span>
                    <input
                      className="query-interface-name-input"
                      type="password"
                      value={testSurfaceAccessKey}
                      onChange={(event) => setTestSurfaceAccessKey(event.target.value)}
                    />
                  </label>
                ) : null}
                {published.contract.parameters.map((parameter) => (
                  <label key={parameter.id} className="operation-designer-field">
                    <span>{parameter.name}</span>
                    <input
                      className="query-interface-name-input"
                      value={testValues[parameter.id] ?? ''}
                      onChange={(event) =>
                        setTestValues((current) => ({
                          ...current,
                          [parameter.id]: event.target.value,
                        }))
                      }
                    />
                  </label>
                ))}
                {published.contract.query ? (
                  <label className="operation-designer-field">
                    <span>{i18n.t('ui', 'bindingSurfaceAccessKey')}</span>
                    <input
                      className="query-interface-name-input"
                      type="password"
                      value={testAccessKeys[published.contract.query.interfaceId] ?? ''}
                      onChange={(event) =>
                        setTestAccessKeys((current) => ({
                          ...current,
                          [published.contract.query.interfaceId]: event.target.value,
                        }))
                      }
                    />
                  </label>
                ) : null}
                {uniqueOperationReferences(published.contract.writeback.mutations).map(
                  (operation) => (
                    <label key={operation.interfaceId} className="operation-designer-field">
                      <span>{operation.callableName}</span>
                      <input
                        className="query-interface-name-input"
                        type="password"
                        value={testAccessKeys[operation.interfaceId] ?? ''}
                        placeholder={i18n.t('ui', 'bindingSurfaceAccessKey')}
                        onChange={(event) =>
                          setTestAccessKeys((current) => ({
                            ...current,
                            [operation.interfaceId]: event.target.value,
                          }))
                        }
                      />
                    </label>
                  ),
                )}
              </section>
              {published.contract.writeback.mutations.length > 0 ? (
                <section className="query-designer-section operation-designer-contract-grid">
                  <label className="operation-designer-field operation-designer-wide">
                    <span>{i18n.t('ui', 'bindingSurfaceTestMutation')}</span>
                    <DesignerSelect
                      value={testMutationId}
                      options={published.contract.writeback.mutations.map((mutation) => ({
                        value: mutation.id,
                        label: mutation.id,
                      }))}
                      onChange={setTestMutationId}
                    />
                  </label>
                  <label className="operation-designer-field">
                    <span>{i18n.t('ui', 'bindingSurfaceTestRow')}</span>
                    <input
                      className="query-interface-name-input"
                      type="number"
                      min={0}
                      value={testRowIndex}
                      onChange={(event) => setTestRowIndex(Number(event.target.value))}
                    />
                  </label>
                  <label className="operation-designer-field">
                    <span>{i18n.t('ui', 'bindingSurfaceEditedValue')}</span>
                    <input
                      className="query-interface-name-input"
                      value={testEditedValue}
                      onChange={(event) => setTestEditedValue(event.target.value)}
                    />
                  </label>
                </section>
              ) : null}
              <div className="query-designer-actions">
                <button
                  type="button"
                  className="query-designer-button operation-designer-primary"
                  disabled={testBusy}
                  onClick={() => void execute('read')}
                >
                  {i18n.t('ui', testBusy ? 'bindingSurfaceRunning' : 'bindingSurfaceRunRead')}
                </button>
                <button
                  type="button"
                  className="query-designer-button"
                  disabled={testBusy || !testMutationId}
                  onClick={() => void execute('mutate')}
                >
                  {i18n.t('ui', 'bindingSurfaceRunMutation')}
                </button>
              </div>
              {testError ? <p className="query-designer-error">{testError}</p> : null}
              {testSession?.viewData ? (
                <BindingSurfaceProvider
                  contract={published.contract}
                  session={testSession}
                  autoRefresh={false}
                  onError={(error) =>
                    setTestError(error instanceof Error ? error.message : String(error))
                  }
                >
                  <BindingSurfaceStatus
                    labels={bindingSurfaceStatusLabels(i18n)}
                    onError={(error) =>
                      setTestError(error instanceof Error ? error.message : String(error))
                    }
                  />
                  <div className="query-designer-tabs binding-surface-test-tabs" role="tablist">
                    {(['table', 'form', 'relations'] as const).map((testTab) => (
                      <button
                        key={testTab}
                        type="button"
                        className="query-designer-tab"
                        data-active={testView === testTab}
                        onClick={() => setTestView(testTab)}
                      >
                        {i18n.t('ui', `bindingSurfaceTest${capitalize(testTab)}`)}
                      </button>
                    ))}
                  </div>
                  {testView === 'table' ? (
                    <BindingSurfaceTable
                      labels={bindingSurfaceTableLabels(i18n)}
                      onMutationSuccess={() => {
                        setTestResult(testSession.lastResult);
                        void refreshAudit();
                      }}
                      onError={(error) =>
                        setTestError(error instanceof Error ? error.message : String(error))
                      }
                    />
                  ) : testView === 'form' ? (
                    <BindingSurfaceForm
                      rowIndex={testRowIndex}
                      labels={bindingSurfaceFormLabels(i18n)}
                      onMutationSuccess={() => {
                        setTestResult(testSession.lastResult);
                        void refreshAudit();
                      }}
                      onError={(error) =>
                        setTestError(error instanceof Error ? error.message : String(error))
                      }
                    />
                  ) : (
                    <BindingSurfaceRelationEditor
                      rowIndex={testRowIndex}
                      labels={bindingSurfaceRelationLabels(i18n)}
                      onMutationSuccess={() => {
                        setTestResult(testSession.lastResult);
                        void refreshAudit();
                      }}
                      onError={(error) =>
                        setTestError(error instanceof Error ? error.message : String(error))
                      }
                    />
                  )}
                </BindingSurfaceProvider>
              ) : null}
              {testResult !== undefined ? (
                <pre className="query-preview-json">{JSON.stringify(testResult, null, 2)}</pre>
              ) : null}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function MutationEditor(props: {
  mutation: BindingSurfaceMutationBinding;
  query: QueryInterface | undefined;
  surfaceParameters: readonly InterfaceParameter[];
  operationReleases: readonly OperationInterfaceRelease[];
  onChange: (mutation: BindingSurfaceMutationBinding) => void;
  onDelete: () => void;
}): ReactElement {
  const { i18n } = useDesigner();
  const release = props.operationReleases.find(
    (candidate) =>
      candidate.operationInterface.id === props.mutation.operation.interfaceId &&
      candidate.version === props.mutation.operation.version,
  );
  const query = props.query;
  const fields = query ? flattenResultFields(query.query.result.schema) : [];
  const triggerTargets = triggerTargetOptions(release?.operationInterface, query, fields);
  const selectedTarget = triggerValue(props.mutation.trigger);
  return (
    <div className="binding-surface-mutation">
      <div className="binding-surface-mutation-header">
        <input
          className="query-interface-name-input"
          value={props.mutation.id}
          onChange={(event) => props.onChange({ ...props.mutation, id: event.target.value })}
        />
        <button
          type="button"
          className="query-designer-button operation-interface-delete"
          title={i18n.t('ui', 'bindingSurfaceRemoveMutation')}
          aria-label={i18n.t('ui', 'bindingSurfaceRemoveMutation')}
          onClick={props.onDelete}
        >
          <IconTrash />
        </button>
      </div>
      <div className="operation-designer-contract-grid">
        <label className="operation-designer-field">
          <span>{i18n.t('ui', 'bindingSurfaceOperation')}</span>
          <DesignerSelect
            value={release ? releaseKey(release) : ''}
            searchable
            options={props.operationReleases.map((candidate) => ({
              value: releaseKey(candidate),
              label: `${candidate.operationInterface.displayName ?? candidate.callableName} v${candidate.version}`,
            }))}
            onChange={(value) => {
              const next = props.operationReleases.find(
                (candidate) => releaseKey(candidate) === value,
              );
              if (next && query) {
                props.onChange({
                  ...defaultMutation(next, query, props.surfaceParameters, []),
                  id: props.mutation.id,
                });
              }
            }}
          />
        </label>
        <label className="operation-designer-field">
          <span>{i18n.t('ui', 'bindingSurfaceTrigger')}</span>
          <DesignerSelect
            value={selectedTarget}
            options={triggerTargets}
            onChange={(value) =>
              props.onChange({
                ...props.mutation,
                trigger: triggerForOperation(release?.operationInterface, value),
              })
            }
          />
        </label>
      </div>
      <div className="binding-surface-parameter-list">
        {(release?.operationInterface.contract.parameters ?? []).map((parameter) => {
          const binding = props.mutation.parameterBindings.find(
            (candidate) => candidate.parameterId === parameter.id,
          ) ?? { parameterId: parameter.id, source: { kind: 'literal', value: '' } as const };
          const availableKinds = valueSourceKinds(props.mutation.trigger.kind);
          return (
            <div key={parameter.id} className="binding-surface-parameter-row">
              <span>
                <strong>{parameter.name}</strong>
                <small>{parameter.type}</small>
              </span>
              <DesignerSelect
                value={binding.source.kind}
                options={availableKinds.map((kind) => ({
                  value: kind,
                  label: i18n.t('ui', `bindingSurfaceSource${capitalize(kind)}`),
                }))}
                onChange={(value) =>
                  props.onChange(
                    replaceParameterBinding(
                      props.mutation,
                      parameter.id,
                      defaultSource(value as BindingSurfaceValueSource['kind'], props),
                    ),
                  )
                }
              />
              <ValueSourceEditor
                source={binding.source}
                query={query}
                surfaceParameters={props.surfaceParameters}
                onChange={(source) =>
                  props.onChange(replaceParameterBinding(props.mutation, parameter.id, source))
                }
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ValueSourceEditor(props: {
  source: BindingSurfaceValueSource;
  query: QueryInterface | undefined;
  surfaceParameters: readonly InterfaceParameter[];
  onChange: (source: BindingSurfaceValueSource) => void;
}): ReactElement | null {
  const { i18n } = useDesigner();
  if (props.source.kind === 'editedValue') {
    return null;
  }
  if (props.source.kind === 'literal') {
    return (
      <input
        className="query-interface-name-input"
        value={stringifyLooseValue(props.source.value)}
        onChange={(event) =>
          props.onChange({ kind: 'literal', value: parseLooseValue(event.target.value) })
        }
      />
    );
  }
  const options =
    props.source.kind === 'surfaceParameter'
      ? props.surfaceParameters.map((parameter) => ({
          value: parameter.id,
          label: parameter.label ?? parameter.name,
        }))
      : props.source.kind === 'rowRecordRef'
        ? (props.query?.designGraph.nodes ?? []).map((node) => ({
            value: node.id,
            label: node.alias || node.modelId,
          }))
        : flattenResultFields(props.query?.query.result.schema ?? []).map((field) => ({
            value: field.path,
            label: field.path,
          }));
  const value =
    props.source.kind === 'surfaceParameter'
      ? props.source.parameterId
      : props.source.kind === 'rowRecordRef'
        ? props.source.nodeId
        : props.source.fieldPath;
  return (
    <DesignerSelect
      value={value}
      searchable
      options={options}
      placeholder={i18n.t('ui', 'bindingSurfaceSourceValue')}
      onChange={(next) => {
        if (props.source.kind === 'surfaceParameter') {
          props.onChange({ kind: 'surfaceParameter', parameterId: next });
        } else if (props.source.kind === 'rowRecordRef') {
          props.onChange({ kind: 'rowRecordRef', nodeId: next });
        } else {
          props.onChange({ kind: 'rowField', fieldPath: next });
        }
      }}
    />
  );
}

function BindingSurfaceAuditView(props: {
  summary: BindingSurfaceAuditSummary | undefined;
}): ReactElement {
  const { i18n } = useDesigner();
  const summary: BindingSurfaceAuditSummary = props.summary ?? {
    callCount: 0,
    successCount: 0,
    refreshFailureCount: 0,
    errorCount: 0,
    averageDurationMs: 0,
    trend: [],
    recentCalls: [],
  };
  const peak = Math.max(1, ...summary.trend.map((point) => point.callCount));
  return (
    <div className="query-interface-doc-section">
      <span className="query-interface-doc-section-title">
        {i18n.t('ui', 'bindingSurfaceAuditTitle')}
      </span>
      <div className="query-interface-doc-stats">
        <span className="query-interface-doc-stat">
          <strong>{summary.callCount}</strong>
          <span>{i18n.t('ui', 'bindingSurfaceAuditCalls')}</span>
        </span>
        <span className="query-interface-doc-stat">
          <strong>{summary.successCount}</strong>
          <span>{i18n.t('ui', 'bindingSurfaceAuditSuccess')}</span>
        </span>
        <span className="query-interface-doc-stat">
          <strong>{summary.refreshFailureCount}</strong>
          <span>{i18n.t('ui', 'bindingSurfaceAuditRefreshFailed')}</span>
        </span>
        <span className="query-interface-doc-stat">
          <strong>{summary.errorCount}</strong>
          <span>{i18n.t('ui', 'bindingSurfaceAuditErrors')}</span>
        </span>
        <span className="query-interface-doc-stat">
          <strong>{summary.averageDurationMs}</strong>
          <span>{i18n.t('ui', 'bindingSurfaceAuditAverage')}</span>
        </span>
      </div>
      <div
        className="query-interface-audit-trend"
        role="img"
        aria-label={i18n.t('ui', 'bindingSurfaceAuditTitle')}
      >
        {summary.trend.map((point) => {
          const height = point.callCount > 0 ? Math.max(8, (point.callCount / peak) * 100) : 0;
          const failureRatio =
            point.callCount > 0
              ? ((point.refreshFailureCount + point.errorCount) / point.callCount) * 100
              : 0;
          return (
            <span
              key={point.bucketStart}
              className="query-interface-audit-bar-slot"
              title={`${new Date(point.bucketStart).toLocaleString(i18n.locale)} | ${point.callCount}`}
            >
              <span className="query-interface-audit-bar" style={{ height: `${height}%` }}>
                <span
                  className="query-interface-audit-bar-error"
                  style={{ height: `${failureRatio}%` }}
                />
              </span>
            </span>
          );
        })}
      </div>
      {summary.recentCalls.length > 0 ? (
        <div className="query-interface-audit-call-list">
          {summary.recentCalls.map((call, index) => (
            <div
              key={`${call.startedAt}:${index}`}
              className="query-interface-audit-call"
              data-status={call.status === 'success' ? 'success' : 'error'}
            >
              <span className="query-interface-audit-call-status">{call.status}</span>
              <span>{call.action}</span>
              <span>{call.version ? `v${call.version}` : '-'}</span>
              <span>{`${call.durationMs} ms`}</span>
              <span className="query-interface-audit-call-result">
                {call.errorCode ?? call.mutationId ?? `${call.rowCount}`}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {summary.lastErrorCode ? (
        <code className="query-interface-doc-path">{summary.lastErrorCode}</code>
      ) : null}
    </div>
  );
}

function bindingSurfaceStatusLabels(i18n: SurfaceI18n) {
  return {
    loading: i18n.t('ui', 'bindingSurfaceUiLoading'),
    mutating: i18n.t('ui', 'bindingSurfaceUiMutating'),
    needsRefresh: i18n.t('ui', 'bindingSurfaceUiNeedsRefresh'),
    refreshFailed: i18n.t('ui', 'bindingSurfaceUiRefreshFailed'),
    error: i18n.t('ui', 'bindingSurfaceUiError'),
    refresh: i18n.t('ui', 'bindingSurfaceAuditRefresh'),
  };
}

function bindingSurfaceTableLabels(i18n: SurfaceI18n) {
  return {
    loading: i18n.t('ui', 'bindingSurfaceUiLoading'),
    empty: i18n.t('ui', 'bindingSurfaceUiEmpty'),
    incompatible: i18n.t('ui', 'bindingSurfaceUiTableIncompatible'),
    save: i18n.t('ui', 'bindingSurfaceUiSave'),
    remove: i18n.t('ui', 'bindingSurfaceUiDelete'),
    actions: i18n.t('ui', 'bindingSurfaceUiActions'),
    previous: i18n.t('ui', 'bindingSurfaceUiPrevious'),
    next: i18n.t('ui', 'bindingSurfaceUiNext'),
    page: i18n.t('ui', 'bindingSurfaceUiPage'),
  };
}

function bindingSurfaceFormLabels(i18n: SurfaceI18n) {
  return {
    empty: i18n.t('ui', 'bindingSurfaceUiRecordEmpty'),
    save: i18n.t('ui', 'bindingSurfaceUiSave'),
    run: i18n.t('ui', 'bindingSurfaceUiRun'),
    remove: i18n.t('ui', 'bindingSurfaceUiDeleteRecord'),
  };
}

function bindingSurfaceRelationLabels(i18n: SurfaceI18n) {
  return {
    targetValue: i18n.t('ui', 'bindingSurfaceUiRelationTarget'),
    bind: i18n.t('ui', 'bindingSurfaceUiBind'),
    unbind: i18n.t('ui', 'bindingSurfaceUiUnbind'),
    rebind: i18n.t('ui', 'bindingSurfaceUiRebind'),
    invalidJson: i18n.t('ui', 'bindingSurfaceUiInvalidJson'),
    empty: i18n.t('ui', 'bindingSurfaceUiRelationEmpty'),
  };
}

function buildSurfaceDraft(input: {
  active?: BindingSurface;
  name: string;
  description: string;
  queryRelease?: QueryInterfaceRelease;
  parameters: readonly InterfaceParameter[];
  permissionMode: 'none' | 'key' | 'disabled';
  accessKey: string;
  rateLimitEnabled: boolean;
  rateRequests: number;
  rateWindow: number;
  writeMode: 'readonly' | 'explicit';
  refresh: 'manual' | 'afterMutation';
  mutations: readonly BindingSurfaceMutationBinding[];
}): BindingSurface | undefined {
  if (!input.queryRelease) {
    return undefined;
  }
  const now = new Date().toISOString();
  const base = input.active;
  const existingDigest = base?.permissions?.accessKeyDigest;
  return {
    id: base?.id ?? 'binding_surface',
    kind: 'binding',
    name: normalizedName(input.name, 'BindingSurface'),
    displayName: input.name.trim() || undefined,
    description: input.description.trim() || undefined,
    status: base?.status ?? 'draft',
    version: base?.version ?? { current: '1.0.0', compatibility: 'draft' },
    permissions: {
      mode: input.permissionMode,
      ...(input.permissionMode === 'key'
        ? {
            accessKeyDigest: input.accessKey.trim()
              ? queryInterfaceAccessKeyDigest(input.accessKey.trim())
              : existingDigest,
          }
        : {}),
      ...(input.rateLimitEnabled
        ? {
            rateLimit: {
              maxRequests: Math.floor(input.rateRequests),
              windowSeconds: Math.floor(input.rateWindow),
            },
          }
        : {}),
    },
    parameters: cloneParameters(input.parameters),
    query: {
      interfaceId: input.queryRelease.queryInterface.id,
      version: input.queryRelease.version,
      parameterBindings: input.queryRelease.queryInterface.contract.parameters.map((parameter) => ({
        parameterId: parameter.id,
        source: { kind: 'surfaceParameter', parameterId: parameter.id },
      })),
    },
    writeback: {
      mode: input.writeMode,
      refresh: input.refresh,
      mutations: [...structuredClone(input.mutations)],
    },
    lifecycle: {
      createdAt: base?.lifecycle.createdAt ?? now,
      updatedAt: now,
    },
  };
}

function defaultMutation(
  release: OperationInterfaceRelease,
  query: QueryInterface,
  surfaceParameters: readonly InterfaceParameter[],
  existing: readonly BindingSurfaceMutationBinding[],
): BindingSurfaceMutationBinding {
  const trigger = triggerForOperation(
    release.operationInterface,
    triggerTargetOptions(
      release.operationInterface,
      query,
      flattenResultFields(query.query.result.schema),
    )[0]?.value ?? '',
  );
  const parameterBindings = release.operationInterface.contract.parameters.map((parameter) => ({
    parameterId: parameter.id,
    source: inferredSource(
      parameter,
      release.operationInterface,
      query,
      surfaceParameters,
      trigger,
    ),
  }));
  const baseId = normalizedName(release.callableName, 'mutation');
  let id = baseId;
  let suffix = 2;
  while (existing.some((candidate) => candidate.id === id)) {
    id = `${baseId}_${suffix}`;
    suffix += 1;
  }
  return {
    id,
    trigger,
    operation: {
      interfaceId: release.operationInterface.id,
      version: release.version,
    },
    parameterBindings,
  };
}

function inferredSource(
  parameter: InterfaceParameter,
  operation: OperationInterface,
  query: QueryInterface,
  surfaceParameters: readonly InterfaceParameter[],
  trigger: BindingSurfaceMutationBinding['trigger'],
): BindingSurfaceValueSource {
  const mapping = operation.operation.inputMapping.find(
    (candidate) => candidate.parameterId === parameter.id,
  );
  if (trigger.kind === 'update' && mapping?.mode === 'set') {
    return { kind: 'editedValue' };
  }
  if (mapping?.role === 'recordIdentity') {
    return {
      kind: 'rowRecordRef',
      nodeId:
        trigger.kind === 'update'
          ? fieldNode(query, trigger.fieldPath)
          : trigger.kind === 'delete' || trigger.kind === 'create'
            ? trigger.nodeId
            : query.designGraph.rootNodeId,
    };
  }
  if (mapping?.role?.startsWith('relation')) {
    const edge =
      trigger.kind === 'bind' || trigger.kind === 'unbind' || trigger.kind === 'rebind'
        ? query.designGraph.edges.find((candidate) => candidate.id === trigger.edgeId)
        : undefined;
    const targetRole = mapping.role !== 'relationSource';
    return {
      kind: 'rowRecordRef',
      nodeId: targetRole
        ? (edge?.toNodeId ?? query.designGraph.rootNodeId)
        : (edge?.fromNodeId ?? query.designGraph.rootNodeId),
    };
  }
  const surfaceParameter = surfaceParameters.find(
    (candidate) => candidate.id === parameter.id || candidate.name === parameter.name,
  );
  if (surfaceParameter) {
    return { kind: 'surfaceParameter', parameterId: surfaceParameter.id };
  }
  const field = flattenResultFields(query.query.result.schema).find(
    (candidate) => candidate.field.name === parameter.name,
  );
  return field
    ? { kind: 'rowField', fieldPath: field.path }
    : { kind: 'literal', value: parameter.defaultValue ?? '' };
}

function triggerForOperation(
  operation: OperationInterface | undefined,
  target: string,
): BindingSurfaceMutationBinding['trigger'] {
  const type = operation?.operation.operationType;
  if (type === 'bind' || type === 'unbind' || type === 'rebind') {
    return { kind: type, edgeId: target };
  }
  if (type === 'delete' || type === 'create') {
    return { kind: type, nodeId: target };
  }
  return { kind: 'update', fieldPath: target };
}

function triggerTargetOptions(
  operation: OperationInterface | undefined,
  query: QueryInterface | undefined,
  fields: readonly { path: string; field: QueryResultField }[],
): Array<{ value: string; label: string }> {
  if (!operation || !query) {
    return [];
  }
  const type = operation.operation.operationType;
  if (type === 'bind' || type === 'unbind' || type === 'rebind') {
    const relationId = operationTargetRelationId(operation);
    return query.designGraph.edges
      .filter((edge) => edge.relationId === relationId)
      .map((edge) => ({ value: edge.id, label: edge.alias }));
  }
  if (type === 'create' || type === 'delete') {
    const modelId = operationTargetModelId(operation);
    return query.designGraph.nodes
      .filter((node) => node.modelId === modelId)
      .map((node) => ({ value: node.id, label: node.alias }));
  }
  const modelId = operationTargetModelId(operation);
  return fields
    .filter(
      (entry) =>
        Boolean(entry.field.source) &&
        query.designGraph.nodes.find((node) => node.id === entry.field.source?.nodeId)?.modelId ===
          modelId,
    )
    .map((entry) => ({ value: entry.path, label: entry.path }));
}

function operationTargetModelId(operation: OperationInterface): string | undefined {
  const target = operation.operation.target;
  return target.kind === 'model'
    ? target.modelId
    : target.kind === 'node'
      ? operation.designGraph.nodes.find((node) => node.id === target.nodeId)?.modelId
      : undefined;
}

function operationTargetRelationId(operation: OperationInterface): string | undefined {
  const target = operation.operation.target;
  return target.kind === 'relation'
    ? target.relationId
    : target.kind === 'edge'
      ? operation.designGraph.edges.find((edge) => edge.id === target.edgeId)?.relationId
      : undefined;
}

function operationCanTargetQuery(operation: OperationInterface, query: QueryInterface): boolean {
  const target = operation.operation.target;
  if (target.kind === 'model') {
    return query.designGraph.nodes.some((node) => node.modelId === target.modelId);
  }
  if (target.kind === 'relation') {
    return query.designGraph.edges.some((edge) => edge.relationId === target.relationId);
  }
  if (target.kind === 'node') {
    const modelId = operation.designGraph.nodes.find((node) => node.id === target.nodeId)?.modelId;
    return query.designGraph.nodes.some((node) => node.modelId === modelId);
  }
  const relationId = operation.designGraph.edges.find(
    (edge) => edge.id === target.edgeId,
  )?.relationId;
  return query.designGraph.edges.some((edge) => edge.relationId === relationId);
}

function replaceParameterBinding(
  mutation: BindingSurfaceMutationBinding,
  parameterId: string,
  source: BindingSurfaceValueSource,
): BindingSurfaceMutationBinding {
  const remaining = mutation.parameterBindings.filter(
    (candidate) => candidate.parameterId !== parameterId,
  );
  return { ...mutation, parameterBindings: [...remaining, { parameterId, source }] };
}

function defaultSource(
  kind: BindingSurfaceValueSource['kind'],
  props: {
    query: QueryInterface | undefined;
    surfaceParameters: readonly InterfaceParameter[];
  },
): BindingSurfaceValueSource {
  if (kind === 'editedValue') {
    return { kind };
  }
  if (kind === 'literal') {
    return { kind, value: '' };
  }
  if (kind === 'surfaceParameter') {
    return { kind, parameterId: props.surfaceParameters[0]?.id ?? '' };
  }
  if (kind === 'rowRecordRef') {
    return { kind, nodeId: props.query?.designGraph.rootNodeId ?? '' };
  }
  return {
    kind,
    fieldPath: flattenResultFields(props.query?.query.result.schema ?? [])[0]?.path ?? '',
  };
}

function valueSourceKinds(
  trigger: BindingSurfaceMutationBinding['trigger']['kind'],
): BindingSurfaceValueSource['kind'][] {
  return [
    'surfaceParameter',
    'rowField',
    'rowRecordRef',
    ...(trigger === 'update' ? (['editedValue'] as const) : []),
    'literal',
  ];
}

function activeQueryReleases(saved: readonly SavedQueryInterfaceView[]): QueryInterfaceRelease[] {
  return saved
    .flatMap((item) => [item.publishedRelease, ...(item.releaseHistory ?? [])])
    .filter(
      (release): release is QueryInterfaceRelease =>
        Boolean(release) && release?.queryInterface.status === 'active',
    );
}

function activeOperationReleases(
  saved: readonly SavedOperationInterfaceView[],
): OperationInterfaceRelease[] {
  return saved
    .flatMap((item) => [item.publishedRelease, ...(item.releaseHistory ?? [])])
    .filter(
      (release): release is OperationInterfaceRelease =>
        Boolean(release) &&
        release?.operationInterface.status === 'active' &&
        release.operationInterface.operation.operationType !== 'batch',
    );
}

function releaseKey(release: {
  version: string;
  queryInterface?: QueryInterface;
  operationInterface?: OperationInterface;
}): string {
  const id = release.queryInterface?.id ?? release.operationInterface?.id ?? '';
  return `${id}@${release.version}`;
}

function flattenResultFields(
  fields: readonly QueryResultField[],
  prefix = '',
): Array<{ path: string; field: QueryResultField }> {
  return fields.flatMap((field) => {
    const path = prefix ? `${prefix}.${field.name}` : field.name;
    return [{ path, field }, ...flattenResultFields(field.children ?? [], path)];
  });
}

function fieldNode(query: QueryInterface, path: string): string {
  return (
    flattenResultFields(query.query.result.schema).find((entry) => entry.path === path)?.field
      .source?.nodeId ?? query.designGraph.rootNodeId
  );
}

function triggerValue(trigger: BindingSurfaceMutationBinding['trigger']): string {
  return trigger.kind === 'update'
    ? trigger.fieldPath
    : trigger.kind === 'create' || trigger.kind === 'delete'
      ? trigger.nodeId
      : trigger.edgeId;
}

function parameterValues(
  parameters: readonly InterfaceParameter[],
  values: Readonly<Record<string, string>>,
): Record<string, unknown> {
  return Object.fromEntries(
    parameters.flatMap((parameter) => {
      const raw = values[parameter.id];
      return raw === undefined || raw === ''
        ? parameter.defaultValue === undefined
          ? []
          : [[parameter.id, parameter.defaultValue]]
        : [[parameter.id, parseParameterValue(raw, parameter.type)]];
    }),
  );
}

function parseParameterValue(value: string, type: InterfaceParameter['type']): unknown {
  if (type === 'number') {
    return Number(value);
  }
  if (type === 'boolean') {
    return value === 'true' || value === '1';
  }
  if (type === 'json') {
    return JSON.parse(value) as unknown;
  }
  return value;
}

function parseLooseValue(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function stringifyLooseValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function cloneParameters(parameters: readonly InterfaceParameter[]): InterfaceParameter[] {
  return [...structuredClone(parameters)];
}

function nonEmptyRecord(values: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => Boolean(value.trim())));
}

function uniqueOperationReferences(
  mutations: readonly {
    operation: { interfaceId: string; callableName: string; version: string };
  }[],
): Array<{ interfaceId: string; callableName: string; version: string }> {
  return mutations
    .map((mutation) => mutation.operation)
    .filter(
      (operation, index, all) =>
        all.findIndex((candidate) => candidate.interfaceId === operation.interfaceId) === index,
    );
}

function normalizedName(value: string, fallback: string): string {
  return (
    value
      .trim()
      .replace(/[^a-zA-Z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '') || fallback
  );
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function bindingSurfaceDraftSignature(surface: BindingSurface): string {
  return bindingSurfacePublicationSignature(surface);
}

export default BindingSurfaceDesignerPanel;

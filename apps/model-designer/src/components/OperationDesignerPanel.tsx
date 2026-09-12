import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { useAppConfirm } from '@mode-db/data-ui';
import { queryInterfaceAccessKeyDigest } from '@mode-db/sdk';
import { useDesigner } from '../context/designer-context.js';
import { withBusinessLibrarySession } from '../engine/business-library-session.js';
import type { EngineModelNode, EngineRelationEdge } from '../types/engine-schema.js';
import type { PropObject } from '../types/prop-object.js';
import { isInheritRelation } from '../config/graph-edge-kinds.js';
import {
  compilePublishedOperationExecutionTemplate,
  assessOperationInterfaceReleaseImpact,
  validateEngineInterface,
  type InterfacePermissionPolicy,
  type InterfaceValueType,
  type OperationInterface,
  type OperationInterfaceRelease,
  type OperationResultContract,
  type OperationType,
} from '../query-designer/index.js';
import { DesignerSelect } from './base/designer-select.js';
import { IconPlus, IconSave, IconTrash } from './designer-icons.js';
import { interfaceDiagnosticMessage } from '../utils/interface-diagnostic-i18n.js';

type AtomicOperationType = Extract<
  OperationType,
  'create' | 'update' | 'delete' | 'upsert' | 'bind' | 'unbind' | 'rebind'
>;
type SupportedOperationType = AtomicOperationType | 'batch';
type OperationView = 'design' | 'assets';

export interface SavedOperationInterfaceView {
  id: string;
  storageId?: string;
  name: string;
  operationInterface: OperationInterface;
  createdAt: string;
  updatedAt: string;
  signature?: string;
  publishedRelease?: OperationInterfaceRelease;
  releaseHistory?: OperationInterfaceRelease[];
}

export type OperationInterfaceSaveResult =
  | { status: 'created'; id: string; name: string }
  | { status: 'updated'; id: string; name: string }
  | { status: 'unchanged'; id: string; name: string };

export function OperationDesignerPanel(props: {
  savedOperationInterfaces: readonly SavedOperationInterfaceView[];
  activeOperationInterface: SavedOperationInterfaceView | undefined;
  selectedModelId?: string;
  onSaveOperationInterface: (
    operationInterface: OperationInterface,
    name: string,
    description: string,
    activeInterfaceId?: string,
  ) => OperationInterfaceSaveResult;
  onClearActiveOperationInterface: () => void;
  onOpenOperationInterface: (id: string) => void;
  onPublishOperationInterface: (id: string) => void;
  onRollbackOperationInterface: (id: string, version: string) => void;
  onDeprecateOperationInterface: (id: string) => void;
  onDeleteOperationInterface: (id: string) => void;
}): ReactElement {
  const { i18n, data, config } = useDesigner();
  const confirm = useAppConfirm();
  const [view, setView] = useState<OperationView>('design');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [operationType, setOperationType] = useState<SupportedOperationType>('create');
  const [batchItemOperationType, setBatchItemOperationType] =
    useState<AtomicOperationType>('create');
  const [batchFailureMode, setBatchFailureMode] = useState<'continue' | 'stop'>('continue');
  const [batchMaxItems, setBatchMaxItems] = useState(100);
  const [batchIncludeItemResults, setBatchIncludeItemResults] = useState(true);
  const [modelId, setModelId] = useState('');
  const [relationId, setRelationId] = useState('');
  const [selectedFieldIds, setSelectedFieldIds] = useState<Set<string>>(new Set());
  const [upsertMatchFieldIds, setUpsertMatchFieldIds] = useState<Set<string>>(new Set());
  const [resultKind, setResultKind] = useState<OperationResultContract['returns']>('record');
  const [permissionMode, setPermissionMode] = useState<InterfacePermissionPolicy['mode']>('none');
  const [accessKey, setAccessKey] = useState('');
  const [rateLimitEnabled, setRateLimitEnabled] = useState(false);
  const [rateRequests, setRateRequests] = useState(60);
  const [rateWindow, setRateWindow] = useState(60);
  const [saveStatus, setSaveStatus] = useState<OperationInterfaceSaveResult['status'] | 'idle'>(
    'idle',
  );
  const [testValues, setTestValues] = useState<Record<string, string>>({});
  const [testAccessKey, setTestAccessKey] = useState('');
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<unknown>();
  const [testError, setTestError] = useState('');

  const activeVersion = props.activeOperationInterface
    ? `${props.activeOperationInterface.id}:${props.activeOperationInterface.updatedAt}`
    : '';
  useEffect(() => {
    const active = props.activeOperationInterface;
    if (!active) {
      const preferred =
        data.models.find((model) => model.id === props.selectedModelId) ?? data.models[0];
      setName('');
      setDescription('');
      setOperationType('create');
      setBatchItemOperationType('create');
      setBatchFailureMode('continue');
      setBatchMaxItems(100);
      setBatchIncludeItemResults(true);
      setModelId(preferred?.id ?? '');
      setRelationId(data.relations.find((relation) => !isInheritRelation(relation.kind))?.id ?? '');
      setSelectedFieldIds(new Set());
      setUpsertMatchFieldIds(new Set());
      setResultKind('record');
      setPermissionMode('none');
      setAccessKey('');
      setRateLimitEnabled(false);
      setRateRequests(60);
      setRateWindow(60);
      setSaveStatus('idle');
      return;
    }
    const asset = active.operationInterface;
    const targetModelId = operationTargetModelId(asset);
    setName(active.name);
    setDescription(asset.description ?? '');
    setOperationType(
      ['create', 'update', 'delete', 'upsert', 'bind', 'unbind', 'rebind', 'batch'].includes(
        asset.operation.operationType,
      )
        ? (asset.operation.operationType as SupportedOperationType)
        : 'create',
    );
    setBatchItemOperationType(asset.operation.batch?.itemOperationType ?? 'create');
    setBatchFailureMode(asset.operation.transactionPolicy.failureMode ?? 'continue');
    setBatchMaxItems(asset.operation.batch?.maxItems ?? 100);
    setBatchIncludeItemResults(asset.operation.result.includeItemResults ?? true);
    setModelId(targetModelId);
    setRelationId(operationTargetRelationId(asset));
    setSelectedFieldIds(
      new Set(
        asset.operation.inputMapping.flatMap((mapping) =>
          mapping.mode === 'set' && 'fieldId' in mapping.target ? [mapping.target.fieldId] : [],
        ),
      ),
    );
    setUpsertMatchFieldIds(
      new Set(
        asset.operation.inputMapping.flatMap((mapping) =>
          mapping.mode === 'lookup' && 'fieldId' in mapping.target ? [mapping.target.fieldId] : [],
        ),
      ),
    );
    setResultKind(asset.operation.result.returns);
    setPermissionMode(asset.contract.permissions?.mode ?? 'none');
    setAccessKey('');
    setRateLimitEnabled(Boolean(asset.contract.permissions?.rateLimit));
    setRateRequests(asset.contract.permissions?.rateLimit?.maxRequests ?? 60);
    setRateWindow(asset.contract.permissions?.rateLimit?.windowSeconds ?? 60);
    setSaveStatus('idle');
    setTestValues({});
    setTestResult(undefined);
    setTestError('');
  }, [
    activeVersion,
    data.models,
    data.relations,
    props.activeOperationInterface,
    props.selectedModelId,
  ]);

  const effectiveOperationType = operationType === 'batch' ? batchItemOperationType : operationType;

  useEffect(() => {
    if (
      (operationType === 'batch' ||
        effectiveOperationType === 'delete' ||
        isRelationshipOperation(effectiveOperationType)) &&
      !['none', 'summary'].includes(resultKind)
    ) {
      setResultKind('summary');
    }
  }, [effectiveOperationType, operationType, resultKind]);

  useEffect(() => {
    setUpsertMatchFieldIds(
      (current) => new Set([...current].filter((fieldId) => selectedFieldIds.has(fieldId))),
    );
  }, [selectedFieldIds]);

  const model = data.models.find((candidate) => candidate.id === modelId);
  const businessRelations = data.relations.filter(
    (candidate) => !isInheritRelation(candidate.kind),
  );
  const relation = businessRelations.find((candidate) => candidate.id === relationId);
  const relationSourceModel = relation
    ? data.models.find((candidate) => candidate.id === relation.source_model_id)
    : undefined;
  const relationTargetModel = relation
    ? data.models.find((candidate) => candidate.id === relation.target_model_id)
    : undefined;
  const draft = useMemo(
    () =>
      buildOperationDraft({
        active: props.activeOperationInterface?.operationInterface,
        name,
        description,
        operationType,
        batchItemOperationType,
        batchFailureMode,
        batchMaxItems,
        batchIncludeItemResults,
        model,
        relation,
        relationSourceModel,
        relationTargetModel,
        selectedFieldIds,
        upsertMatchFieldIds,
        resultKind,
        permissionMode,
        accessKey,
        rateLimitEnabled,
        rateRequests,
        rateWindow,
      }),
    [
      accessKey,
      batchFailureMode,
      batchIncludeItemResults,
      batchItemOperationType,
      batchMaxItems,
      description,
      model,
      name,
      operationType,
      permissionMode,
      props.activeOperationInterface,
      rateLimitEnabled,
      rateRequests,
      rateWindow,
      resultKind,
      relation,
      relationSourceModel,
      relationTargetModel,
      selectedFieldIds,
      upsertMatchFieldIds,
    ],
  );
  const diagnostics = useMemo(() => {
    if (!draft) {
      return [];
    }
    const validation = validateEngineInterface(draft, data.models).issues;
    const compilation = compilePublishedOperationExecutionTemplate({
      operationInterface: draft,
      models: data.models,
      relations: data.relations,
    }).diagnostics;
    return [...validation, ...compilation].filter(
      (issue, index, all) =>
        all.findIndex(
          (candidate) => candidate.message === issue.message && candidate.path === issue.path,
        ) === index,
    );
  }, [data.models, data.relations, draft]);
  const blocking = diagnostics.some((issue) => issue.severity === 'error');

  const startNew = (): void => {
    props.onClearActiveOperationInterface();
    setView('design');
  };
  const save = (): void => {
    if (!draft || blocking || !name.trim()) {
      return;
    }
    const result = props.onSaveOperationInterface(
      draft,
      name,
      description,
      props.activeOperationInterface?.id,
    );
    setSaveStatus(result.status);
  };

  return (
    <div className="operation-designer-panel">
      <div className="query-designer-tabs" role="tablist">
        <button
          type="button"
          className="query-designer-tab"
          data-active={view === 'design'}
          onClick={() => setView('design')}
        >
          {i18n.t('ui', 'operationDesign')}
        </button>
        <button
          type="button"
          className="query-designer-tab"
          data-active={view === 'assets'}
          onClick={() => setView('assets')}
        >
          {i18n.t('ui', 'operationAssets')} ({props.savedOperationInterfaces.length})
        </button>
      </div>

      {view === 'design' ? (
        <div className="operation-designer-stack">
          <div className="operation-designer-toolbar">
            <button type="button" className="query-designer-button" onClick={startNew}>
              <IconPlus />
              {i18n.t('ui', 'operationNew')}
            </button>
            {props.activeOperationInterface ? (
              <span className="operation-designer-version">
                v{props.activeOperationInterface.operationInterface.version.current}
              </span>
            ) : null}
          </div>

          <section className="query-designer-section">
            <label className="operation-designer-field">
              <span>{i18n.t('ui', 'operationName')}</span>
              <input
                className="query-interface-name-input"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="operation-designer-field">
              <span>{i18n.t('ui', 'operationDescription')}</span>
              <textarea
                className="query-interface-description-input"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
          </section>

          <section className="query-designer-section">
            <h3 className="designer-panel-section-title">{i18n.t('ui', 'operationType')}</h3>
            <div className="query-designer-segment operation-designer-segment">
              {(
                [
                  'create',
                  'update',
                  'delete',
                  'upsert',
                  'bind',
                  'unbind',
                  'rebind',
                  'batch',
                ] as const
              ).map((type) => (
                <button
                  key={type}
                  type="button"
                  data-active={operationType === type}
                  onClick={() => setOperationType(type)}
                >
                  {i18n.t('ui', `operation${capitalize(type)}`)}
                </button>
              ))}
            </div>
            {operationType === 'batch' ? (
              <div className="operation-designer-contract-grid">
                <label className="operation-designer-field">
                  <span>{i18n.t('ui', 'operationBatchItemType')}</span>
                  <DesignerSelect
                    value={batchItemOperationType}
                    options={(
                      ['create', 'update', 'delete', 'upsert', 'bind', 'unbind', 'rebind'] as const
                    ).map((value) => ({
                      value,
                      label: i18n.t('ui', `operation${capitalize(value)}`),
                    }))}
                    onChange={(value) => setBatchItemOperationType(value as AtomicOperationType)}
                  />
                </label>
                <label className="operation-designer-field">
                  <span>{i18n.t('ui', 'operationBatchMaxItems')}</span>
                  <input
                    className="query-interface-name-input"
                    type="number"
                    min={1}
                    max={1000}
                    value={batchMaxItems}
                    onChange={(event) => setBatchMaxItems(Number(event.target.value))}
                  />
                </label>
                <div className="operation-designer-field operation-designer-wide">
                  <span>{i18n.t('ui', 'operationBatchFailureMode')}</span>
                  <div className="query-designer-segment">
                    {(['continue', 'stop'] as const).map((value) => (
                      <button
                        key={value}
                        type="button"
                        data-active={batchFailureMode === value}
                        onClick={() => setBatchFailureMode(value)}
                      >
                        {i18n.t(
                          'ui',
                          value === 'continue' ? 'operationBatchContinue' : 'operationBatchStop',
                        )}
                      </button>
                    ))}
                  </div>
                </div>
                <label className="query-interface-rate-limit-toggle operation-designer-wide">
                  <input
                    type="checkbox"
                    checked={batchIncludeItemResults}
                    onChange={(event) => setBatchIncludeItemResults(event.target.checked)}
                  />
                  {i18n.t('ui', 'operationBatchIncludeItems')}
                </label>
              </div>
            ) : null}
            {isRelationshipOperation(effectiveOperationType) ? (
              <>
                <label className="operation-designer-field">
                  <span>{i18n.t('ui', 'operationTargetRelation')}</span>
                  <DesignerSelect
                    value={relationId}
                    searchable
                    options={businessRelations.map((candidate) => ({
                      value: candidate.id,
                      label: relationLabel(candidate, data.models, i18n.locale),
                    }))}
                    onChange={setRelationId}
                  />
                </label>
                {relation && relationSourceModel && relationTargetModel ? (
                  <div className="operation-designer-relation-endpoints">
                    <span>
                      <small>{i18n.t('ui', 'operationRelationSource')}</small>
                      <strong>{modelLabel(relationSourceModel, i18n.locale)}</strong>
                      <code>sourceId</code>
                    </span>
                    <span aria-hidden="true">&#8594;</span>
                    <span>
                      <small>{i18n.t('ui', 'operationRelationTarget')}</small>
                      <strong>{modelLabel(relationTargetModel, i18n.locale)}</strong>
                      <code>
                        {effectiveOperationType === 'rebind'
                          ? 'previousTargetId / nextTargetId'
                          : 'targetId'}
                      </code>
                    </span>
                  </div>
                ) : null}
              </>
            ) : (
              <label className="operation-designer-field">
                <span>{i18n.t('ui', 'operationTargetModel')}</span>
                <DesignerSelect
                  value={modelId}
                  searchable
                  options={data.models.map((candidate) => ({
                    value: candidate.id,
                    label: modelLabel(candidate, i18n.locale),
                  }))}
                  onChange={(value) => {
                    setModelId(value);
                    setSelectedFieldIds(new Set());
                    setUpsertMatchFieldIds(new Set());
                  }}
                />
              </label>
            )}
            {effectiveOperationType === 'update' || effectiveOperationType === 'delete' ? (
              <div className="operation-designer-identity">
                <strong>{i18n.t('ui', 'operationIdentity')}</strong>
                <code>id</code>
                <span>{i18n.t('ui', 'operationIdentityHint')}</span>
              </div>
            ) : null}
          </section>

          {!isRelationshipOperation(effectiveOperationType) &&
          effectiveOperationType !== 'delete' ? (
            <section className="query-designer-section">
              <h3 className="designer-panel-section-title">{i18n.t('ui', 'operationFields')}</h3>
              <div className="operation-designer-fields">
                {model?.props_objects_array.length ? (
                  model.props_objects_array.map((field) => (
                    <OperationFieldRow
                      key={field.id}
                      field={field}
                      checked={selectedFieldIds.has(field.id)}
                      locale={i18n.locale}
                      matchEnabled={effectiveOperationType === 'upsert'}
                      matched={upsertMatchFieldIds.has(field.id)}
                      matchLabel={i18n.t('ui', 'operationMatchField')}
                      onChange={(checked) =>
                        setSelectedFieldIds((current) => toggleSetValue(current, field.id, checked))
                      }
                      onMatchChange={(checked) => {
                        setUpsertMatchFieldIds((current) =>
                          toggleSetValue(current, field.id, checked),
                        );
                        if (checked) {
                          setSelectedFieldIds((current) => toggleSetValue(current, field.id, true));
                        }
                      }}
                    />
                  ))
                ) : (
                  <p className="query-designer-hint">{i18n.t('ui', 'operationFieldsEmpty')}</p>
                )}
              </div>
            </section>
          ) : null}

          <section className="query-designer-section operation-designer-contract-grid">
            <label className="operation-designer-field">
              <span>{i18n.t('ui', 'operationResult')}</span>
              <DesignerSelect
                value={resultKind}
                options={resultOptions(operationType, effectiveOperationType).map((value) => ({
                  value,
                  label: i18n.t('ui', `operationResult${capitalize(value)}`),
                }))}
                onChange={(value) => setResultKind(value as OperationResultContract['returns'])}
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
                onChange={(value) => setPermissionMode(value as InterfacePermissionPolicy['mode'])}
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

          {diagnostics.length > 0 ? (
            <section className="query-designer-section">
              <h3 className="designer-panel-section-title">
                {i18n.t('ui', 'operationValidation')}
              </h3>
              <ul className="query-designer-issues">
                {diagnostics.map((issue) => (
                  <li key={`${issue.code}:${issue.path ?? ''}`} data-severity={issue.severity}>
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
              disabled={!draft || blocking || !name.trim()}
              onClick={save}
            >
              <IconSave />
              {i18n.t('ui', 'operationSave')}
            </button>
            {saveStatus !== 'idle' ? (
              <span className="query-interface-save-feedback" data-status={saveStatus}>
                {i18n.t('ui', 'operationSaved')}
              </span>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="operation-designer-stack">
          {props.savedOperationInterfaces.length === 0 ? (
            <p className="query-designer-empty">{i18n.t('ui', 'operationEmpty')}</p>
          ) : (
            props.savedOperationInterfaces.map((item) => (
              <OperationAssetCard
                key={item.id}
                item={item}
                active={item.id === props.activeOperationInterface?.id}
                testValues={testValues}
                testAccessKey={testAccessKey}
                testBusy={testBusy}
                testResult={testResult}
                testError={testError}
                onOpen={() => {
                  props.onOpenOperationInterface(item.id);
                  setView('design');
                }}
                onPublish={() => props.onPublishOperationInterface(item.id)}
                onRollback={(version) => props.onRollbackOperationInterface(item.id, version)}
                onDeprecate={() => props.onDeprecateOperationInterface(item.id)}
                onDelete={async () => {
                  if (
                    await confirm({
                      title: `${i18n.t('ui', 'operationRemove')}: ${item.name}`,
                      tone: 'danger',
                    })
                  ) {
                    props.onDeleteOperationInterface(item.id);
                  }
                }}
                onTestValue={(id, value) =>
                  setTestValues((current) => ({ ...current, [id]: value }))
                }
                onTestAccessKey={setTestAccessKey}
                onRun={async () => {
                  const release = item.publishedRelease;
                  const libraryCode = config.activeLibraryName;
                  if (!release || !libraryCode) {
                    return;
                  }
                  setTestBusy(true);
                  setTestError('');
                  setTestResult(undefined);
                  try {
                    const parameters = release.executionTemplate.batch
                      ? {
                          items: JSON.parse(testValues.__batchItems || '[]') as unknown,
                        }
                      : Object.fromEntries(
                          release.executionTemplate.parameters.map((parameter) => [
                            parameter.name,
                            testValues[parameter.id] ?? '',
                          ]),
                        );
                    setTestResult(
                      await withBusinessLibrarySession(libraryCode, (client) =>
                        client.invokeOperationInterface(release.callableName, {
                          version: release.version,
                          parameters,
                          ...(testAccessKey ? { accessKey: testAccessKey } : {}),
                        }),
                      ),
                    );
                  } catch (error) {
                    setTestError(error instanceof Error ? error.message : String(error));
                  } finally {
                    setTestBusy(false);
                  }
                }}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

export default OperationDesignerPanel;

function OperationFieldRow(props: {
  field: PropObject;
  checked: boolean;
  locale: string;
  matchEnabled: boolean;
  matched: boolean;
  matchLabel: string;
  onChange: (checked: boolean) => void;
  onMatchChange: (checked: boolean) => void;
}): ReactElement {
  return (
    <div className="operation-designer-field-row">
      <label className="operation-designer-field-main">
        <input
          type="checkbox"
          checked={props.checked}
          onChange={(event) => props.onChange(event.target.checked)}
        />
        <span>
          <strong>{props.field.name_i18n?.[props.locale] || props.field.name}</strong>
          <small>{props.field.name}</small>
        </span>
      </label>
      <code>{interfaceTypeForProp(props.field)}</code>
      {props.matchEnabled ? (
        <label className="operation-designer-field-match">
          <input
            type="checkbox"
            checked={props.matched}
            onChange={(event) => props.onMatchChange(event.target.checked)}
          />
          <span>{props.matchLabel}</span>
        </label>
      ) : null}
    </div>
  );
}

function OperationAssetCard(props: {
  item: SavedOperationInterfaceView;
  active: boolean;
  testValues: Readonly<Record<string, string>>;
  testAccessKey: string;
  testBusy: boolean;
  testResult: unknown;
  testError: string;
  onOpen: () => void;
  onPublish: () => void;
  onRollback: (version: string) => void;
  onDeprecate: () => void;
  onDelete: () => void;
  onTestValue: (id: string, value: string) => void;
  onTestAccessKey: (value: string) => void;
  onRun: () => void;
}): ReactElement {
  const { i18n } = useDesigner();
  const confirm = useAppConfirm();
  const release = props.item.publishedRelease;
  const activeRelease = release?.operationInterface.status === 'active' ? release : undefined;
  return (
    <article
      className="query-interface-doc-card operation-interface-card"
      data-active={props.active}
    >
      <header className="query-interface-doc-header">
        <div className="query-interface-doc-title-block">
          <strong className="query-interface-doc-title">{props.item.name}</strong>
          <span className="query-interface-doc-subtitle">
            {props.item.operationInterface.operation.operationType} ·{' '}
            {props.item.operationInterface.version.current}
          </span>
        </div>
        <span
          className="operation-interface-status"
          data-status={release?.operationInterface.status ?? 'draft'}
        >
          {release?.operationInterface.status ?? 'draft'}
        </span>
      </header>
      {props.item.operationInterface.description ? (
        <p className="query-interface-doc-description">
          {props.item.operationInterface.description}
        </p>
      ) : null}
      <div className="query-interface-doc-actions operation-interface-actions">
        <button type="button" onClick={props.onOpen}>
          {i18n.t('ui', 'operationOpen')}
        </button>
        <button type="button" data-action="publish" onClick={props.onPublish}>
          {i18n.t('ui', 'operationPublish')}
        </button>
        {release ? (
          <button type="button" onClick={props.onDeprecate}>
            {i18n.t('ui', 'operationDeprecate')}
          </button>
        ) : null}
        <button type="button" className="operation-interface-delete" onClick={props.onDelete}>
          <IconTrash />
          <span className="operation-interface-visually-hidden">
            {i18n.t('ui', 'operationRemove')}
          </span>
        </button>
      </div>
      {release ? (
        <div className="binding-surface-ledger operation-interface-ledger">
          {[release, ...(props.item.releaseHistory ?? [])]
            .sort((left, right) =>
              right.version.localeCompare(left.version, undefined, { numeric: true }),
            )
            .map((entry) => {
              const current = entry.version === release.version;
              const impact = current
                ? undefined
                : assessOperationInterfaceReleaseImpact(entry.operationInterface, release);
              return (
                <span key={`${entry.version}:${entry.signature}`}>
                  <code>v{entry.version}</code>
                  <small>
                    {current
                      ? i18n.t('ui', 'releaseCurrent')
                      : i18n.t('ui', `releaseImpact${capitalize(impact!.level)}`)}
                  </small>
                  <time dateTime={entry.publishedAt}>
                    {new Date(entry.publishedAt).toLocaleDateString(i18n.locale)}
                  </time>
                  {!current && entry.signature !== release.signature ? (
                    <button
                      type="button"
                      className="query-interface-release-rollback"
                      onClick={async () => {
                        if (
                          await confirm({
                            title: `${i18n.t('ui', 'releaseRollback')} v${entry.version}`,
                            message: i18n.t('ui', 'releaseRollbackConfirm'),
                            tone: 'danger',
                          })
                        ) {
                          props.onRollback(entry.version);
                        }
                      }}
                    >
                      {i18n.t('ui', 'releaseRollback')}
                    </button>
                  ) : null}
                </span>
              );
            })}
        </div>
      ) : null}
      {activeRelease ? (
        <details className="query-interface-doc-section">
          <summary className="query-interface-doc-section-title">
            {i18n.t('ui', 'operationTest')}
          </summary>
          <div className="query-interface-test-console">
            {activeRelease.executionTemplate.batch ? (
              <label className="operation-designer-field">
                <span>items</span>
                <textarea
                  className="query-interface-description-input"
                  rows={8}
                  value={props.testValues.__batchItems ?? ''}
                  placeholder={batchItemsPlaceholder(activeRelease)}
                  onChange={(event) => props.onTestValue('__batchItems', event.target.value)}
                />
              </label>
            ) : (
              activeRelease.executionTemplate.parameters.map((parameter) => (
                <label key={parameter.id} className="operation-designer-field">
                  <span>{parameter.name}</span>
                  <input
                    className="query-interface-name-input"
                    value={props.testValues[parameter.id] ?? ''}
                    onChange={(event) => props.onTestValue(parameter.id, event.target.value)}
                  />
                </label>
              ))
            )}
            {activeRelease.operationInterface.contract.permissions?.mode === 'key' ? (
              <label className="operation-designer-field">
                <span>{i18n.t('ui', 'operationAccessKeyTest')}</span>
                <input
                  className="query-interface-name-input"
                  type="password"
                  value={props.testAccessKey}
                  onChange={(event) => props.onTestAccessKey(event.target.value)}
                />
              </label>
            ) : null}
            <button
              type="button"
              className="query-designer-button query-execution-run"
              disabled={props.testBusy}
              onClick={props.onRun}
            >
              {i18n.t('ui', props.testBusy ? 'operationRunning' : 'operationRun')}
            </button>
            {props.testError ? (
              <pre className="query-execution-error">{props.testError}</pre>
            ) : null}
            {props.testResult !== undefined ? (
              <pre className="query-execution-result-json">
                {JSON.stringify(props.testResult, null, 2)}
              </pre>
            ) : null}
            <details className="query-execution-request">
              <summary>{i18n.t('ui', 'operationSdkExample')}</summary>
              <pre>{operationSdkExample(activeRelease)}</pre>
            </details>
          </div>
        </details>
      ) : null}
    </article>
  );
}

function buildOperationDraft(input: {
  active: OperationInterface | undefined;
  name: string;
  description: string;
  operationType: SupportedOperationType;
  batchItemOperationType: AtomicOperationType;
  batchFailureMode: 'continue' | 'stop';
  batchMaxItems: number;
  batchIncludeItemResults: boolean;
  model: EngineModelNode | undefined;
  relation: EngineRelationEdge | undefined;
  relationSourceModel: EngineModelNode | undefined;
  relationTargetModel: EngineModelNode | undefined;
  selectedFieldIds: ReadonlySet<string>;
  upsertMatchFieldIds: ReadonlySet<string>;
  resultKind: OperationResultContract['returns'];
  permissionMode: InterfacePermissionPolicy['mode'];
  accessKey: string;
  rateLimitEnabled: boolean;
  rateRequests: number;
  rateWindow: number;
}): OperationInterface | undefined {
  const itemOperationType =
    input.operationType === 'batch' ? input.batchItemOperationType : input.operationType;
  if (isRelationshipOperation(itemOperationType)) {
    const draft = buildRelationshipDraft({ ...input, operationType: itemOperationType });
    return draft ? applyBatchDraftContract(draft, input) : undefined;
  }
  if (!input.model) {
    return undefined;
  }
  const now = new Date().toISOString();
  const nodeId = `operation_node_${input.model.id}`;
  const selectedFields =
    itemOperationType === 'delete'
      ? []
      : input.model.props_objects_array.filter((field) => input.selectedFieldIds.has(field.id));
  const needsIdentity = itemOperationType === 'update' || itemOperationType === 'delete';
  const identityParameter = {
    id: 'operation_param_record_id',
    name: 'id',
    type: 'recordRef' as const,
    required: true,
  };
  const fieldParameters = selectedFields.map((field) => ({
    id: `operation_param_${field.id}`,
    name: field.name,
    type: interfaceTypeForProp(field),
    required:
      (itemOperationType === 'create' && Boolean(field.is_required)) ||
      (itemOperationType === 'upsert' && input.upsertMatchFieldIds.has(field.id)),
  }));
  const parameters = [...(needsIdentity ? [identityParameter] : []), ...fieldParameters];
  const inputMapping: OperationInterface['operation']['inputMapping'] = [
    ...(needsIdentity
      ? [
          {
            parameterId: identityParameter.id,
            target: { kind: 'node' as const, nodeId },
            mode: 'lookup' as const,
          },
        ]
      : []),
    ...selectedFields.map((field) => ({
      parameterId: `operation_param_${field.id}`,
      target: { nodeId, modelId: input.model!.id, fieldId: field.id },
      mode: 'set' as const,
    })),
    ...(itemOperationType === 'upsert'
      ? selectedFields
          .filter((field) => input.upsertMatchFieldIds.has(field.id))
          .map((field) => ({
            parameterId: `operation_param_${field.id}`,
            target: { nodeId, modelId: input.model!.id, fieldId: field.id },
            mode: 'lookup' as const,
          }))
      : []),
  ];
  const existingDigest = input.active?.contract.permissions?.accessKeyDigest;
  const permissions: InterfacePermissionPolicy = {
    mode: input.permissionMode,
    ...(input.permissionMode === 'key'
      ? {
          accessKeyDigest: input.accessKey
            ? queryInterfaceAccessKeyDigest(input.accessKey)
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
  };
  const callableName = normalizedCallableName(input.name || 'operationInterface');
  const draft: OperationInterface = {
    id: input.active?.id ?? `operation_${input.model.id}_${input.operationType}`,
    kind: 'operation',
    name: callableName,
    displayName: input.name.trim() || callableName,
    description: input.description.trim() || undefined,
    status: input.active?.status ?? 'draft',
    version: input.active?.version ?? { current: '0.1.0', compatibility: 'draft' },
    contract: {
      parameters,
      output: {
        shape:
          input.resultKind === 'none'
            ? 'none'
            : input.resultKind === 'summary'
              ? 'summary'
              : 'single',
      },
      errors: [],
      permissions,
      invocation: { method: 'mutation', callableName },
    },
    designGraph: {
      rootNodeId: nodeId,
      nodes: [{ id: nodeId, modelId: input.model.id, alias: input.model.model_name, role: 'root' }],
      edges: [],
    },
    operation: {
      operationType: itemOperationType,
      target: { kind: 'node', nodeId },
      inputMapping,
      validationRules: [],
      transactionPolicy: { mode: 'single', rollbackOnFailure: true },
      result: { returns: input.resultKind },
    },
    dependencies: {
      models: [input.model.id],
      fields: selectedFields.map((field) => `${input.model!.id}.${field.id}`),
      relations: [],
    },
    lifecycle: {
      createdAt: input.active?.lifecycle.createdAt ?? now,
      updatedAt: now,
    },
  };
  return applyBatchDraftContract(draft, input);
}

function buildRelationshipDraft(input: {
  active: OperationInterface | undefined;
  name: string;
  description: string;
  operationType: AtomicOperationType;
  model: EngineModelNode | undefined;
  relation: EngineRelationEdge | undefined;
  relationSourceModel: EngineModelNode | undefined;
  relationTargetModel: EngineModelNode | undefined;
  selectedFieldIds: ReadonlySet<string>;
  upsertMatchFieldIds: ReadonlySet<string>;
  resultKind: OperationResultContract['returns'];
  permissionMode: InterfacePermissionPolicy['mode'];
  accessKey: string;
  rateLimitEnabled: boolean;
  rateRequests: number;
  rateWindow: number;
}): OperationInterface | undefined {
  const { relation, relationSourceModel, relationTargetModel } = input;
  if (
    !relation ||
    !relationSourceModel ||
    !relationTargetModel ||
    !isRelationshipOperation(input.operationType)
  ) {
    return undefined;
  }
  const now = new Date().toISOString();
  const sourceNodeId = `operation_source_${relation.id}`;
  const targetNodeId = `operation_target_${relation.id}`;
  const edgeId = `operation_edge_${relation.id}`;
  const target = { kind: 'edge' as const, edgeId };
  const sourceParameter = {
    id: 'operation_param_source_id',
    name: 'sourceId',
    type: 'recordRef' as const,
    required: true,
  };
  const targetParameter = {
    id: 'operation_param_target_id',
    name: 'targetId',
    type: 'recordRef' as const,
    required: true,
  };
  const previousTargetParameter = {
    id: 'operation_param_previous_target_id',
    name: 'previousTargetId',
    type: 'recordRef' as const,
    required: true,
  };
  const nextTargetParameter = {
    id: 'operation_param_next_target_id',
    name: 'nextTargetId',
    type: 'recordRef' as const,
    required: true,
  };
  const parameters =
    input.operationType === 'rebind'
      ? [sourceParameter, previousTargetParameter, nextTargetParameter]
      : [sourceParameter, targetParameter];
  const inputMapping: OperationInterface['operation']['inputMapping'] =
    input.operationType === 'rebind'
      ? [
          {
            parameterId: sourceParameter.id,
            target,
            mode: 'lookup',
            role: 'relationSource',
          },
          {
            parameterId: previousTargetParameter.id,
            target,
            mode: 'disconnect',
            role: 'relationPreviousTarget',
          },
          {
            parameterId: nextTargetParameter.id,
            target,
            mode: 'connect',
            role: 'relationNextTarget',
          },
        ]
      : [
          {
            parameterId: sourceParameter.id,
            target,
            mode: input.operationType === 'bind' ? 'connect' : 'disconnect',
            role: 'relationSource',
          },
          {
            parameterId: targetParameter.id,
            target,
            mode: input.operationType === 'bind' ? 'connect' : 'disconnect',
            role: 'relationTarget',
          },
        ];
  const existingDigest = input.active?.contract.permissions?.accessKeyDigest;
  const permissions: InterfacePermissionPolicy = {
    mode: input.permissionMode,
    ...(input.permissionMode === 'key'
      ? {
          accessKeyDigest: input.accessKey
            ? queryInterfaceAccessKeyDigest(input.accessKey)
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
  };
  const callableName = normalizedCallableName(input.name || 'operationInterface');
  const resultKind = input.resultKind === 'none' ? 'none' : 'summary';
  return {
    id: input.active?.id ?? `operation_${relation.id}_${input.operationType}`,
    kind: 'operation',
    name: callableName,
    displayName: input.name.trim() || callableName,
    description: input.description.trim() || undefined,
    status: input.active?.status ?? 'draft',
    version: input.active?.version ?? { current: '0.1.0', compatibility: 'draft' },
    contract: {
      parameters,
      output: { shape: resultKind },
      errors: [],
      permissions,
      invocation: { method: 'mutation', callableName },
    },
    designGraph: {
      rootNodeId: sourceNodeId,
      nodes: [
        {
          id: sourceNodeId,
          modelId: relationSourceModel.id,
          alias: relationSourceModel.model_name,
          role: 'root',
        },
        {
          id: targetNodeId,
          modelId: relationTargetModel.id,
          alias: relationTargetModel.model_name,
          role: 'joined',
        },
      ],
      edges: [
        {
          id: edgeId,
          relationId: relation.id,
          fromNodeId: sourceNodeId,
          toNodeId: targetNodeId,
          alias: relation.forward_name ?? relation.engine_forward_name ?? relation.id,
          required: true,
          cardinality: relation.target_cardinality === 'many' ? 'many' : 'one',
          traversal: 'forward',
          purpose: 'constraint',
        },
      ],
    },
    operation: {
      operationType: input.operationType,
      target,
      inputMapping,
      validationRules: [],
      transactionPolicy: { mode: 'single', rollbackOnFailure: true },
      result: { returns: resultKind },
    },
    dependencies: {
      models: Array.from(new Set([relationSourceModel.id, relationTargetModel.id])),
      fields: [],
      relations: [relation.id],
    },
    lifecycle: {
      createdAt: input.active?.lifecycle.createdAt ?? now,
      updatedAt: now,
    },
  };
}

function applyBatchDraftContract(
  draft: OperationInterface,
  input: {
    operationType: SupportedOperationType;
    batchItemOperationType: AtomicOperationType;
    batchFailureMode: 'continue' | 'stop';
    batchMaxItems: number;
    batchIncludeItemResults: boolean;
  },
): OperationInterface {
  if (input.operationType !== 'batch') {
    return draft;
  }
  return {
    ...draft,
    contract: {
      ...draft.contract,
      output: { shape: 'summary' },
    },
    operation: {
      ...draft.operation,
      operationType: 'batch',
      batch: {
        itemOperationType: input.batchItemOperationType,
        maxItems: Math.floor(input.batchMaxItems),
      },
      transactionPolicy: {
        mode: 'batch',
        rollbackOnFailure: false,
        failureMode: input.batchFailureMode,
      },
      result: {
        returns: 'summary',
        includeItemResults: input.batchIncludeItemResults,
      },
    },
  };
}

function operationTargetModelId(asset: OperationInterface): string {
  const target = asset.operation.target;
  if (target.kind === 'model') {
    return target.modelId;
  }
  if (target.kind === 'node') {
    return asset.designGraph.nodes.find((node) => node.id === target.nodeId)?.modelId ?? '';
  }
  return '';
}

function operationTargetRelationId(asset: OperationInterface): string {
  const target = asset.operation.target;
  if (target.kind === 'relation') return target.relationId;
  if (target.kind === 'edge') {
    return asset.designGraph.edges.find((edge) => edge.id === target.edgeId)?.relationId ?? '';
  }
  return '';
}

function interfaceTypeForProp(field: PropObject): InterfaceValueType {
  const type = field.type.toLowerCase();
  if (['number', 'int', 'float', 'double'].includes(type)) return 'number';
  if (type === 'boolean' || type === 'bool') return 'boolean';
  if (type === 'date') return 'date';
  if (type === 'datetime') return 'datetime';
  if (type === 'json' || type === 'object') return 'json';
  return 'string';
}

function modelLabel(model: EngineModelNode, locale: string): string {
  return model.name_i18n?.[locale] || model.model_name;
}

function relationLabel(
  relation: EngineRelationEdge,
  models: readonly EngineModelNode[],
  locale: string,
): string {
  const source = models.find((model) => model.id === relation.source_model_id);
  const target = models.find((model) => model.id === relation.target_model_id);
  const label =
    relation.forward_name_i18n?.[locale] ||
    relation.forward_name ||
    relation.engine_forward_name ||
    relation.id;
  return `${source ? modelLabel(source, locale) : relation.source_model_id} - ${label} -> ${
    target ? modelLabel(target, locale) : relation.target_model_id
  }`;
}

function isRelationshipOperation(
  operationType: SupportedOperationType,
): operationType is Extract<SupportedOperationType, 'bind' | 'unbind' | 'rebind'> {
  return operationType === 'bind' || operationType === 'unbind' || operationType === 'rebind';
}

function toggleSetValue(
  current: ReadonlySet<string>,
  value: string,
  checked: boolean,
): Set<string> {
  const next = new Set(current);
  if (checked) next.add(value);
  else next.delete(value);
  return next;
}

function resultOptions(
  operationType: SupportedOperationType,
  effectiveOperationType: AtomicOperationType,
): OperationResultContract['returns'][] {
  if (operationType === 'batch') {
    return ['summary'];
  }
  return effectiveOperationType === 'delete' || isRelationshipOperation(effectiveOperationType)
    ? ['summary', 'none']
    : ['record', 'recordRef', 'summary', 'none'];
}

function normalizedCallableName(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return /^[A-Za-z_]/.test(normalized) ? normalized : `operation_${normalized || 'interface'}`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function operationSdkExample(release: OperationInterfaceRelease): string {
  const item = Object.fromEntries(
    release.executionTemplate.parameters.map((parameter) => [
      parameter.name,
      `<${parameter.type}>`,
    ]),
  );
  const parameters = release.executionTemplate.batch ? { items: [item] } : item;
  return `await client.invokeOperationInterface('${release.callableName}', ${JSON.stringify(
    { version: release.version, parameters },
    null,
    2,
  )});`;
}

function batchItemsPlaceholder(release: OperationInterfaceRelease): string {
  const item = Object.fromEntries(
    release.executionTemplate.parameters.map((parameter) => [
      parameter.name,
      `<${parameter.type}>`,
    ]),
  );
  return JSON.stringify([item], null, 2);
}

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { QueryInterfaceRelease } from '../query-designer/index.js';
import {
  executeInterfacePivot,
  executeModelPivot,
  type PivotDocument,
  type PivotLanguageMode,
  type PivotTableSchema,
  type PivotNode,
} from '../pivot/index.js';
import { resolveModelDisplayName } from '../utils/i18n-resolve.js';
import { useDesigner } from '../context/designer-context.js';
import { DesignerSelect } from './base/designer-select.js';
import { IconRestore } from './designer-icons.js';
import { TransferError, type TransferModel } from '@mode-db/data-kit';
import { currentSchema, loadModelTransferSchema } from '../data-transfer/execute.js';
import type { TransferFilter } from '../data-transfer/filters.js';
import { ModelQueryFilters } from './ModelQueryFilters.js';
import { InterfaceQueryInputs } from './InterfaceQueryInputs.js';
import { preparePivotParameters, type PivotParameterDraft } from '../pivot/interface-input.js';
import { buildPivotDisplay, readableDate, type PivotDisplayNode } from '../pivot/display.js';
import { PivotResultTable } from './PivotResultTable.js';
import { DataTransferPanel, type PivotTransferFeedback } from './DataTransferPanel.js';
import '../styles/data-transfer.css';

const NO_FILTERS: readonly TransferFilter[] = [];
const NO_PARAMETERS: PivotParameterDraft = {};

export interface PivotQueryInterfaceView {
  readonly id: string;
  readonly name: string;
  readonly publishedRelease?: QueryInterfaceRelease;
}

type PivotSourceKind = 'model' | 'interface';
type PivotViewMode = 'hierarchy' | 'table' | 'json';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeJson(value: unknown): string {
  try {
    const json = JSON.stringify(value, null, 2);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

function formatValue(value: unknown, locale: string, mode: PivotLanguageMode): string {
  if (value === null) {
    return 'null';
  }
  if (value === undefined) {
    return 'undefined';
  }
  if (mode === 'current' && isI18nMap(value)) {
    return resolveI18nForLocale(value, locale, Object.values(value)[0] ?? '');
  }
  if (typeof value === 'string') {
    return mode === 'raw' ? value : (readableDate(value) ?? value);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return safeJson(value);
}

type PivotTreeTableRow = {
  readonly node: PivotNode;
  readonly depth: number;
  readonly recordIndex: number;
};

function translatedNodeLabel(node: PivotNode, display: PivotDisplayNode): string {
  let current = display;
  let label = node.key;
  const keys = node.path
    .filter((segment) => segment.kind === 'field')
    .map((segment) => segment.key);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    const child = current.children.find(
      (item) => item.key === key || item.key === `${key}.${keys[i + 1]}`,
    );
    if (child) {
      label = child.label;
      current = child.node;
      if (child.key.includes('.')) i++;
    } else label = current.fields.find((field) => field.key === key)?.label ?? key;
  }
  return node.path.at(-1)?.kind === 'index' ? String((node.path.at(-1)?.index ?? 0) + 1) : label;
}

function collectVisibleTreeRows(
  document: PivotDocument,
  expandedNodeIds: ReadonlySet<string>,
  languageMode: PivotLanguageMode,
): readonly PivotTreeTableRow[] {
  const rows: PivotTreeTableRow[] = [];
  const visit = (node: PivotNode, depth: number, recordIndex: number): void => {
    rows.push({ node, depth, recordIndex });
    if (
      !expandedNodeIds.has(node.id) ||
      (languageMode === 'current' && isPivotI18nValue(node.value))
    ) {
      return;
    }
    node.children.forEach((child) => visit(child, depth + 1, recordIndex));
  };
  document.rows.forEach((row, recordIndex) => visit(row.root, 0, recordIndex));
  return rows;
}

function formatTreeNodeValue(
  node: PivotNode,
  locale: string,
  languageMode: PivotLanguageMode,
): string {
  if (node.children.length === 0 || (languageMode === 'current' && isPivotI18nValue(node.value))) {
    return formatPivotValue(node.value, locale, languageMode);
  }
  if (node.kind === 'array') {
    return `[${node.children.length}]`;
  }
  return `{${node.children.length}}`;
}

function PivotHierarchyTable(props: {
  document: PivotDocument;
  schema?: PivotTableSchema;
  locale: string;
  languageMode: PivotLanguageMode;
  fieldLabel: string;
  typeLabel: string;
  valueLabel: string;
  recordLabel: (count: string) => string;
  expandLabel: string;
  collapseLabel: string;
  nodeTypeLabel: (kind: PivotNode['kind']) => string;
  display: PivotDisplayNode;
}): ReactElement {
  const {
    document,
    schema,
    locale,
    languageMode,
    fieldLabel,
    typeLabel,
    valueLabel,
    recordLabel,
    expandLabel,
    collapseLabel,
    nodeTypeLabel,
  } = props;
  const rootNodeIds = useMemo(() => document.rows.map((row) => row.root.id), [document.rows]);
  const [expandedNodeIds, setExpandedNodeIds] = useState<ReadonlySet<string>>(
    () => new Set(rootNodeIds),
  );

  const rows = useMemo(
    () => collectVisibleTreeRows(document, expandedNodeIds, languageMode),
    [document, expandedNodeIds, languageMode],
  );

  const toggleNode = (nodeId: string): void => {
    setExpandedNodeIds((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  };

  return (
    <div
      className="pivot-table-wrap pivot-hierarchy-table-wrap"
      tabIndex={0}
      role="region"
      aria-label={fieldLabel}
    >
      <table className="pivot-table pivot-hierarchy-table">
        <thead>
          <tr>
            <th scope="col">{fieldLabel}</th>
            <th scope="col">{typeLabel}</th>
            <th scope="col">{valueLabel}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ node, depth, recordIndex }) => {
            const expandable =
              node.children.length > 0 &&
              !(languageMode === 'current' && isPivotI18nValue(node.value));
            const expanded = expandedNodeIds.has(node.id);
            const label =
              node.kind === 'record'
                ? recordLabel(String(recordIndex + 1))
                : translatedNodeLabel(node, props.display);
            return (
              <tr
                key={node.id}
                className={node.kind === 'record' ? 'pivot-tree-row-root' : undefined}
              >
                <th scope="row" className="pivot-tree-cell-key">
                  <span className="pivot-tree-key-content" style={{ paddingLeft: depth * 20 }}>
                    {expandable ? (
                      <button
                        type="button"
                        className="pivot-tree-toggle"
                        aria-label={expanded ? collapseLabel : expandLabel}
                        aria-expanded={expanded}
                        onClick={() => toggleNode(node.id)}
                      >
                        {expanded ? '▾' : '▸'}
                      </button>
                    ) : (
                      <span className="pivot-tree-toggle-placeholder" aria-hidden="true" />
                    )}
                    <span className="pivot-tree-key">{label}</span>
                  </span>
                </th>
                <td className="pivot-tree-cell-type">{nodeTypeLabel(node.kind)}</td>
                <td className="pivot-tree-cell-value">
                  {formatTreeNodeValue(node, locale, languageMode)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PivotDocumentView(props: {
  display: PivotDisplayNode;
  document: PivotDocument;
  schema?: PivotTableSchema;
  viewMode: PivotViewMode;
  languageMode: PivotLanguageMode;
  locale: string;
  emptyRowsLabel: string;
  emptyScalarLabel: string;
  jsonLabel: string;
  hierarchyFieldLabel: string;
  hierarchyTypeLabel: string;
  hierarchyValueLabel: string;
  hierarchyRecordLabel: (count: string) => string;
  hierarchyExpandLabel: string;
  hierarchyCollapseLabel: string;
  hierarchyNodeTypeLabel: (kind: PivotNode['kind']) => string;
  tableLabels: PivotTableLabels;
}): ReactElement {
  const {
    document,
    schema,
    viewMode,
    languageMode,
    locale,
    emptyRowsLabel,
    jsonLabel,
    hierarchyFieldLabel,
    hierarchyTypeLabel,
    hierarchyValueLabel,
    hierarchyRecordLabel,
    hierarchyExpandLabel,
    hierarchyCollapseLabel,
    hierarchyNodeTypeLabel,
  } = props;
  const table = useMemo(
    () => (schema ? buildPivotTable(document, schema) : undefined),
    [document, schema],
  );
  if (viewMode === 'json') {
    return (
      <pre className="pivot-json-view" aria-label={jsonLabel}>
        {safeJson(document.rawRows)}
      </pre>
    );
  }

  if (viewMode === 'table') {
    if (document.rows.length === 0) {
      return <div className="pivot-empty">{emptyRowsLabel}</div>;
    }
    return (
      <PivotResultTable
        rows={document.rawRows}
        display={props.display}
        locale={locale}
        languageMode={languageMode}
        offset={(document.page.page ?? 0) * (document.page.limit ?? 0)}
        expandLabel={hierarchyExpandLabel}
        collapseLabel={hierarchyCollapseLabel}
        emptyFieldsLabel={props.emptyScalarLabel}
      />
    );
  }

  if (document.rows.length === 0) {
    return <div className="pivot-empty">{emptyRowsLabel}</div>;
  }
  return (
    <PivotHierarchyTable
      document={document}
      display={props.display}
      locale={locale}
      languageMode={languageMode}
      fieldLabel={hierarchyFieldLabel}
      typeLabel={hierarchyTypeLabel}
      valueLabel={hierarchyValueLabel}
      recordLabel={hierarchyRecordLabel}
      expandLabel={hierarchyExpandLabel}
      collapseLabel={hierarchyCollapseLabel}
      nodeTypeLabel={hierarchyNodeTypeLabel}
    />
  );
}

export function PivotTab(props: {
  savedQueryInterfaces: readonly PivotQueryInterfaceView[];
  onBack?: () => void;
  sourceContext?:
    | { readonly kind: 'model'; readonly modelId: string }
    | { readonly kind: 'interface'; readonly interfaceId: string };
}): ReactElement {
  const { i18n, data, config } = useDesigner();
  const models = data.models;
  const relations = data.relations;
  const [sourceKind, setSourceKind] = useState<PivotSourceKind>('model');
  const [modelId, setModelId] = useState('');
  const [interfaceId, setInterfaceId] = useState('');
  const [interfaceInput, setInterfaceInput] = useState<{
    key?: string;
    values: PivotParameterDraft;
    accessKey: string;
    validated: boolean;
  }>({ values: {}, accessKey: '', validated: false });
  const [viewMode, setViewMode] = useState<PivotViewMode>('table');
  const [languageMode, setLanguageMode] = useState<PivotLanguageMode>('current');
  const [document, setDocument] = useState<PivotDocument | null>(null);
  const documentRef = useRef<PivotDocument | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshSpinning, setRefreshSpinning] = useState(false);
  const refreshStartedAt = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [transferFeedback, setTransferFeedback] = useState<PivotTransferFeedback | null>(null);
  const transferBusy = transferFeedback?.busy ?? false;
  const [filterState, setFilterState] = useState<{
    key?: string;
    filters: readonly TransferFilter[];
  }>({ filters: [] });
  const [schemaState, setSchemaState] = useState<{
    key?: string;
    model?: TransferModel;
    error?: string;
  }>({});
  const [displaySchema, setDisplaySchema] = useState<readonly TransferModel[]>([]);
  const [paging, setPaging] = useState<{
    key?: string;
    enabled: boolean;
    page: number;
    limit: number;
    cursors: (string | null)[];
  }>({ enabled: false, page: 0, limit: 50, cursors: [null] });
  const [appliedSignature, setAppliedSignature] = useState('');
  const autoRunKeyRef = useRef<string | undefined>(undefined);
  const requestRef = useRef(0);
  const mountedRef = useRef(true);

  const modelOptions = useMemo(
    () =>
      models.map((model) => ({
        value: model.id,
        label: `${resolveModelDisplayName(model, i18n.locale)} · ${model.model_name}`,
      })),
    [i18n.locale, models],
  );
  const interfaceOptions = useMemo(
    () =>
      props.savedQueryInterfaces
        .filter((item) => Boolean(item.publishedRelease))
        .map((item) => ({
          value: item.id,
          label: `${item.name} · ${item.publishedRelease?.callableName ?? ''} v${item.publishedRelease?.version ?? ''}`,
          disabled: item.publishedRelease?.queryInterface.status !== 'active',
        })),
    [props.savedQueryInterfaces],
  );
  const effectiveSourceKind = props.sourceContext?.kind ?? sourceKind;
  const effectiveModelId =
    props.sourceContext?.kind === 'model' ? props.sourceContext.modelId : modelId;
  const effectiveInterfaceId =
    props.sourceContext?.kind === 'interface' ? props.sourceContext.interfaceId : interfaceId;
  const effectiveModel = models.find((model) => model.id === effectiveModelId);
  const effectiveInterface = props.savedQueryInterfaces.find(
    (item) => item.id === effectiveInterfaceId,
  );
  const effectiveModelPolicy = effectiveModel
    ? modelFieldPolicy(effectiveModel, models, relations)
    : undefined;
  const autoRunKey =
    effectiveSourceKind === 'model'
      ? effectiveModel
        ? `library:${config.activeLibraryName ?? ''}:model:${effectiveModel.id}`
        : undefined
      : effectiveInterface?.publishedRelease
        ? `library:${config.activeLibraryName ?? ''}:interface:${effectiveInterface.id}:${effectiveInterface.publishedRelease.version}`
        : undefined;
  const sourceKeyRef = useRef(autoRunKey);
  sourceKeyRef.current = autoRunKey;
  const filters =
    autoRunKeyRef.current === autoRunKey && filterState.key === autoRunKey
      ? filterState.filters
      : NO_FILTERS;
  const schema = schemaState.key === autoRunKey ? schemaState.model : undefined;
  const schemaError = schemaState.key === autoRunKey ? schemaState.error : undefined;
  const inputIsCurrent = autoRunKeyRef.current === autoRunKey && interfaceInput.key === autoRunKey;
  const parameterValues = inputIsCurrent ? interfaceInput.values : NO_PARAMETERS;
  const accessKey = inputIsCurrent ? interfaceInput.accessKey : '';
  const release = effectiveInterface?.publishedRelease;
  const pagingCurrent = paging.key === autoRunKey;
  const paginationMode =
    effectiveSourceKind === 'interface'
      ? (release?.executionTemplate.pagination.mode ?? 'none')
      : pagingCurrent && paging.enabled
        ? 'offset'
        : 'none';
  const pageIndex = pagingCurrent ? paging.page : 0;
  const pageLimit = pagingCurrent
    ? paging.limit
    : effectiveSourceKind === 'interface'
      ? (release?.executionTemplate.pagination.defaultLimit ?? 20)
      : 50;
  const display = useMemo(
    () =>
      buildPivotDisplay({
        models,
        relations,
        schema: displaySchema,
        locale: i18n.locale,
        modelId: effectiveModelId,
        release: effectiveSourceKind === 'interface' ? release : undefined,
        aggregateLabels: Object.fromEntries(
          ['count', 'sum', 'avg', 'min', 'max', 'distinct'].map((fn) => [
            fn,
            i18n.t('ui', `pivotMetric_${fn}`),
          ]),
        ),
      }),
    [models, relations, displaySchema, i18n.locale, effectiveModelId, effectiveSourceKind, release],
  );
  const preparedParameters = useMemo(
    () =>
      preparePivotParameters(release?.queryInterface.contract.parameters ?? [], parameterValues),
    [release, parameterValues],
  );
  const needsInterfaceInput =
    preparedParameters.issues.length > 0 ||
    (release?.queryInterface.contract.permissions?.mode === 'key' && !accessKey);
  const querySignature = JSON.stringify([
    autoRunKey,
    effectiveSourceKind === 'model' ? filters : [parameterValues, accessKey],
  ]);
  const pendingConditions = Boolean(document && appliedSignature !== querySignature);

  useEffect(() => {
    let active = true;
    setDisplaySchema([]);
    if (config.activeLibraryName)
      void currentSchema(config.activeLibraryName, models, i18n.locale)
        .then((schema) => {
          if (active) setDisplaySchema(schema.models);
        })
        .catch(() => {
          /* Designer labels remain available when catalog metadata cannot be read. */
        });
    return () => {
      active = false;
    };
  }, [autoRunKey, config.activeLibraryName, models, i18n.locale]);

  useEffect(() => {
    let active = true;
    if (effectiveSourceKind !== 'model' || !effectiveModel || !config.activeLibraryName) return;
    const key = autoRunKey;
    setSchemaState({ key });
    void loadModelTransferSchema({
      database: config.activeLibraryName,
      modelName: effectiveModel.model_name,
      models,
      locale: i18n.locale,
    })
      .then(({ model }) => {
        if (active) setSchemaState({ key, model });
      })
      .catch((cause: unknown) => {
        if (active)
          setSchemaState({
            key,
            error:
              cause instanceof TransferError
                ? i18n.t('ui', `transferIssue_${cause.code}`)
                : cause instanceof Error
                  ? cause.message
                  : String(cause),
          });
      });
    return () => {
      active = false;
    };
  }, [
    autoRunKey,
    config.activeLibraryName,
    effectiveModel,
    effectiveSourceKind,
    i18n,
    i18n.locale,
    models,
  ]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!modelId || !models.some((model) => model.id === modelId)) {
      setModelId(models[0]?.id ?? '');
    }
  }, [modelId, models]);
  useEffect(() => {
    if (!interfaceId || !interfaceOptions.some((option) => option.value === interfaceId)) {
      setInterfaceId(
        interfaceOptions.find((option) => !option.disabled)?.value ??
          interfaceOptions[0]?.value ??
          '',
      );
    }
  }, [interfaceId, interfaceOptions]);

  const execute = useCallback(
    async (
      signal?: AbortSignal,
      navigation?: { page: number; limit: number; enabled?: boolean },
    ): Promise<boolean> => {
      const libraryName = config.activeLibraryName;
      if (!libraryName) {
        setError(i18n.t('ui', 'pivotNoLibrary'));
        return false;
      }
      const request = ++requestRef.current;
      const isCurrent = (): boolean =>
        mountedRef.current && requestRef.current === request && sourceKeyRef.current === autoRunKey;
      setBusy(true);
      setError(null);
      const mode =
        effectiveSourceKind === 'model' && navigation?.enabled !== undefined
          ? navigation.enabled
            ? 'offset'
            : 'none'
          : paginationMode;
      const conditionsChanged = appliedSignature !== querySignature;
      const targetPage = navigation?.page ?? (conditionsChanged ? 0 : pageIndex);
      const limit = navigation?.limit ?? pageLimit;
      const cursors =
        conditionsChanged || (navigation?.limit !== undefined && navigation.limit !== pageLimit)
          ? [null]
          : pagingCurrent
            ? [...paging.cursors]
            : [null];
      try {
        if (effectiveSourceKind === 'interface') {
          setInterfaceInput({
            key: autoRunKey,
            values: parameterValues,
            accessKey,
            validated: true,
          });
          if (preparedParameters.issues.length)
            throw new Error(i18n.t('ui', 'pivotParameterValidationFailed'));
          if (release?.queryInterface.contract.permissions?.mode === 'key' && !accessKey)
            throw new Error(i18n.t('ui', 'pivotAccessKeyRequired'));
        }
        if (effectiveSourceKind === 'model' && filters.length && !schema)
          throw new Error(schemaError ?? i18n.t('ui', 'transferLoadingSchema'));
        const next =
          effectiveSourceKind === 'model'
            ? effectiveModel
              ? await executeModelPivot({
                  libraryName,
                  source: {
                    kind: 'model',
                    modelId: effectiveModel.id,
                    modelName: effectiveModel.model_name,
                  },
                  fieldPolicy: effectiveModelPolicy,
                  filter: schema ? { model: schema, conditions: filters } : undefined,
                  ...(mode === 'offset' ? { page: targetPage, limit } : {}),
                })
              : (() => {
                  throw new Error(i18n.t('ui', 'pivotSelectModel'));
                })()
            : effectiveInterface?.publishedRelease
              ? await executeInterfacePivot({
                  libraryName,
                  source: {
                    kind: 'interface',
                    interfaceId: effectiveInterface.id,
                    callableName: effectiveInterface.publishedRelease.callableName,
                    version: effectiveInterface.publishedRelease.version,
                  },
                  parameters: preparedParameters.values,
                  accessKey: accessKey || undefined,
                  ...(mode === 'offset'
                    ? { page: targetPage, limit }
                    : mode === 'cursor'
                      ? { cursor: cursors[targetPage] ?? null, limit }
                      : {}),
                })
              : (() => {
                  throw new Error(i18n.t('ui', 'pivotSelectPublishedInterface'));
                })();
        if (!isCurrent() || signal?.aborted) return false;
        setDocument(next);
        documentRef.current = next;
        setAppliedSignature(querySignature);
        if (next.page.nextCursor) cursors[targetPage + 1] = next.page.nextCursor;
        setPaging({ key: autoRunKey, enabled: mode !== 'none', page: targetPage, limit, cursors });
        return true;
      } catch (cause) {
        if (isCurrent() && !signal?.aborted) {
          setError(
            cause instanceof TransferError
              ? i18n.t('ui', `transferIssue_${cause.code}`)
              : cause instanceof Error
                ? cause.message
                : String(cause),
          );
        }
        return false;
      } finally {
        if (isCurrent()) setBusy(false);
      }
    },
    [
      config.activeLibraryName,
      effectiveInterface,
      effectiveModel,
      effectiveModelPolicy,
      effectiveSourceKind,
      i18n,
      parameterValues,
      preparedParameters,
      accessKey,
      release,
      autoRunKey,
      filters,
      schema,
      schemaError,
      querySignature,
      appliedSignature,
      paginationMode,
      pageIndex,
      pageLimit,
      paging,
      pagingCurrent,
      pendingConditions,
    ],
  );

  const executeRef = useRef(execute);
  useEffect(() => {
    executeRef.current = execute;
  }, [execute]);

  useEffect(() => {
    if (busy) {
      refreshStartedAt.current = performance.now();
      setRefreshSpinning(true);
      return;
    }
    // Keep quick local queries visible without delaying the query or unlocking controls later.
    const timer = window.setTimeout(
      () => setRefreshSpinning(false),
      Math.max(0, 600 - (performance.now() - refreshStartedAt.current)),
    );
    return () => window.clearTimeout(timer);
  }, [busy]);

  useEffect(() => {
    if (autoRunKeyRef.current === autoRunKey) {
      return;
    }
    autoRunKeyRef.current = autoRunKey;
    setFilterState({ key: autoRunKey, filters: NO_FILTERS });
    setInterfaceInput({ key: autoRunKey, values: {}, accessKey: '', validated: false });
    setDocument(null);
    documentRef.current = null;
    setError(null);
    setBusy(false);
    setViewMode('table');
    if (autoRunKey && !(effectiveSourceKind === 'interface' && needsInterfaceInput))
      void executeRef.current();
    // Parameter edits apply only on Refresh; automatic loading is scoped to a source/release change.
  }, [autoRunKey]);

  const refreshButton = (
    <button
      type="button"
      className="designer-btn designer-btn-primary pivot-run-button"
      disabled={busy || transferBusy}
      aria-busy={busy}
      data-spinning={refreshSpinning || busy}
      onClick={() => void execute()}
    >
      <span className="pivot-refresh-icon" aria-hidden="true">
        <IconRestore />
      </span>
      <span>{i18n.t('ui', 'pivotRefresh')}</span>
    </button>
  );
  const schemaLoading =
    effectiveSourceKind === 'model' && effectiveModel && !schema && !schemaError;
  const statusError = error || schemaError || transferFeedback?.error;
  const statusText = transferBusy
    ? transferFeedback?.progress
      ? `${i18n.t('ui', `transferStage_${transferFeedback.progress.stage}`)}${
          transferFeedback.progress.total
            ? ` · ${transferFeedback.progress.completed} / ${transferFeedback.progress.total}`
            : ''
        }`
      : i18n.t('ui', 'transferCancelling')
    : busy
      ? i18n.t('ui', 'pivotRefreshing')
      : statusError
        ? `${statusError}${error && document ? ` · ${i18n.t('ui', 'pivotPreviousResult')}` : ''}`
        : pendingConditions
          ? i18n.t(
              'ui',
              effectiveSourceKind === 'interface'
                ? 'pivotParametersPending'
                : 'transferFiltersPending',
            )
          : schemaLoading
            ? i18n.t('ui', 'transferLoadingSchema')
            : transferFeedback?.message || '';

  return (
    <div className="pivot-tab">
      <div
        className="pivot-workspace-toolbar"
        data-busy={busy || transferBusy}
        role="region"
        aria-label={i18n.t('ui', 'pivotToolbar')}
      >
        <div className="pivot-tab-header">
          {props.onBack ? (
            <button type="button" className="designer-btn" onClick={props.onBack}>
              {i18n.t('ui', 'pivotBack')}
            </button>
          ) : null}
          <div className="pivot-source-identity">
            <span className="designer-field-label">
              {i18n.t('ui', effectiveSourceKind === 'model' ? 'pivotModel' : 'pivotInterface')}
            </span>
            <strong>
              {effectiveSourceKind === 'model'
                ? effectiveModel
                  ? resolveModelDisplayName(effectiveModel, i18n.locale)
                  : '-'
                : (effectiveInterface?.name ?? '-')}
            </strong>
            {effectiveSourceKind === 'interface' && release ? (
              <span className="pivot-source-version">v{release.version}</span>
            ) : null}
          </div>
          <span className="pivot-library-badge">{config.activeLibraryName ?? '-'}</span>
        </div>

        <div className="pivot-source-card">
          {!props.sourceContext ? (
            <div
              className="pivot-source-tabs"
              role="tablist"
              aria-label={i18n.t('ui', 'pivotSource')}
            >
              <button
                type="button"
                role="tab"
                aria-selected={sourceKind === 'model'}
                className={sourceKind === 'model' ? 'is-active' : ''}
                onClick={() => setSourceKind('model')}
                disabled={busy || transferBusy}
              >
                {i18n.t('ui', 'pivotSourceModel')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={sourceKind === 'interface'}
                className={sourceKind === 'interface' ? 'is-active' : ''}
                onClick={() => setSourceKind('interface')}
                disabled={busy || transferBusy}
              >
                {i18n.t('ui', 'pivotSourceInterface')}
              </button>
            </div>
          ) : null}
          {effectiveSourceKind === 'model' ? (
            props.sourceContext ? null : (
              <label className="designer-field">
                <span className="designer-field-label">{i18n.t('ui', 'pivotModel')}</span>
                <DesignerSelect
                  value={modelId}
                  options={modelOptions}
                  onChange={setModelId}
                  disabled={busy || transferBusy}
                  searchable
                  emptyLabel={i18n.t('ui', 'pivotNoModels')}
                />
              </label>
            )
          ) : props.sourceContext ? null : (
            <label className="designer-field">
              <span className="designer-field-label">{i18n.t('ui', 'pivotInterface')}</span>
              <DesignerSelect
                value={interfaceId}
                options={interfaceOptions}
                onChange={setInterfaceId}
                disabled={busy || transferBusy}
                searchable
                emptyLabel={i18n.t('ui', 'pivotNoPublishedInterfaces')}
              />
            </label>
          )}
          {effectiveSourceKind === 'interface' && release ? (
            <InterfaceQueryInputs
              key={`interface-input:${autoRunKey}`}
              release={release}
              models={models}
              relations={relations}
              values={parameterValues}
              issues={inputIsCurrent && interfaceInput.validated ? preparedParameters.issues : []}
              accessKey={accessKey}
              needsInput={Boolean(needsInterfaceInput)}
              disabled={busy || transferBusy}
              onChange={(values) =>
                setInterfaceInput({
                  key: autoRunKey,
                  values,
                  accessKey,
                  validated: interfaceInput.validated,
                })
              }
              onAccessKeyChange={(value) =>
                setInterfaceInput({
                  key: autoRunKey,
                  values: parameterValues,
                  accessKey: value,
                  validated: interfaceInput.validated,
                })
              }
            />
          ) : null}
          {effectiveSourceKind === 'model' && effectiveModel ? (
            <ModelQueryFilters
              key={`model-filters:${autoRunKey}`}
              schema={schema}
              filters={filters}
              disabled={busy || transferBusy}
              onChange={(next) => setFilterState({ key: autoRunKey, filters: next })}
            />
          ) : null}
          {config.activeLibraryName &&
          ((effectiveSourceKind === 'model' && effectiveModel) ||
            (effectiveSourceKind === 'interface' && release)) ? (
            <DataTransferPanel
              key={`transfer:${autoRunKey}`}
              modelName={
                effectiveSourceKind === 'model' ? effectiveModel!.model_name : release!.callableName
              }
              database={config.activeLibraryName}
              schema={schema}
              filters={filters}
              disabled={busy}
              beforeExport={execute}
              onFeedbackChange={setTransferFeedback}
              refreshControl={refreshButton}
              queryInterface={
                effectiveSourceKind === 'interface' && release
                  ? { release, getDocument: () => documentRef.current }
                  : undefined
              }
            />
          ) : (
            <div className="pivot-source-actions">{refreshButton}</div>
          )}
        </div>

        <div className="pivot-result-toolbar">
          <div className="pivot-toolbar-group" role="group" aria-label={i18n.t('ui', 'pivotView')}>
            <span>{i18n.t('ui', 'pivotView')}</span>
            <button
              type="button"
              className={viewMode === 'table' ? 'is-active' : ''}
              aria-pressed={viewMode === 'table'}
              onClick={() => setViewMode('table')}
            >
              {i18n.t('ui', 'pivotTable')}
            </button>
            <button
              type="button"
              className={viewMode === 'hierarchy' ? 'is-active' : ''}
              aria-pressed={viewMode === 'hierarchy'}
              onClick={() => setViewMode('hierarchy')}
            >
              {i18n.t('ui', 'pivotHierarchy')}
            </button>
            <button
              type="button"
              className={viewMode === 'json' ? 'is-active' : ''}
              aria-pressed={viewMode === 'json'}
              onClick={() => setViewMode('json')}
            >
              {i18n.t('ui', 'pivotJson')}
            </button>
          </div>
          <div
            className="pivot-toolbar-group"
            role="group"
            aria-label={i18n.t('ui', 'pivotLanguageMode')}
          >
            <span>{i18n.t('ui', 'pivotLanguageMode')}</span>
            {(['current', 'raw', 'all'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={languageMode === mode ? 'is-active' : ''}
                aria-pressed={languageMode === mode}
                onClick={() => setLanguageMode(mode)}
              >
                {i18n.t('ui', `pivotLanguage_${mode}`)}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div
        className="pivot-result-scroll"
        role="region"
        aria-label={i18n.t('ui', 'pivotResults')}
        aria-busy={busy}
        tabIndex={0}
      >
        {document ? (
          <PivotDocumentView
            key={`${autoRunKey}:${appliedSignature}:${document.page.mode}:${document.page.page ?? 0}:${document.page.limit ?? 0}`}
            display={display}
            document={document}
            schema={schema}
            viewMode={viewMode}
            languageMode={languageMode}
            locale={i18n.locale}
            emptyRowsLabel={i18n.t('ui', 'pivotNoRows')}
            emptyScalarLabel={i18n.t('ui', 'pivotNoSelectedFields')}
            jsonLabel={i18n.t('ui', 'pivotJsonResult')}
            hierarchyFieldLabel={i18n.t('ui', 'pivotHierarchyField')}
            hierarchyTypeLabel={i18n.t('ui', 'pivotHierarchyType')}
            hierarchyValueLabel={i18n.t('ui', 'pivotHierarchyValue')}
            hierarchyRecordLabel={(count) => i18n.t('ui', 'pivotRecord', { count })}
            hierarchyExpandLabel={i18n.t('ui', 'pivotExpand')}
            hierarchyCollapseLabel={i18n.t('ui', 'pivotCollapse')}
            hierarchyNodeTypeLabel={(kind) => i18n.t('ui', `pivotNode_${kind}`)}
            tableLabels={{
              emptyRows: i18n.t('ui', 'pivotNoRows'),
              emptyFields: i18n.t('ui', 'pivotNoSelectedFields'),
              expand: i18n.t('ui', 'pivotExpand'),
              collapse: i18n.t('ui', 'pivotCollapse'),
              expandAll: i18n.t('ui', 'pivotExpandAll'),
              collapseAll: i18n.t('ui', 'pivotCollapseAll'),
              missing: i18n.t('ui', 'pivotMissingValue'),
              null: i18n.t('ui', 'pivotNullValue'),
              yes: i18n.t('ui', 'pivotBooleanYes'),
              no: i18n.t('ui', 'pivotBooleanNo'),
              rows: (count) => i18n.t('ui', 'pivotRows', { count: String(count) }),
            }}
          />
        ) : (
          <div className="pivot-empty">
            {busy ? i18n.t('ui', 'pivotRefreshing') : i18n.t('ui', 'pivotEmpty')}
          </div>
        )}
      </div>
      <footer className="pivot-workspace-footer">
        <div
          className={`pivot-workspace-status${!busy && !transferBusy && statusError ? ' is-error' : ''}`}
        >
          <span
            className="pivot-status-text"
            role={!busy && !transferBusy && statusError ? 'alert' : 'status'}
            aria-live="polite"
            tabIndex={statusText ? 0 : undefined}
            title={statusText}
          >
            {statusText}
          </span>
          {transferBusy ? (
            <>
              <progress
                aria-label={statusText}
                {...(transferFeedback?.progress?.total
                  ? {
                      value: transferFeedback.progress.completed,
                      max: transferFeedback.progress.total,
                    }
                  : {})}
              />
              <button type="button" className="designer-btn" onClick={transferFeedback?.cancel}>
                {i18n.t('ui', 'transferCancel')}
              </button>
            </>
          ) : null}
        </div>
        <div className="pivot-pagination" aria-label={i18n.t('ui', 'pivotPagination')}>
          <span className="pivot-row-count">
            {document ? i18n.t('ui', 'pivotRows', { count: String(document.rows.length) }) : '—'}
            {document?.page.total !== undefined
              ? ` · ${i18n.t('ui', 'pivotTotal', { count: String(document.page.total) })}`
              : ''}
          </span>
          {effectiveSourceKind === 'model' ? (
            <label className="pivot-paging-switch">
              <input
                type="checkbox"
                role="switch"
                checked={paginationMode !== 'none'}
                disabled={busy || transferBusy || !document}
                onChange={(event) =>
                  void execute(undefined, {
                    page: 0,
                    limit: pageLimit,
                    enabled: event.target.checked,
                  })
                }
              />
              {i18n.t('ui', 'pivotPagination')}
            </label>
          ) : null}
          {paginationMode === 'none' ? <span>{i18n.t('ui', 'pivotUnpaged')}</span> : null}
          <div className="pivot-page-controls" hidden={paginationMode === 'none'}>
            <label>
              {i18n.t('ui', 'pivotPageSize')}{' '}
              <select
                className="designer-input"
                value={pageLimit}
                disabled={busy || transferBusy || !document}
                onChange={(event) =>
                  void execute(undefined, { page: 0, limit: Number(event.target.value) })
                }
              >
                {[...new Set([10, 20, 50, 100, pageLimit])]
                  .filter(
                    (value) =>
                      value <=
                      (effectiveSourceKind === 'interface'
                        ? (release?.executionTemplate.pagination.maxLimit ?? 10000)
                        : 100),
                  )
                  .sort((a, b) => a - b)
                  .map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
              </select>
            </label>
            <button
              type="button"
              className="designer-btn"
              disabled={busy || transferBusy || !document || pageIndex === 0 || pendingConditions}
              onClick={() => void execute(undefined, { page: pageIndex - 1, limit: pageLimit })}
            >
              {i18n.t('ui', 'pivotPreviousPage')}
            </button>
            <span className="pivot-page-number">
              {i18n.t('ui', 'pivotPageNumber', { page: String(pageIndex + 1) })}
              {document?.page.pageCount !== undefined
                ? ` / ${Math.max(1, document.page.pageCount)}`
                : ''}
            </span>
            <button
              type="button"
              className="designer-btn"
              disabled={
                busy ||
                transferBusy ||
                !document ||
                pendingConditions ||
                (paginationMode === 'cursor'
                  ? !document.page.nextCursor
                  : document.page.pageCount !== undefined
                    ? pageIndex + 1 >= document.page.pageCount
                    : document.rows.length < pageLimit)
              }
              onClick={() => void execute(undefined, { page: pageIndex + 1, limit: pageLimit })}
            >
              {i18n.t('ui', 'pivotNextPage')}
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}

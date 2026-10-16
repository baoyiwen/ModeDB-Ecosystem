import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { QueryInterfaceRelease } from '../query-designer/index.js';
import {
  DEFAULT_PIVOT_VIEW,
  DEFAULT_PIVOT_LANGUAGE,
  buildInterfacePivotSchema,
  buildModelPivotSchema,
  buildPivotModelFieldPolicy,
  buildPivotTable,
  formatPivotValue,
  isPivotI18nValue,
  resolvePivotPathLabel,
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
import { PivotCompositeTable, type PivotTableLabels } from './PivotCompositeTable.js';
import { IconLink, IconRestore } from './designer-icons.js';

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

type PivotTreeTableRow = {
  readonly node: PivotNode;
  readonly depth: number;
  readonly recordIndex: number;
};

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

  useEffect(() => {
    setExpandedNodeIds(new Set(rootNodeIds));
  }, [rootNodeIds]);

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
    <div className="pivot-table-wrap pivot-hierarchy-table-wrap">
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
              schema && node.path.length > 0
                ? resolvePivotPathLabel(schema, node.path, locale)
                : node.kind === 'record'
                  ? recordLabel(String(recordIndex + 1))
                  : node.key;
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
    emptyScalarLabel,
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
    if (!table) {
      return <div className="pivot-empty">{emptyScalarLabel}</div>;
    }
    return (
      <PivotCompositeTable
        key={document.createdAt}
        table={table}
        locale={locale}
        languageMode={languageMode}
        labels={props.tableLabels}
      />
    );
  }

  if (document.rows.length === 0) {
    return <div className="pivot-empty">{emptyRowsLabel}</div>;
  }
  return (
    <PivotHierarchyTable
      document={document}
      schema={schema}
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
  onEditQueryInterface?: (id: string) => void;
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
  const [parametersText, setParametersText] = useState('');
  const [viewMode, setViewMode] = useState<PivotViewMode>(DEFAULT_PIVOT_VIEW);
  const [languageMode, setLanguageMode] = useState<PivotLanguageMode>(DEFAULT_PIVOT_LANGUAGE);
  const [document, setDocument] = useState<PivotDocument | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoRunKeyRef = useRef<string | undefined>(undefined);

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
  const schema = useMemo(
    () =>
      effectiveSourceKind === 'model'
        ? effectiveModel
          ? buildModelPivotSchema(effectiveModel.id, models, relations)
          : undefined
        : effectiveInterface?.publishedRelease
          ? buildInterfacePivotSchema(effectiveInterface.publishedRelease, models, relations)
          : undefined,
    [effectiveSourceKind, effectiveModel, effectiveInterface, models, relations],
  );
  const effectiveModelPolicy = useMemo(
    () =>
      effectiveSourceKind === 'model' && schema ? buildPivotModelFieldPolicy(schema) : undefined,
    [effectiveSourceKind, schema],
  );

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

  const execute = useCallback(async (): Promise<void> => {
    const libraryName = config.activeLibraryName;
    if (!libraryName) {
      setError(i18n.t('ui', 'pivotNoLibrary'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let parameters: Readonly<Record<string, unknown>> | undefined;
      if (parametersText.trim()) {
        const parsed: unknown = JSON.parse(parametersText);
        if (!isRecord(parsed)) {
          throw new Error(i18n.t('ui', 'pivotParametersObject'));
        }
        parameters = parsed;
      }
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
                parameters,
              })
            : (() => {
                throw new Error(i18n.t('ui', 'pivotSelectPublishedInterface'));
              })();
      setDocument(next);
    } catch (cause) {
      setDocument(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [
    config.activeLibraryName,
    effectiveInterface,
    effectiveModel,
    effectiveModelPolicy,
    effectiveSourceKind,
    i18n,
    parametersText,
  ]);

  const executeRef = useRef(execute);
  useEffect(() => {
    executeRef.current = execute;
  }, [execute]);

  const autoRunKey =
    effectiveSourceKind === 'model'
      ? effectiveModel
        ? `library:${config.activeLibraryName ?? ''}:model:${effectiveModel.id}`
        : undefined
      : effectiveInterface?.publishedRelease
        ? `library:${config.activeLibraryName ?? ''}:interface:${effectiveInterface.id}:${effectiveInterface.publishedRelease.version}`
        : undefined;
  useEffect(() => {
    if (!autoRunKey || autoRunKeyRef.current === autoRunKey) {
      return;
    }
    autoRunKeyRef.current = autoRunKey;
    void executeRef.current();
  }, [autoRunKey]);

  return (
    <div className="pivot-tab">
      <div className="pivot-tab-header">
        <div>
          <div className="designer-panel-section-title">
            {effectiveSourceKind === 'interface'
              ? effectiveInterface?.name
              : effectiveModel
                ? resolveModelDisplayName(effectiveModel, i18n.locale)
                : i18n.t('ui', 'pivotTitle')}
          </div>
          {effectiveSourceKind === 'interface' && effectiveInterface?.publishedRelease ? (
            <span className="pivot-release-version">
              v{effectiveInterface.publishedRelease.version}
            </span>
          ) : null}
        </div>
        <div className="pivot-header-actions">
          <span className="pivot-library-badge">{config.activeLibraryName ?? '-'}</span>
          {effectiveSourceKind === 'interface' &&
          effectiveInterface &&
          props.onEditQueryInterface ? (
            <button
              type="button"
              className="designer-btn"
              onClick={() => props.onEditQueryInterface?.(effectiveInterface.id)}
            >
              <IconLink />
              {i18n.t('ui', 'queryEditInDesigner')}
            </button>
          ) : null}
          <button
            type="button"
            className="designer-btn designer-btn-primary pivot-run-button"
            disabled={busy}
            onClick={() => void execute()}
          >
            <IconRestore />
            {busy ? i18n.t('ui', 'pivotRunning') : i18n.t('ui', 'pivotRefresh')}
          </button>
        </div>
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
            >
              {i18n.t('ui', 'pivotSourceModel')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={sourceKind === 'interface'}
              className={sourceKind === 'interface' ? 'is-active' : ''}
              onClick={() => setSourceKind('interface')}
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
              searchable
              emptyLabel={i18n.t('ui', 'pivotNoPublishedInterfaces')}
            />
          </label>
        )}
        {effectiveSourceKind === 'interface' ? (
          <details
            className="pivot-parameter-section"
            key={effectiveInterfaceId}
            open={
              effectiveInterface?.publishedRelease?.queryInterface.contract.parameters.some(
                (parameter) => parameter.required && parameter.defaultValue === undefined,
              ) || undefined
            }
          >
            <summary>
              {i18n.t('ui', 'pivotParameters')}
              <span>
                {effectiveInterface?.publishedRelease?.queryInterface.contract.parameters.length ??
                  0}
              </span>
            </summary>
            <label className="designer-field">
              <span className="designer-field-label">{i18n.t('ui', 'pivotParameters')}</span>
              <textarea
                className="designer-textarea pivot-parameters"
                value={parametersText}
                onChange={(event) => setParametersText(event.target.value)}
                placeholder={'{\n  "id": "..."\n}'}
                spellCheck={false}
              />
            </label>
          </details>
        ) : null}
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

      {error ? (
        <div className="pivot-error" role="alert">
          {error}
        </div>
      ) : null}
      {document ? (
        <>
          <div className="pivot-result-meta">
            <span>{i18n.t('ui', 'pivotRows', { count: String(document.rows.length) })}</span>
            <span>
              {document.page.mode === 'none' ? i18n.t('ui', 'pivotUnpaged') : document.page.mode}
            </span>
          </div>
          <PivotDocumentView
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
        </>
      ) : (
        <div className="pivot-empty">{i18n.t('ui', 'pivotEmpty')}</div>
      )}
    </div>
  );
}

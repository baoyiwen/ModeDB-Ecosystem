import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { QueryInterfaceRelease } from '../query-designer/index.js';
import {
  collectPivotLeafNodes,
  executeInterfacePivot,
  executeModelPivot,
  type PivotDocument,
  type PivotModelFieldPolicy,
  type PivotNode,
} from '../pivot/index.js';
import type { EngineModelNode, EngineRelationEdge } from '../types/engine-schema.js';
import { resolveI18nForLocale, resolveModelDisplayName } from '../utils/i18n-resolve.js';
import { useDesigner } from '../context/designer-context.js';
import { DesignerSelect } from './base/designer-select.js';

export interface PivotQueryInterfaceView {
  readonly id: string;
  readonly name: string;
  readonly publishedRelease?: QueryInterfaceRelease;
}

type PivotSourceKind = 'model' | 'interface';
type PivotViewMode = 'hierarchy' | 'table' | 'json';
type PivotLanguageMode = 'current' | 'raw' | 'all';

function modelFieldPolicy(
  model: EngineModelNode,
  models: readonly EngineModelNode[],
  relations: readonly EngineRelationEdge[],
): PivotModelFieldPolicy {
  const fieldsByModelId = new Map(
    models.map((item) => [
      item.id,
      item.props_objects_array.map((prop) => prop.name).filter(Boolean),
    ]),
  );
  const relatedFields: Record<string, readonly string[]> = {};
  for (const relation of relations) {
    const targetModelId =
      relation.source_model_id === model.id
        ? relation.target_model_id
        : relation.target_model_id === model.id
          ? relation.source_model_id
          : undefined;
    if (!targetModelId) {
      continue;
    }
    const fields = fieldsByModelId.get(targetModelId) ?? [];
    const names = [
      relation.forward_name,
      relation.engine_forward_name,
      relation.reverse_name,
      relation.engine_reverse_name,
      relation.id,
    ].filter((name): name is string => Boolean(name?.trim()));
    for (const name of names) {
      relatedFields[name] = fields;
    }
  }
  return {
    fields: fieldsByModelId.get(model.id) ?? [],
    relatedFields,
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isI18nMap(value: unknown): value is Readonly<Record<string, string>> {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return (
    keys.length > 0 &&
    keys.some((key) => key === 'zh' || key === 'en' || key === 'ja') &&
    keys.every((key) => /^[a-z]{2}(?:-[A-Z]{2})?$/.test(key)) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
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
    return value;
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

function collectVisibleTreeRows(
  document: PivotDocument,
  expandedNodeIds: ReadonlySet<string>,
): readonly PivotTreeTableRow[] {
  const rows: PivotTreeTableRow[] = [];
  const visit = (node: PivotNode, depth: number, recordIndex: number): void => {
    rows.push({ node, depth, recordIndex });
    if (!expandedNodeIds.has(node.id)) {
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
  if (node.children.length === 0) {
    return formatValue(node.value, locale, languageMode);
  }
  if (node.kind === 'array') {
    return `[${node.children.length}]`;
  }
  return `{${node.children.length}}`;
}

function PivotHierarchyTable(props: {
  document: PivotDocument;
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
    () => collectVisibleTreeRows(document, expandedNodeIds),
    [document, expandedNodeIds],
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
            const expandable = node.children.length > 0;
            const expanded = expandedNodeIds.has(node.id);
            const label = node.kind === 'record' ? recordLabel(String(recordIndex + 1)) : node.key;
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
}): ReactElement {
  const {
    document,
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
    const columns = Array.from(
      new Map(
        document.rows
          .flatMap((row) => collectPivotLeafNodes(row))
          .map((node) => [JSON.stringify(node.path), node] as const),
      ).values(),
    );
    if (columns.length === 0) {
      return <div className="pivot-empty">{emptyScalarLabel}</div>;
    }
    return (
      <div className="pivot-table-wrap">
        <table className="pivot-table">
          <thead>
            <tr>
              <th scope="col">#</th>
              {columns.map((column) => (
                <th key={column.id} scope="col">
                  {column.path.map((segment) => segment.key).join('.')}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {document.rows.map((row, index) => {
              const byPath = new Map(
                collectPivotLeafNodes(row).map((node) => [JSON.stringify(node.path), node.value]),
              );
              return (
                <tr key={row.id}>
                  <th scope="row">{index + 1}</th>
                  {columns.map((column) => (
                    <td key={column.id}>
                      {formatValue(byPath.get(JSON.stringify(column.path)), locale, languageMode)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  if (document.rows.length === 0) {
    return <div className="pivot-empty">{emptyRowsLabel}</div>;
  }
  return (
    <PivotHierarchyTable
      document={document}
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
  const [viewMode, setViewMode] = useState<PivotViewMode>('hierarchy');
  const [languageMode, setLanguageMode] = useState<PivotLanguageMode>('current');
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
  const effectiveModelPolicy = effectiveModel
    ? modelFieldPolicy(effectiveModel, models, relations)
    : undefined;

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
          <div className="designer-panel-section-title">{i18n.t('ui', 'pivotTitle')}</div>
          <p className="pivot-tab-description">{i18n.t('ui', 'pivotDescription')}</p>
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
          props.sourceContext ? (
            <div className="pivot-context-source">
              <span className="designer-field-label">{i18n.t('ui', 'pivotModel')}</span>
              <strong>
                {effectiveModel ? resolveModelDisplayName(effectiveModel, i18n.locale) : '-'}
              </strong>
            </div>
          ) : (
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
        ) : props.sourceContext ? (
          <div className="pivot-context-source">
            <span className="designer-field-label">{i18n.t('ui', 'pivotInterface')}</span>
            <strong>{effectiveInterface?.name ?? '-'}</strong>
          </div>
        ) : (
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
        {sourceKind === 'interface' ? (
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
        ) : null}
        <button
          type="button"
          className="designer-btn designer-btn-primary pivot-run-button"
          disabled={busy}
          onClick={() => void execute()}
        >
          {busy ? i18n.t('ui', 'pivotRunning') : i18n.t('ui', 'pivotRun')}
        </button>
      </div>

      <div className="pivot-result-toolbar">
        <div className="pivot-toolbar-group" role="group" aria-label={i18n.t('ui', 'pivotView')}>
          <span>{i18n.t('ui', 'pivotView')}</span>
          <button
            type="button"
            className={viewMode === 'hierarchy' ? 'is-active' : ''}
            onClick={() => setViewMode('hierarchy')}
          >
            {i18n.t('ui', 'pivotHierarchy')}
          </button>
          <button
            type="button"
            className={viewMode === 'table' ? 'is-active' : ''}
            onClick={() => setViewMode('table')}
          >
            {i18n.t('ui', 'pivotTable')}
          </button>
          <button
            type="button"
            className={viewMode === 'json' ? 'is-active' : ''}
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
            viewMode={viewMode}
            languageMode={languageMode}
            locale={i18n.locale}
            emptyRowsLabel={i18n.t('ui', 'pivotNoRows')}
            emptyScalarLabel={i18n.t('ui', 'pivotNoScalarFields')}
            jsonLabel={i18n.t('ui', 'pivotJsonResult')}
            hierarchyFieldLabel={i18n.t('ui', 'pivotHierarchyField')}
            hierarchyTypeLabel={i18n.t('ui', 'pivotHierarchyType')}
            hierarchyValueLabel={i18n.t('ui', 'pivotHierarchyValue')}
            hierarchyRecordLabel={(count) => i18n.t('ui', 'pivotRecord', { count })}
            hierarchyExpandLabel={i18n.t('ui', 'pivotExpand')}
            hierarchyCollapseLabel={i18n.t('ui', 'pivotCollapse')}
            hierarchyNodeTypeLabel={(kind) => i18n.t('ui', `pivotNode_${kind}`)}
          />
        </>
      ) : (
        <div className="pivot-empty">{i18n.t('ui', 'pivotEmpty')}</div>
      )}
    </div>
  );
}

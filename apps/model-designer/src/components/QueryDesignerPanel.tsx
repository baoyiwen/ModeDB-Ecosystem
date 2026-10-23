import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react';
import { createPortal } from 'react-dom';
import { useAppConfirm } from '@mode-db/data-ui';
import {
  connectionOrigin,
  QueryInterfaceInvocationError,
  queryInterfaceAccessKeyDigest,
} from '@mode-db/sdk';
import type { EngineModelNode, EngineRelationEdge } from '../types/engine-schema.js';
import { useDesigner } from '../context/designer-context.js';
import {
  resolveBusinessConnectionParams,
  withBusinessLibrarySession,
} from '../engine/business-library-session.js';
import { DesignerTooltip } from './base/designer-tooltip.js';
import { resolveI18nForLocale } from '../utils/i18n-resolve.js';
import { sortPropsBySort } from '../utils/prop-order.js';
import {
  EMPTY_QUERY_CHAIN_STATE,
  buildQueryInterfaceDraft,
  interfaceValueTypeForPropType,
  outgoingRelationsForModel,
  queryChainEdgeStates,
  queryChainEdgeKey,
  queryChainGraphInstances,
  queryChainModelIds,
  queryChainTailModelId,
  queryGraphOutputNodes,
  queryProjectionFieldKey,
  createQueryFilterRoot,
  appendQueryFilterExpression,
  flattenQueryFilterTree,
  isQueryFilterGroup,
  isQueryRelationFilter,
  mapQueryFilterTree,
  queryFilterExpressionCount,
  queryFilterGroupCount,
  queryRelationFilterCount,
  queryFilterTreeFromSpec,
  removeQueryFilterExpression,
  updateQueryFilterExpression,
  removeQueryChainNodeInstance,
  removeQueryChainRelation,
  reverseQueryChainPrimaryPath,
  assessQueryInterfaceReleaseImpact,
  queryInterfacePublicationSignature,
  validateEngineInterface,
  compileQueryExecutionPlan,
  executeQueryExecutionPlan,
  type QueryChainState,
  type QueryGraphEdgeDirection,
  type QueryGraphEdgeInstance,
  type QueryGraphEdgeRole,
  type QueryGraphEdgeState,
  type QueryGraphInstances,
  type QueryGraphRelationUsage,
  type QueryModelPickCandidate,
  type QueryRelationPickCandidate,
  type InterfaceParameter,
  type InterfacePermissionPolicy,
  type InterfaceValueType,
  type QueryAggregateMetric,
  type QueryAggregationSpec,
  type QueryFilter,
  type QueryFilterGroup,
  type QueryFilterOperator,
  type QueryInterface,
  type QueryInterfaceRelease,
  type QueryInterfaceReleaseChange,
  type QueryInterfaceReleaseImpact,
  type QueryExecutionDiagnostic,
  type QueryExecutionStage,
  type QueryPreviewResult,
  type QueryMetricRef,
  type QueryPagination,
  type QueryRelationFilter,
  type QuerySort,
} from '../query-designer/index.js';
import { interfaceDiagnosticMessage } from '../utils/interface-diagnostic-i18n.js';
import { connectionErrorMessage } from '../config/connection-error.js';
import {
  buildInterfaceCallDocs,
  publishedInterfaceCallBody,
} from '../query-designer/interface-call-docs.js';
import { createUuid } from '../utils/random-id.js';
import {
  listQueryInterfaceAuditSummaries,
  type QueryInterfaceAuditSummary,
} from '../sync/query-interface-registry.js';

export interface SavedQueryInterfaceView {
  id: string;
  storageId?: string;
  name: string;
  queryInterface: QueryInterface;
  queryChain: QueryChainState;
  createdAt: string;
  updatedAt: string;
  signature?: string;
  projectionConfigured?: boolean;
  publishedRelease?: QueryInterfaceRelease;
  releaseHistory?: QueryInterfaceRelease[];
  auditSummary?: QueryInterfaceAuditSummary;
}

export type QueryInterfaceSaveResult =
  | { status: 'created'; id: string; name: string }
  | { status: 'updated'; id: string; name: string }
  | { status: 'unchanged'; id: string; name: string };

export function QueryDesignerPanel(props: {
  selectedModelId: string | undefined;
  queryChain: QueryChainState;
  pendingQueryRelationPick:
    | { relationId: string; candidates: readonly QueryRelationPickCandidate[] }
    | undefined;
  pendingQueryModelPick:
    | { modelId: string; candidates: readonly QueryModelPickCandidate[] }
    | undefined;
  activeQueryInterface: SavedQueryInterfaceView | undefined;
  onQueryChainChange: (queryChain: QueryChainState) => void;
  onResolveQueryRelationPick: (sourceNodeIds: readonly string[]) => void;
  onCancelQueryRelationPick: () => void;
  onResolveQueryModelPick: (candidates: readonly QueryModelPickCandidate[]) => void;
  onCancelQueryModelPick: () => void;
  onSaveQueryInterface: (
    queryInterface: QueryInterface,
    queryChain: QueryChainState,
    name: string,
    description: string,
    activeInterfaceId?: string,
    projectionConfigured?: boolean,
  ) => QueryInterfaceSaveResult;
  onClearActiveQueryInterface: () => void;
}): ReactElement {
  const { data, i18n, modes } = useDesigner();
  const [panelMode, setPanelMode] = useState<
    'chain' | 'fields' | 'filters' | 'contract' | 'preview'
  >('chain');
  const [saveName, setSaveName] = useState('');
  const [saveDescription, setSaveDescription] = useState('');
  const [projectionFieldKeys, setProjectionFieldKeys] = useState<readonly string[] | undefined>(
    undefined,
  );
  const [parameters, setParameters] = useState<readonly InterfaceParameter[]>([]);
  const [filterTree, setFilterTree] = useState<QueryFilterGroup>(() => createQueryFilterRoot());
  const [aggregation, setAggregation] = useState<QueryAggregationSpec>(() => ({
    groupBy: [],
    metrics: [],
  }));
  const [sorts, setSorts] = useState<readonly QuerySort[]>([]);
  const [pagination, setPagination] = useState<QueryPagination>({ mode: 'none' });
  const [permissions, setPermissions] = useState<InterfacePermissionPolicy>({ mode: 'none' });
  const [accessKeyInput, setAccessKeyInput] = useState('');
  const [saveFeedback, setSaveFeedback] = useState<QueryInterfaceSaveResult['status'] | 'idle'>(
    'idle',
  );
  const lastDraftSignatureRef = useRef('');
  const saveNameTouchedRef = useRef(false);
  const saveDescriptionTouchedRef = useRef(false);
  const activeInterfaceVersionRef = useRef<string | undefined>(undefined);
  const projectionFieldSourceRef = useRef<string | undefined>(undefined);
  const saveFeedbackTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (modes.mode === 'query-create') {
      setPanelMode('fields');
      return;
    }
    if (modes.mode === 'query-inspect') {
      setPanelMode('contract');
      return;
    }
    if (modes.mode === 'query-preview') {
      setPanelMode('preview');
      return;
    }
    setPanelMode('chain');
  }, [modes.mode]);

  const models = data.models;
  const relations = data.relations;
  const effectiveRootId = props.queryChain.rootModelId ?? props.selectedModelId;
  const rootModel = effectiveRootId
    ? models.find((model) => model.id === effectiveRootId)
    : undefined;
  const edgeStates = queryChainEdgeStates(props.queryChain);
  const relationViews = edgeStates
    .map((edge) => ({
      edge,
      relation: relations.find((relation) => relation.id === edge.relationId),
    }))
    .filter(
      (
        item,
      ): item is {
        edge: (typeof edgeStates)[number];
        relation: EngineRelationEdge;
      } => Boolean(item.relation),
    );
  const primaryRelations = relationViews.filter((item) => item.edge.role === 'primary');
  const branchRelations = relationViews.filter((item) => item.edge.role === 'branch');
  const constraintRelations = relationViews.filter((item) => item.edge.role === 'constraint');
  const tailModelId = queryChainTailModelId(props.queryChain, relations) ?? effectiveRootId;
  const availableRelations = tailModelId ? outgoingRelationsForModel(tailModelId, relations) : [];
  const modelPathIds = queryChainModelIds(props.queryChain, relations);
  const graphInstances = queryChainGraphInstances(props.queryChain, relations);
  const outputGraphNodes = useMemo(() => queryGraphOutputNodes(graphInstances), [graphInstances]);
  const projectionCandidates = useMemo(
    () => buildProjectionFieldCandidates(outputGraphNodes, models, i18n.locale),
    [i18n.locale, models, outputGraphNodes],
  );
  const conditionFieldCandidates = useMemo(
    () => buildProjectionFieldCandidates(graphInstances.nodes, models, i18n.locale),
    [graphInstances.nodes, i18n.locale, models],
  );
  const aggregationSubjectNodeId =
    graphInstances.primaryPathNodeIds.at(-1) ?? graphInstances.rootNodeId;
  const aggregationFieldCandidates = useMemo(
    () =>
      conditionFieldCandidates.filter((candidate) => candidate.nodeId === aggregationSubjectNodeId),
    [aggregationSubjectNodeId, conditionFieldCandidates],
  );
  const relationConditionCandidates = useMemo(
    () => buildQueryRelationConditionCandidates(graphInstances, models, relations),
    [graphInstances, models, relations],
  );
  const defaultProjectionFieldKeys = useMemo(
    () =>
      projectionCandidates
        .filter((candidate) => candidate.nodeRole === 'root')
        .map((candidate) => candidate.key),
    [projectionCandidates],
  );

  const draft = useMemo(() => {
    if (!effectiveRootId) {
      return null;
    }
    return buildQueryInterfaceDraft({
      rootModelId: effectiveRootId,
      edgeStates,
      graphInstances,
      models,
      relations,
      projectionFieldKeys,
      parameters,
      filterTree,
      aggregation: queryAggregationHasContent(aggregation) ? aggregation : undefined,
      sorts,
      pagination,
      permissions,
    });
  }, [
    effectiveRootId,
    edgeStates,
    filterTree,
    aggregation,
    graphInstances,
    models,
    parameters,
    pagination,
    permissions,
    projectionFieldKeys,
    relations,
    sorts,
  ]);

  const validation = draft ? validateEngineInterface(draft, models) : null;
  const draftDefaultName = draft?.displayName ?? draft?.name ?? '';
  const draftDefaultDescription = draft?.description ?? '';
  const draftSignature = draft
    ? [
        draft.designGraph.rootNodeId,
        draft.designGraph.nodes.map((node) => `${node.id}:${node.modelId}`).join(','),
        draft.designGraph.edges
          .map((edge) => `${edge.id}:${edge.relationId}:${edge.fromNodeId}:${edge.toNodeId}`)
          .join(','),
      ].join('|')
    : '';

  useEffect(() => {
    if (!draftSignature) {
      lastDraftSignatureRef.current = '';
      saveNameTouchedRef.current = false;
      saveDescriptionTouchedRef.current = false;
      setSaveName('');
      setSaveDescription('');
      setSaveFeedback('idle');
      return;
    }
    if (lastDraftSignatureRef.current === draftSignature) {
      return;
    }
    lastDraftSignatureRef.current = draftSignature;
    if (!saveNameTouchedRef.current) {
      setSaveName(draftDefaultName);
    }
    if (!saveDescriptionTouchedRef.current) {
      setSaveDescription(draftDefaultDescription);
    }
    setSaveFeedback('idle');
  }, [draftDefaultDescription, draftDefaultName, draftSignature]);

  const activeInterfaceVersion = props.activeQueryInterface
    ? `${props.activeQueryInterface.id}:${props.activeQueryInterface.updatedAt}`
    : undefined;

  useEffect(() => {
    if (projectionFieldSourceRef.current === activeInterfaceVersion) {
      return;
    }
    projectionFieldSourceRef.current = activeInterfaceVersion;
    setProjectionFieldKeys(
      props.activeQueryInterface && props.activeQueryInterface.projectionConfigured
        ? props.activeQueryInterface.queryInterface.query.projection.fields
            .filter((field) => field.visible)
            .map((field) => queryProjectionFieldKey(field.source.nodeId, field.source.fieldId))
        : undefined,
    );
    setParameters(props.activeQueryInterface?.queryInterface.contract.parameters ?? []);
    setFilterTree(
      queryFilterTreeFromSpec(
        props.activeQueryInterface?.queryInterface.query.filterTree,
        props.activeQueryInterface?.queryInterface.query.filters ?? [],
      ),
    );
    setAggregation(
      props.activeQueryInterface?.queryInterface.query.aggregation ?? {
        groupBy: [],
        metrics: [],
      },
    );
    setSorts(props.activeQueryInterface?.queryInterface.query.sorts ?? []);
    setPagination(props.activeQueryInterface?.queryInterface.query.pagination ?? { mode: 'none' });
    setPermissions(
      props.activeQueryInterface?.queryInterface.contract.permissions ?? { mode: 'none' },
    );
    setAccessKeyInput('');
  }, [activeInterfaceVersion, props.activeQueryInterface]);

  useEffect(() => {
    if (activeInterfaceVersionRef.current === activeInterfaceVersion) {
      return;
    }
    activeInterfaceVersionRef.current = activeInterfaceVersion;
    if (props.activeQueryInterface) {
      saveNameTouchedRef.current = true;
      saveDescriptionTouchedRef.current = true;
      setSaveName(props.activeQueryInterface.name);
      setSaveDescription(props.activeQueryInterface.queryInterface.description ?? '');
    } else {
      saveNameTouchedRef.current = false;
      saveDescriptionTouchedRef.current = false;
      lastDraftSignatureRef.current = draftSignature;
      setSaveName(draftDefaultName);
      setSaveDescription(draftDefaultDescription);
    }
    setSaveFeedback('idle');
  }, [
    activeInterfaceVersion,
    draftDefaultDescription,
    draftDefaultName,
    draftSignature,
    props.activeQueryInterface,
  ]);

  useEffect(
    () => () => {
      if (saveFeedbackTimerRef.current !== undefined) {
        window.clearTimeout(saveFeedbackTimerRef.current);
      }
    },
    [],
  );

  const resetChain = (): void => {
    props.onClearActiveQueryInterface();
    setProjectionFieldKeys(undefined);
    setParameters([]);
    setFilterTree(createQueryFilterRoot());
    setAggregation({ groupBy: [], metrics: [] });
    setSorts([]);
    setPagination({ mode: 'none' });
    setPermissions({ mode: 'none' });
    setAccessKeyInput('');
    props.onQueryChainChange(EMPTY_QUERY_CHAIN_STATE);
  };
  const reversePrimaryPath = (): void => {
    props.onQueryChainChange(reverseQueryChainPrimaryPath(props.queryChain, relations));
  };
  const saveCurrentInterface = (): void => {
    if (!draft || !validation?.ok) {
      return;
    }
    const result = props.onSaveQueryInterface(
      draft,
      props.queryChain,
      saveName || draft.displayName || draft.name,
      saveDescription,
      props.activeQueryInterface?.id,
      true,
    );
    setSaveFeedback(result.status);
    if (saveFeedbackTimerRef.current !== undefined) {
      window.clearTimeout(saveFeedbackTimerRef.current);
    }
    saveFeedbackTimerRef.current = window.setTimeout(() => setSaveFeedback('idle'), 1800);
  };

  return (
    <div className="query-designer-panel">
      <div
        className="query-designer-tabs"
        role="tablist"
        aria-label={i18n.t('ui', 'modeQueryDesigner')}
      >
        {(['chain', 'fields', 'filters', 'contract', 'preview'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            className="query-designer-tab"
            data-active={panelMode === mode ? 'true' : 'false'}
            role="tab"
            aria-selected={panelMode === mode}
            onClick={() => setPanelMode(mode)}
          >
            {i18n.t('ui', `queryPanelMode_${mode}`)}
          </button>
        ))}
      </div>

      <section className="query-designer-section query-interface-draft-name-section">
        <h3 className="designer-panel-section-title">{TEXT_INTERFACE_NAME}</h3>
        <div className="query-interface-save-row">
          <input
            type="text"
            className="query-interface-name-input"
            value={saveName}
            placeholder={draft?.displayName ?? draft?.name ?? TEXT_INTERFACE_NAME_PLACEHOLDER}
            disabled={!draft}
            onChange={(event) => {
              saveNameTouchedRef.current = true;
              setSaveName(event.target.value);
            }}
          />
          <button
            type="button"
            className="query-designer-button"
            disabled={!draft || modelPathIds.length === 0 || !validation?.ok}
            onClick={saveCurrentInterface}
          >
            {TEXT_SAVE_INTERFACE}
          </button>
        </div>
        <textarea
          className="query-interface-description-input"
          value={saveDescription}
          placeholder={TEXT_INTERFACE_DESCRIPTION_PLACEHOLDER}
          disabled={!draft}
          rows={3}
          onChange={(event) => {
            saveDescriptionTouchedRef.current = true;
            setSaveDescription(event.target.value);
          }}
        />
        <span className="query-interface-save-feedback" data-status={saveFeedback}>
          {saveFeedback === 'idle' ? TEXT_INTERFACE_SAVE_HINT : saveFeedbackLabel(saveFeedback)}
        </span>
      </section>

      <div
        key={panelMode}
        className="query-designer-tab-panel"
        role="tabpanel"
        data-mode={panelMode}
      >
        {panelMode === 'chain' ? (
          <>
            <section className="query-designer-section">
              <h3 className="designer-panel-section-title">{i18n.t('ui', 'queryRootModel')}</h3>
              <div className="query-designer-root-status">
                {rootModel ? modelLabel(rootModel) : i18n.t('ui', 'queryPickRootHint')}
              </div>
            </section>

            <section className="query-designer-section">
              <h3 className="designer-panel-section-title">{i18n.t('ui', 'queryPrimaryPath')}</h3>
              <QueryGraphPreview
                models={models}
                relationViews={relationViews}
                graphInstances={graphInstances}
                rootModelId={effectiveRootId}
                emptyLabel={i18n.t('ui', 'queryPickRootHint')}
                inheritedLabel={(name) => i18n.t('ui', 'queryInheritedFrom', { name })}
                onRemoveNode={(nodeId) =>
                  props.onQueryChainChange(
                    removeQueryChainNodeInstance(props.queryChain, nodeId, relations),
                  )
                }
                onRemoveEdge={(edge) =>
                  props.onQueryChainChange(
                    removeQueryChainRelation(props.queryChain, edge, relations),
                  )
                }
              />
              {props.pendingQueryRelationPick ? (
                <QueryRelationSourcePicker
                  relationId={props.pendingQueryRelationPick.relationId}
                  candidates={props.pendingQueryRelationPick.candidates}
                  graphInstances={graphInstances}
                  models={models}
                  relations={relations}
                  onSelect={(sourceNodeId) => props.onResolveQueryRelationPick([sourceNodeId])}
                  onSelectAll={() =>
                    props.onResolveQueryRelationPick(
                      props.pendingQueryRelationPick?.candidates.map(
                        (candidate) => candidate.sourceNodeId,
                      ) ?? [],
                    )
                  }
                  onCancel={props.onCancelQueryRelationPick}
                />
              ) : null}
              {props.pendingQueryModelPick ? (
                <QueryModelSourcePicker
                  modelId={props.pendingQueryModelPick.modelId}
                  candidates={props.pendingQueryModelPick.candidates}
                  graphInstances={graphInstances}
                  models={models}
                  relations={relations}
                  onSelect={(candidate) => props.onResolveQueryModelPick([candidate])}
                  onSelectAll={() =>
                    props.onResolveQueryModelPick(props.pendingQueryModelPick?.candidates ?? [])
                  }
                  onCancel={props.onCancelQueryModelPick}
                />
              ) : null}
              <div className="query-designer-path">
                {rootModel ? (
                  <QueryPathNode model={rootModel} />
                ) : (
                  <span className="query-designer-empty">{i18n.t('ui', 'queryPickRootHint')}</span>
                )}
                {primaryRelations.map(({ edge, relation }) => {
                  const targetModelId =
                    edge.direction === 'forward'
                      ? relation.target_model_id
                      : relation.source_model_id;
                  const target = models.find((model) => model.id === targetModelId);
                  return (
                    <div key={relation.id} className="query-designer-path-step">
                      <span className="query-designer-path-edge">
                        {relationLabel(relation)}
                        {edge.usage?.kind === 'inherited'
                          ? ` 璺?${i18n.t('ui', 'queryInheritedFrom', {
                              name: modelNameById(edge.usage.ownerModelId, models),
                            })}`
                          : ''}
                      </span>
                      {target ? <QueryPathNode model={target} /> : null}
                    </div>
                  );
                })}
              </div>
              <div className="query-designer-actions">
                <span className="query-designer-hint">
                  {availableRelations.length > 0
                    ? i18n.t('ui', 'queryCanvasContinueHint')
                    : i18n.t('ui', 'queryCanvasNoNextHint')}
                </span>
                <button
                  type="button"
                  className="query-designer-button"
                  disabled={modelPathIds.length === 0}
                  onClick={resetChain}
                >
                  {i18n.t('ui', 'queryResetChain')}
                </button>
                <button
                  type="button"
                  className="query-designer-button"
                  disabled={props.queryChain.primaryRelationIds.length === 0}
                  onClick={reversePrimaryPath}
                >
                  {'\u53cd\u5411\u94fe\u8def'}
                </button>
              </div>
            </section>

            <section className="query-designer-section">
              <h3 className="designer-panel-section-title">{'\u67e5\u8be2\u5173\u7cfb'}</h3>
              <div className="query-designer-edge-editor-list">
                {relationViews.length > 0 ? (
                  relationViews.map(({ edge, relation }) => (
                    <QueryEdgeEditor
                      key={`${edge.role}-${queryChainEdgeKey(edge)}`}
                      edge={edge}
                      relation={relation}
                      models={models}
                    />
                  ))
                ) : (
                  <span className="query-designer-empty">{i18n.t('ui', 'queryPickRootHint')}</span>
                )}
              </div>
            </section>

            <section className="query-designer-section">
              <h3 className="designer-panel-section-title">{i18n.t('ui', 'queryBranches')}</h3>
              <div className="query-designer-field-list">
                {branchRelations.length > 0 ? (
                  branchRelations.map(({ edge, relation }) => (
                    <span key={relation.id} className="query-designer-field-chip">
                      {relationEndpointLabel(relation, edge.direction, models, edge.usage, (name) =>
                        i18n.t('ui', 'queryInheritedFrom', { name }),
                      )}
                    </span>
                  ))
                ) : (
                  <span className="query-designer-empty">{i18n.t('ui', 'queryNoBranches')}</span>
                )}
              </div>
            </section>

            <section className="query-designer-section">
              <h3 className="designer-panel-section-title">{i18n.t('ui', 'queryConstraints')}</h3>
              <div className="query-designer-field-list">
                {constraintRelations.length > 0 ? (
                  constraintRelations.map(({ edge, relation }) => (
                    <span key={relation.id} className="query-designer-field-chip">
                      {relationEndpointLabel(relation, edge.direction, models, edge.usage, (name) =>
                        i18n.t('ui', 'queryInheritedFrom', { name }),
                      )}
                    </span>
                  ))
                ) : (
                  <span className="query-designer-empty">{i18n.t('ui', 'queryNoConstraints')}</span>
                )}
              </div>
            </section>
            {modelPathIds.length > 0 ? (
              <QueryPaginationEditor
                pagination={pagination}
                onChange={setPagination}
                hint={i18n.t('ui', 'queryPaginationBasicHint')}
                enableLabel={i18n.t('ui', 'queryPaginationEnable')}
              />
            ) : null}
          </>
        ) : null}

        {panelMode === 'fields' ? (
          <section className="query-designer-section">
            <h3 className="designer-panel-section-title">{i18n.t('ui', 'queryProjection')}</h3>
            <ProjectionFieldTree
              candidates={projectionCandidates}
              selectedFieldKeys={projectionFieldKeys ?? defaultProjectionFieldKeys}
              onSelectedFieldKeysChange={(nextKeys) => setProjectionFieldKeys(nextKeys)}
              emptyLabel={i18n.t('ui', 'queryNoProjection')}
            />
          </section>
        ) : null}

        {panelMode === 'filters' ? (
          <QueryConditionEditor
            fields={conditionFieldCandidates}
            aggregationFields={aggregationFieldCandidates}
            relationCandidates={relationConditionCandidates}
            parameters={parameters}
            filterTree={filterTree}
            aggregation={aggregation}
            sorts={sorts}
            onParametersChange={setParameters}
            onFilterTreeChange={setFilterTree}
            onAggregationChange={setAggregation}
            onSortsChange={setSorts}
          />
        ) : null}

        {panelMode === 'preview' ? (
          <QueryExecutionPreview queryInterface={draft} models={models} relations={relations} />
        ) : null}

        {panelMode === 'contract' ? (
          <>
            <section className="query-designer-section">
              <h3 className="designer-panel-section-title">
                {i18n.t('ui', 'queryInterfaceDraft')}
              </h3>
              <dl className="query-designer-summary">
                <div>
                  <dt>{i18n.t('ui', 'queryInterfaceName')}</dt>
                  <dd>{draft?.name ?? '-'}</dd>
                </div>
                <div>
                  <dt>{i18n.t('ui', 'queryNodeCount')}</dt>
                  <dd>{draft?.designGraph.nodes.length ?? 0}</dd>
                </div>
                <div>
                  <dt>{i18n.t('ui', 'queryRelationCount')}</dt>
                  <dd>{draft?.designGraph.edges.length ?? 0}</dd>
                </div>
                <div>
                  <dt>{i18n.t('ui', 'queryValidation')}</dt>
                  <dd>
                    {validation?.ok
                      ? i18n.t('ui', 'queryValidationOk')
                      : i18n.t('ui', 'queryValidationIssues')}
                  </dd>
                </div>
              </dl>
              {validation && validation.issues.length > 0 ? (
                <ul className="query-designer-issues">
                  {validation.issues.map((issue) => (
                    <li key={`${issue.code}-${issue.path ?? ''}`} data-severity={issue.severity}>
                      {interfaceDiagnosticMessage(i18n, issue)}
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
            <section className="query-designer-section">
              <h3 className="designer-panel-section-title">{TEXT_ACCESS_POLICY}</h3>
              <div className="query-designer-segment query-interface-access-modes" role="group">
                {(['none', 'key', 'disabled'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    data-active={permissions.mode === mode ? 'true' : 'false'}
                    onClick={() => {
                      setPermissions(
                        mode === 'key'
                          ? {
                              mode,
                              accessKeyDigest: permissions.accessKeyDigest,
                              rateLimit: permissions.rateLimit,
                            }
                          : { mode, rateLimit: permissions.rateLimit },
                      );
                      if (mode !== 'key') {
                        setAccessKeyInput('');
                      }
                    }}
                  >
                    {accessPolicyLabel(mode)}
                  </button>
                ))}
              </div>
              {permissions.mode === 'key' ? (
                <label className="query-preview-parameter query-interface-access-key">
                  <span>{TEXT_ACCESS_KEY}</span>
                  <input
                    type="password"
                    minLength={12}
                    autoComplete="new-password"
                    value={accessKeyInput}
                    placeholder={
                      permissions.accessKeyDigest
                        ? TEXT_ACCESS_KEY_CONFIGURED
                        : TEXT_ACCESS_KEY_PLACEHOLDER
                    }
                    onChange={(event) => {
                      const value = event.target.value;
                      setAccessKeyInput(value);
                      setPermissions({
                        mode: 'key',
                        accessKeyDigest:
                          value.length >= 12 ? queryInterfaceAccessKeyDigest(value) : undefined,
                      });
                    }}
                  />
                </label>
              ) : null}
              <label className="query-interface-rate-limit-toggle">
                <input
                  type="checkbox"
                  checked={Boolean(permissions.rateLimit)}
                  onChange={(event) =>
                    setPermissions({
                      ...permissions,
                      rateLimit: event.target.checked
                        ? { maxRequests: 100, windowSeconds: 60 }
                        : undefined,
                    })
                  }
                />
                <span>{TEXT_ENABLE_RATE_LIMIT}</span>
              </label>
              {permissions.rateLimit ? (
                <div className="query-interface-rate-limit-fields">
                  <label className="query-preview-parameter">
                    <span>{TEXT_RATE_LIMIT_REQUESTS}</span>
                    <input
                      type="number"
                      min={1}
                      max={1_000_000}
                      step={1}
                      value={permissions.rateLimit.maxRequests}
                      onChange={(event) =>
                        setPermissions({
                          ...permissions,
                          rateLimit: {
                            ...permissions.rateLimit!,
                            maxRequests: Number(event.target.value),
                          },
                        })
                      }
                    />
                  </label>
                  <label className="query-preview-parameter">
                    <span>{TEXT_RATE_LIMIT_WINDOW}</span>
                    <input
                      type="number"
                      min={1}
                      max={86_400}
                      step={1}
                      value={permissions.rateLimit.windowSeconds}
                      onChange={(event) =>
                        setPermissions({
                          ...permissions,
                          rateLimit: {
                            ...permissions.rateLimit!,
                            windowSeconds: Number(event.target.value),
                          },
                        })
                      }
                    />
                  </label>
                </div>
              ) : null}
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}

function QueryExecutionPreview(props: {
  queryInterface: QueryInterface | null;
  models: readonly EngineModelNode[];
  relations: readonly EngineRelationEdge[];
}): ReactElement {
  const { config, i18n } = useDesigner();
  const [parameterValues, setParameterValues] = useState<Record<string, string>>({});
  const [previewLimit, setPreviewLimit] = useState(20);
  const [status, setStatus] = useState<'idle' | 'running' | 'success' | 'error'>('idle');
  const [result, setResult] = useState<QueryPreviewResult | undefined>(undefined);
  const [executionError, setExecutionError] = useState('');
  const [resultMode, setResultMode] = useState<'table' | 'json'>('table');
  const executionRunRef = useRef(0);

  const plan = useMemo(
    () =>
      props.queryInterface
        ? compileQueryExecutionPlan({
            queryInterface: props.queryInterface,
            models: props.models,
            relations: props.relations,
            parameterValues,
            previewLimit,
          })
        : undefined,
    [parameterValues, previewLimit, props.models, props.queryInterface, props.relations],
  );
  const planSignature = JSON.stringify(plan?.snapshot ?? null);

  useEffect(() => {
    executionRunRef.current += 1;
    setStatus('idle');
    setResult(undefined);
    setExecutionError('');
  }, [planSignature]);

  useEffect(() => {
    const validIds = new Set(
      props.queryInterface?.contract.parameters.map((parameter) => parameter.id) ?? [],
    );
    setParameterValues((current) =>
      Object.fromEntries(Object.entries(current).filter(([id]) => validIds.has(id))),
    );
  }, [props.queryInterface]);

  if (!props.queryInterface || !plan) {
    return (
      <section className="query-designer-section">
        <h3 className="designer-panel-section-title">{TEXT_EXECUTION_PREVIEW}</h3>
        <span className="query-designer-empty">{TEXT_EXECUTION_EMPTY}</span>
      </section>
    );
  }

  const execute = async (cursor?: string): Promise<void> => {
    const library = config.activeLibraryName;
    if (!library || !plan.ready) {
      return;
    }
    const runId = executionRunRef.current + 1;
    executionRunRef.current = runId;
    setStatus('running');
    setResult(undefined);
    setExecutionError('');
    try {
      const nextResult = await withBusinessLibrarySession(library, (client) =>
        executeQueryExecutionPlan(client, plan, cursor),
      );
      if (executionRunRef.current !== runId) {
        return;
      }
      setResult(nextResult);
      setStatus('success');
    } catch (error) {
      if (executionRunRef.current !== runId) {
        return;
      }
      setExecutionError(executionPreviewErrorMessage(error));
      setStatus('error');
    }
  };

  return (
    <div className="query-execution-preview">
      <section className="query-designer-section query-execution-header">
        <div className="query-designer-section-heading">
          <div>
            <h3 className="designer-panel-section-title">{TEXT_EXECUTION_PREVIEW}</h3>
            <span className="query-execution-library">
              {config.activeLibraryName
                ? `${TEXT_EXECUTION_LIBRARY}: ${config.activeLibraryName}`
                : TEXT_EXECUTION_LIBRARY_MISSING}
            </span>
          </div>
          <button
            type="button"
            className="query-designer-button query-execution-run"
            disabled={!plan.ready || !config.activeLibraryName || status === 'running'}
            onClick={() => void execute()}
          >
            {TEXT_EXECUTE_QUERY}
          </button>
        </div>
      </section>

      <section className="query-designer-section">
        <div className="query-designer-section-heading">
          <h3 className="designer-panel-section-title">{TEXT_PREVIEW_PARAMETERS}</h3>
          <label className="query-preview-limit">
            <span>{TEXT_PREVIEW_LIMIT}</span>
            <input
              type="number"
              min={1}
              max={500}
              value={previewLimit}
              onChange={(event) =>
                setPreviewLimit(Math.min(500, Math.max(1, Number(event.target.value) || 1)))
              }
            />
          </label>
        </div>
        {props.queryInterface.contract.parameters.length > 0 ? (
          <div className="query-preview-parameters">
            {props.queryInterface.contract.parameters.map((parameter) => (
              <label key={parameter.id} className="query-preview-parameter">
                <span className="query-preview-parameter-label">
                  <strong>{parameter.label || parameter.name}</strong>
                  <code>{parameter.name}</code>
                  {parameter.required ? <em>{TEXT_PARAMETER_REQUIRED}</em> : null}
                </span>
                {parameter.type === 'boolean' ? (
                  <select
                    value={previewParameterValue(parameter, parameterValues)}
                    onChange={(event) =>
                      setParameterValues((current) => ({
                        ...current,
                        [parameter.id]: event.target.value,
                      }))
                    }
                  >
                    <option value="">-</option>
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                ) : (
                  <input
                    type={previewParameterInputType(parameter.type)}
                    value={previewParameterValue(parameter, parameterValues)}
                    placeholder={parameter.description || parameter.name}
                    onChange={(event) =>
                      setParameterValues((current) => ({
                        ...current,
                        [parameter.id]: event.target.value,
                      }))
                    }
                  />
                )}
                {parameter.description ? <small>{parameter.description}</small> : null}
              </label>
            ))}
          </div>
        ) : (
          <span className="query-designer-empty">{TEXT_NO_PREVIEW_PARAMETERS}</span>
        )}
      </section>

      <section className="query-designer-section">
        <h3 className="designer-panel-section-title">{TEXT_EXECUTION_PLAN}</h3>
        <div className="query-execution-stages">
          {plan.stages.map((stage, index) => (
            <ExecutionStage key={stage.id} stage={stage} index={index + 1} />
          ))}
        </div>
      </section>

      {plan.diagnostics.length > 0 ? (
        <section className="query-designer-section">
          <h3 className="designer-panel-section-title">{TEXT_EXECUTION_DIAGNOSTICS}</h3>
          <ul className="query-execution-diagnostics">
            {plan.diagnostics.map((diagnostic) => (
              <li
                key={`${diagnostic.code}:${diagnostic.path ?? ''}`}
                data-severity={diagnostic.severity}
              >
                <strong>
                  {diagnostic.severity === 'error' ? TEXT_BLOCKING_ISSUE : TEXT_EXECUTION_WARNING}
                </strong>
                <span>{executionDiagnosticMessage(i18n, diagnostic)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <details className="query-execution-request">
        <summary>{TEXT_WIRE_REQUEST}</summary>
        <pre>{JSON.stringify(plan.snapshot ?? { blocked: true }, null, 2)}</pre>
      </details>

      <section className="query-designer-section query-execution-result-section">
        <div className="query-designer-section-heading">
          <div>
            <h3 className="designer-panel-section-title">{TEXT_EXECUTION_RESULT}</h3>
            <span className="query-execution-result-meta" aria-live="polite">
              {executionStatusLabel(status, result)}
            </span>
          </div>
          <div className="query-result-actions">
            {props.queryInterface.query.pagination?.mode === 'cursor' && result?.nextCursor ? (
              <button
                type="button"
                className="query-designer-button query-execution-next"
                disabled={status === 'running'}
                onClick={() => void execute(result.nextCursor)}
              >
                {TEXT_NEXT_PAGE}
              </button>
            ) : null}
            <div className="query-result-mode" role="group" aria-label={TEXT_RESULT_VIEW}>
              {(['table', 'json'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  data-active={resultMode === mode ? 'true' : 'false'}
                  onClick={() => setResultMode(mode)}
                >
                  {mode === 'table' ? TEXT_TABLE_VIEW : 'JSON'}
                </button>
              ))}
            </div>
          </div>
        </div>
        {executionError ? <div className="query-execution-error">{executionError}</div> : null}
        {result ? (
          resultMode === 'table' ? (
            <QueryPreviewTable rows={result.rows} />
          ) : (
            <pre className="query-execution-result-json">
              {JSON.stringify(result.rows, null, 2)}
            </pre>
          )
        ) : (
          <div className="query-execution-result-empty">
            {status === 'running' ? TEXT_EXECUTION_RUNNING : TEXT_EXECUTION_RESULT_EMPTY}
          </div>
        )}
      </section>
    </div>
  );
}

function ExecutionStage(props: { stage: QueryExecutionStage; index: number }): ReactElement {
  return (
    <div className="query-execution-stage" data-status={props.stage.status}>
      <span className="query-execution-stage-index">{props.index}</span>
      <span className="query-execution-stage-copy">
        <strong>{executionStageLabel(props.stage.id)}</strong>
        <small>{executionStageSummary(props.stage)}</small>
      </span>
      <span className="query-execution-stage-status">
        {props.stage.status === 'ready'
          ? TEXT_STAGE_READY
          : props.stage.status === 'blocked'
            ? TEXT_STAGE_BLOCKED
            : TEXT_STAGE_INACTIVE}
      </span>
    </div>
  );
}

function QueryPreviewTable(props: { rows: readonly Record<string, unknown>[] }): ReactElement {
  const columns = Array.from(new Set(props.rows.flatMap((row) => Object.keys(row))));
  if (props.rows.length === 0) {
    return <div className="query-execution-result-empty">{TEXT_EXECUTION_NO_ROWS}</div>;
  }
  return (
    <div className="query-preview-table-wrap">
      <table className="query-preview-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {columns.map((column) => (
                <td key={column} title={previewCellValue(row[column])}>
                  {previewCellValue(row[column])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function QueryInterfaceManagerPanel(props: {
  savedQueryInterfaces: readonly SavedQueryInterfaceView[];
  expandedInterfaceId?: string;
  onOpenQueryInterface: (id: string) => void;
  onOpenPivot: (id: string) => void;
  onRenameQueryInterface: (id: string, name: string) => void;
  onPublishQueryInterface: (id: string) => void;
  onRollbackQueryInterface: (id: string, version: string) => void;
  onDeprecateQueryInterface: (id: string) => void;
  onDeleteQueryInterface: (id: string) => void;
}): ReactElement {
  const { data, i18n, config, notifications } = useDesigner();
  const [auditSummaries, setAuditSummaries] = useState<
    ReadonlyMap<string, QueryInterfaceAuditSummary>
  >(new Map());
  const [refreshingAudit, setRefreshingAudit] = useState(false);
  const refreshAudit = async (): Promise<void> => {
    if (!config.remoteClient || !config.activeLibraryName || refreshingAudit) {
      return;
    }
    setRefreshingAudit(true);
    try {
      setAuditSummaries(
        await listQueryInterfaceAuditSummaries(config.remoteClient, config.activeLibraryName),
      );
    } catch (cause) {
      notifications.error(TEXT_REFRESH_STATISTICS_FAILED, {
        message: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setRefreshingAudit(false);
    }
  };

  return (
    <div className="query-interface-manager-panel">
      <section className="query-designer-section">
        <div className="query-designer-section-heading">
          <h3 className="designer-panel-section-title">{TEXT_INTERFACE_MANAGER}</h3>
          <button
            type="button"
            className="query-designer-button"
            disabled={refreshingAudit}
            onClick={() => void refreshAudit()}
          >
            {TEXT_REFRESH_STATISTICS}
          </button>
        </div>
        <div className="query-interface-list">
          {props.savedQueryInterfaces.length > 0 ? (
            props.savedQueryInterfaces.map((item) => (
              <QueryInterfaceDocCard
                key={item.id}
                defaultExpanded={item.id === props.expandedInterfaceId}
                item={{
                  ...item,
                  auditSummary:
                    auditSummaries.get(interfaceCallableName(item)) ?? item.auditSummary,
                }}
                models={data.models}
                relations={data.relations}
                locale={i18n.locale}
                libraryCode={config.activeLibraryName ?? ''}
                pivotLabel={i18n.t('ui', 'pivotOpenViewer')}
                httpEndpointLabel={i18n.t('ui', 'queryInterfaceHttpEndpoint')}
                httpExampleLabel={i18n.t('ui', 'queryInterfaceHttpExample')}
                onRefreshAudit={refreshAudit}
                onOpen={() => props.onOpenQueryInterface(item.id)}
                onOpenPivot={() => props.onOpenPivot(item.id)}
                onRename={(name) => props.onRenameQueryInterface(item.id, name)}
                onPublish={() => props.onPublishQueryInterface(item.id)}
                onRollback={(version) => props.onRollbackQueryInterface(item.id, version)}
                onDeprecate={() => props.onDeprecateQueryInterface(item.id)}
                onDelete={() => props.onDeleteQueryInterface(item.id)}
              />
            ))
          ) : (
            <span className="query-designer-empty">{TEXT_NO_SAVED_INTERFACES}</span>
          )}
        </div>
      </section>
    </div>
  );
}

function QueryInterfaceDocCard(props: {
  item: SavedQueryInterfaceView;
  defaultExpanded?: boolean;
  models: readonly EngineModelNode[];
  relations: readonly EngineRelationEdge[];
  locale: string;
  libraryCode: string;
  pivotLabel: string;
  httpEndpointLabel: string;
  httpExampleLabel: string;
  onRefreshAudit: () => Promise<void>;
  onOpen: () => void;
  onOpenPivot: () => void;
  onRename: (name: string) => void;
  onPublish: () => void;
  onRollback: (version: string) => void;
  onDeprecate: () => void;
  onDelete: () => void;
}): ReactElement {
  const [expanded, setExpanded] = useState(props.defaultExpanded ?? false);
  const { i18n } = useDesigner();
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(props.item.name);
  const [testing, setTesting] = useState(false);
  const confirm = useAppConfirm();
  const queryInterface = props.item.queryInterface;
  const rootNode = queryInterface.designGraph.nodes.find(
    (node) => node.id === queryInterface.designGraph.rootNodeId,
  );
  const rootName = rootNode ? modelNameById(rootNode.modelId, props.models) : TEXT_UNKNOWN_ROOT;
  const publishedRelease = props.item.publishedRelease;
  const releaseHistory = props.item.releaseHistory ?? [];
  const releaseImpact = useMemo(
    () =>
      publishedRelease
        ? assessQueryInterfaceReleaseImpact(queryInterface, publishedRelease)
        : undefined,
    [publishedRelease, queryInterface],
  );
  const hasDraftChanges =
    publishedRelease !== undefined &&
    queryInterfacePublicationSignature(queryInterface) !== publishedRelease.signature;
  const invocation =
    publishedRelease?.queryInterface.contract.invocation.endpoint ||
    publishedRelease?.callableName ||
    queryInterface.contract.invocation.endpoint ||
    queryInterface.contract.invocation.callableName ||
    queryInterface.name;
  const connection = resolveBusinessConnectionParams();
  const callDocs =
    publishedRelease?.queryInterface.status === 'active'
      ? buildInterfaceCallDocs({
          release: publishedRelease,
          libraryCode: props.libraryCode,
          baseUrl: connection.publicBaseUrl || connectionOrigin(connection),
          authMode:
            connection.browserSession || connection.token.startsWith('mdbt_v1_')
              ? 'registry'
              : 'legacy',
        })
      : undefined;
  const downloadPostman = (): void => {
    if (!callDocs) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(callDocs.postman, null, 2)], { type: 'application/json' }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${publishedRelease!.callableName.replace(/[^a-zA-Z0-9_-]/g, '_')}.postman_collection.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const primaryPath = queryInterface.query.traversal.primaryPath
    .map((nodeId) => queryInterface.designGraph.nodes.find((node) => node.id === nodeId))
    .filter((node): node is NonNullable<typeof node> => Boolean(node));
  const pathLabel = primaryPath
    .map((node) => modelNameById(node.modelId, props.models))
    .join(' -> ');
  const branchCount = queryInterface.query.traversal.branches.length;
  const filterRoot = queryInterface.query.filterTree;
  const filterCount = filterRoot
    ? queryFilterExpressionCount(filterRoot)
    : queryInterface.query.filters.filter((filter) => filter.enabled).length;
  const filterGroupCount = filterRoot ? Math.max(0, queryFilterGroupCount(filterRoot) - 1) : 0;
  const relationFilterCount = filterRoot ? queryRelationFilterCount(filterRoot) : 0;
  const filterLogicLabel = filterRoot?.combinator.toUpperCase() ?? (filterCount > 0 ? 'AND' : '-');
  const sortCount = queryInterface.query.sorts.length;
  const paginationLabel = paginationModeLabel(queryInterface.query.pagination?.mode ?? 'none');
  const projectionFields = queryInterface.query.projection.fields.filter((field) => field.visible);
  const outputNodeIds = queryResultOutputNodeIds(queryInterface);
  const outputProjectionFields = projectionFields.filter((field) =>
    outputNodeIds.has(field.source.nodeId),
  );
  const aggregationSpec = queryInterface.query.aggregation;
  const outputFieldCount = aggregationSpec
    ? queryInterface.query.result.schema.length
    : outputProjectionFields.length;
  const writableMode = queryInterface.query.binding?.writeMode ?? 'readonly';
  const relationLabels = queryInterface.designGraph.edges.slice(0, 4).map((edge) => {
    const relation = props.relations.find((item) => item.id === edge.relationId);
    return relation ? relationLabel(relation, edge.traversal) : edge.alias;
  });
  const description = queryInterface.description?.trim() || TEXT_NO_DESCRIPTION;

  useEffect(() => {
    setRenameValue(props.item.name);
  }, [props.item.name]);

  const submitRename = (): void => {
    const nextName = renameValue.trim();
    if (!nextName || nextName === props.item.name) {
      setRenameValue(props.item.name);
      setRenaming(false);
      return;
    }
    props.onRename(nextName);
    setRenaming(false);
  };

  return (
    <article className="query-interface-doc-card" data-expanded={expanded ? 'true' : 'false'}>
      <button
        type="button"
        className="query-interface-doc-summary"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="query-interface-doc-title-block">
          <DesignerTooltip content={props.item.name}>
            {(triggerProps) => (
              <span {...triggerProps} className="query-interface-doc-title">
                {props.item.name}
              </span>
            )}
          </DesignerTooltip>
          <span className="query-interface-doc-description">{description}</span>
        </span>
        <span className="query-interface-doc-expand-indicator" aria-hidden>
          {expanded ? '\u2212' : '+'}
        </span>
      </button>

      {expanded ? (
        <div className="query-interface-doc-details">
          <div className="query-interface-doc-actions">
            <button type="button" onClick={props.onOpen}>
              {TEXT_OPEN_INTERFACE}
            </button>
            {publishedRelease?.queryInterface.status === 'active' ? (
              <button type="button" data-action="pivot" onClick={props.onOpenPivot}>
                {props.pivotLabel}
              </button>
            ) : null}
            <button type="button" onClick={() => setRenaming((value) => !value)}>
              {TEXT_RENAME_INTERFACE}
            </button>
            {queryInterface.status === 'draft' ||
            publishedRelease?.queryInterface.status === 'deprecated' ? (
              <button type="button" data-action="publish" onClick={props.onPublish}>
                {publishedRelease ? TEXT_REPUBLISH_INTERFACE : TEXT_PUBLISH_INTERFACE}
              </button>
            ) : null}
            {publishedRelease?.queryInterface.status === 'active' ? (
              <button type="button" onClick={props.onDeprecate}>
                {TEXT_DEPRECATE_INTERFACE}
              </button>
            ) : null}
            <button type="button" onClick={props.onDelete}>
              {TEXT_DELETE_INTERFACE}
            </button>
          </div>

          {renaming ? (
            <div className="query-interface-rename-row">
              <input
                type="text"
                value={renameValue}
                aria-label={TEXT_RENAME_INTERFACE}
                onChange={(event) => setRenameValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    submitRename();
                  }
                  if (event.key === 'Escape') {
                    setRenameValue(props.item.name);
                    setRenaming(false);
                  }
                }}
              />
              <button type="button" onClick={submitRename}>
                {TEXT_CONFIRM_RENAME}
              </button>
              <button
                type="button"
                onClick={() => {
                  setRenameValue(props.item.name);
                  setRenaming(false);
                }}
              >
                {TEXT_CANCEL_RENAME}
              </button>
            </div>
          ) : null}

          <div className="query-interface-doc-subtitle">
            {TEXT_ROOT_MODEL}
            {': '}
            {rootName}
          </div>

          <div className="query-interface-doc-badges">
            <span data-status={queryInterface.status}>
              {interfaceStatusLabel(queryInterface.status)}
            </span>
            <span>{`v${queryInterface.version.current}`}</span>
            {publishedRelease ? (
              <span data-status={publishedRelease.queryInterface.status}>
                {`${TEXT_RELEASE_VERSION} v${publishedRelease.version}`}
              </span>
            ) : null}
            {releaseHistory.length > 0 ? (
              <DesignerTooltip
                content={releaseHistory.map((release) => `v${release.version}`).join(', ')}
              >
                {(triggerProps) => (
                  <span {...triggerProps}>
                    {`${TEXT_RELEASE_HISTORY} ${releaseHistory.length}`}
                  </span>
                )}
              </DesignerTooltip>
            ) : null}
            <span>{queryInterface.contract.invocation.method}</span>
            <span>{accessPolicyLabel(queryInterface.contract.permissions?.mode ?? 'none')}</span>
            {queryInterface.contract.permissions?.rateLimit ? (
              <span>{`${TEXT_RATE_LIMIT} ${queryInterface.contract.permissions.rateLimit.maxRequests}/${queryInterface.contract.permissions.rateLimit.windowSeconds}s`}</span>
            ) : null}
            <span>{aggregationSpec ? TEXT_OUTPUT_AGGREGATE : TEXT_OUTPUT_TREE}</span>
            <span>{writeModeLabel(writableMode)}</span>
          </div>

          <div className="query-interface-doc-call">
            <span>{props.httpEndpointLabel || TEXT_CALL_ENTRY}</span>
            <code>{callDocs ? `POST ${callDocs.endpoint}` : invocation}</code>
          </div>
          {callDocs ? (
            <details className="query-execution-request query-interface-http-example">
              <summary>{props.httpExampleLabel}</summary>
              <div className="query-interface-call-tools">
                <span>
                  {i18n.t(
                    'ui',
                    callDocs.grant ? 'queryInterfaceBearerHint' : 'queryInterfaceLegacyHint',
                  )}
                </span>
                <span>{i18n.t('ui', 'queryInterfaceParameterExampleHint')}</span>
                <button type="button" className="query-designer-button" onClick={downloadPostman}>
                  {i18n.t('ui', 'queryInterfaceDownloadPostman')}
                </button>
              </div>
              <pre>{callDocs.curl}</pre>
              {callDocs.grant ? (
                <details>
                  <summary>{i18n.t('ui', 'queryInterfaceReleaseGrant')}</summary>
                  <div className="query-interface-call-tools">
                    {i18n.t('ui', 'queryInterfaceReleaseGrantHint')}
                  </div>
                  <pre>{JSON.stringify([callDocs.grant], null, 2)}</pre>
                </details>
              ) : null}
            </details>
          ) : null}

          {hasDraftChanges && releaseImpact ? (
            <QueryReleaseImpactSummary impact={releaseImpact} />
          ) : null}

          {publishedRelease ? (
            <QueryReleaseLedger
              current={publishedRelease}
              history={releaseHistory}
              onRollback={async (release) => {
                if (
                  await confirm({
                    title: `${TEXT_ROLLBACK_RELEASE} v${release.version}`,
                    message: TEXT_ROLLBACK_RELEASE_CONFIRM,
                    tone: 'danger',
                  })
                ) {
                  props.onRollback(release.version);
                }
              }}
            />
          ) : null}

          {publishedRelease?.queryInterface.status === 'active' ? (
            <div className="query-interface-doc-section">
              <button
                type="button"
                className="query-designer-button"
                data-active={testing ? 'true' : 'false'}
                onClick={() => setTesting((value) => !value)}
              >
                {TEXT_ONLINE_TEST}
              </button>
              {testing ? (
                <PublishedInterfaceTester
                  libraryCode={props.libraryCode}
                  release={publishedRelease}
                  history={releaseHistory}
                  onExecuted={props.onRefreshAudit}
                />
              ) : null}
            </div>
          ) : null}

          <div className="query-interface-doc-section">
            <span className="query-interface-doc-section-title">{TEXT_PARAMETERS}</span>
            <div className="query-interface-doc-chip-row">
              {queryInterface.contract.parameters.length > 0 ? (
                queryInterface.contract.parameters.map((parameter) => (
                  <DesignerTooltip
                    key={parameter.id}
                    content={
                      [parameter.label, parameter.description]
                        .filter((value): value is string => Boolean(value))
                        .join(' | ') || parameter.name
                    }
                  >
                    {(triggerProps) => (
                      <span {...triggerProps} className="query-interface-doc-chip">
                        {`${parameter.name}: ${parameter.type}${parameter.required ? ' *' : ''}`}
                      </span>
                    )}
                  </DesignerTooltip>
                ))
              ) : (
                <span className="query-interface-doc-muted">{TEXT_EMPTY_VALUE}</span>
              )}
            </div>
          </div>

          <div className="query-interface-doc-stats">
            <InterfaceDocStat label={TEXT_MODELS} value={queryInterface.designGraph.nodes.length} />
            <InterfaceDocStat
              label={TEXT_RELATIONS}
              value={queryInterface.designGraph.edges.length}
            />
            <InterfaceDocStat label={TEXT_BRANCHES} value={branchCount} />
            <InterfaceDocStat label={TEXT_FILTERS} value={filterCount} />
            <InterfaceDocStat label={TEXT_SORTS} value={sortCount} />
            <InterfaceDocStat label={TEXT_FIELDS} value={outputFieldCount} />
          </div>

          {props.item.auditSummary ? (
            <div className="query-interface-doc-section">
              <span className="query-interface-doc-section-title">{TEXT_CALL_STATISTICS}</span>
              <div className="query-interface-doc-stats">
                <InterfaceDocStat label={TEXT_CALLS} value={props.item.auditSummary.callCount} />
                <InterfaceDocStat
                  label={TEXT_SUCCESSES}
                  value={props.item.auditSummary.successCount}
                />
                <InterfaceDocStat
                  label={TEXT_FAILURES}
                  value={props.item.auditSummary.errorCount}
                />
                <InterfaceDocStat
                  label={TEXT_AVERAGE_MS}
                  value={props.item.auditSummary.averageDurationMs}
                />
              </div>
              <InterfaceAuditTrend summary={props.item.auditSummary} />
              {props.item.auditSummary.lastErrorCode ? (
                <code className="query-interface-doc-path">
                  {props.item.auditSummary.lastErrorCode}
                </code>
              ) : null}
            </div>
          ) : null}

          <div className="query-interface-doc-section">
            <span className="query-interface-doc-section-title">{TEXT_QUERY_PATH}</span>
            <DesignerTooltip content={pathLabel || TEXT_EMPTY_VALUE}>
              {(triggerProps) => (
                <span {...triggerProps} className="query-interface-doc-path">
                  {pathLabel || TEXT_EMPTY_VALUE}
                </span>
              )}
            </DesignerTooltip>
          </div>

          <div className="query-interface-doc-section">
            <span className="query-interface-doc-section-title">{TEXT_RELATION_SUMMARY}</span>
            <div className="query-interface-doc-chip-row">
              {relationLabels.length > 0 ? (
                relationLabels.map((label, index) => (
                  <span key={`${label}-${index}`} className="query-interface-doc-chip">
                    {label}
                  </span>
                ))
              ) : (
                <span className="query-interface-doc-muted">{TEXT_EMPTY_VALUE}</span>
              )}
              {queryInterface.designGraph.edges.length > relationLabels.length ? (
                <span className="query-interface-doc-muted">
                  {`+${queryInterface.designGraph.edges.length - relationLabels.length}`}
                </span>
              ) : null}
            </div>
          </div>

          <div className="query-interface-doc-section">
            <span className="query-interface-doc-section-title">{TEXT_FILTER_LOGIC}</span>
            <div className="query-interface-doc-chip-row">
              <span className="query-interface-doc-chip">{filterLogicLabel}</span>
              <span className="query-interface-doc-chip">
                {`${TEXT_FILTER_GROUPS}: ${filterGroupCount}`}
              </span>
              <span className="query-interface-doc-chip">
                {`${TEXT_RELATION_FILTERS}: ${relationFilterCount}`}
              </span>
            </div>
          </div>

          <div className="query-interface-doc-section">
            <span className="query-interface-doc-section-title">{TEXT_PAGINATION}</span>
            <div className="query-interface-doc-chip-row">
              <span className="query-interface-doc-chip">{paginationLabel}</span>
              {queryInterface.query.pagination?.defaultLimit ? (
                <span className="query-interface-doc-chip">
                  {`${TEXT_PAGINATION_DEFAULT_LIMIT}: ${queryInterface.query.pagination.defaultLimit}`}
                </span>
              ) : null}
              {queryInterface.query.pagination?.maxLimit ? (
                <span className="query-interface-doc-chip">
                  {`${TEXT_PAGINATION_MAX_LIMIT}: ${queryInterface.query.pagination.maxLimit}`}
                </span>
              ) : null}
            </div>
          </div>

          {aggregationSpec ? (
            <div className="query-interface-doc-section">
              <span className="query-interface-doc-section-title">{TEXT_AGGREGATION}</span>
              <div className="query-interface-doc-chip-row">
                <span className="query-interface-doc-chip">
                  {`${TEXT_GROUP_BY}: ${aggregationSpec.groupBy.length}`}
                </span>
                <span className="query-interface-doc-chip">
                  {`${TEXT_METRICS}: ${aggregationSpec.metrics.length}`}
                </span>
                <span className="query-interface-doc-chip">
                  {`${TEXT_HAVING}: ${aggregationSpec.having ? queryFilterExpressionCount(aggregationSpec.having) : 0}`}
                </span>
              </div>
            </div>
          ) : null}

          <div className="query-interface-doc-section">
            <span className="query-interface-doc-section-title">{TEXT_OUTPUT_FIELDS}</span>
            {aggregationSpec ? (
              <QueryAggregationResultSchema fields={queryInterface.query.result.schema} />
            ) : (
              <QueryResultStructureTree
                queryInterface={queryInterface}
                models={props.models}
                relations={props.relations}
                locale={props.locale}
                emptyLabel={TEXT_EMPTY_VALUE}
              />
            )}
          </div>

          <div className="query-interface-doc-footer">
            <span>
              {TEXT_PARAMETERS}
              {': '}
              {queryInterface.contract.parameters.length}
            </span>
            <span>
              {TEXT_ERRORS}
              {': '}
              {queryInterface.contract.errors.length}
            </span>
            <span>
              {TEXT_UPDATED_AT}
              {': '}
              {formatInterfaceTime(props.item.updatedAt)}
            </span>
          </div>
        </div>
      ) : null}
    </article>
  );
}

function QueryReleaseImpactSummary(props: { impact: QueryInterfaceReleaseImpact }): ReactElement {
  return (
    <div className="query-interface-release-impact" data-level={props.impact.level}>
      <div className="query-interface-release-impact-heading">
        <span>{TEXT_RELEASE_IMPACT}</span>
        <strong>{`${releaseImpactLabel(props.impact.level)} | v${props.impact.recommendedVersion}`}</strong>
      </div>
      <div className="query-interface-release-change-list">
        {props.impact.changes.slice(0, 6).map((change, index) => (
          <span key={`${change.code}-${change.subject ?? ''}-${index}`}>
            {releaseChangeLabel(change)}
          </span>
        ))}
        {props.impact.changes.length > 6 ? (
          <span>{`+${props.impact.changes.length - 6}`}</span>
        ) : null}
      </div>
    </div>
  );
}

function QueryReleaseLedger(props: {
  current: QueryInterfaceRelease;
  history: readonly QueryInterfaceRelease[];
  onRollback: (release: QueryInterfaceRelease) => void;
}): ReactElement {
  const releases = [props.current, ...[...props.history].reverse()];
  return (
    <div className="query-interface-doc-section">
      <span className="query-interface-doc-section-title">{TEXT_RELEASE_LEDGER}</span>
      <div className="query-interface-release-ledger">
        {releases.map((release, index) => {
          const rollbackImpact =
            index === 0
              ? undefined
              : assessQueryInterfaceReleaseImpact(release.queryInterface, props.current);
          return (
            <div
              key={`${release.version}-${release.signature}`}
              className="query-interface-release-row"
              data-status={release.queryInterface.status}
            >
              <strong>{`v${release.version}`}</strong>
              <span data-role="release-kind">
                {index === 0 ? TEXT_CURRENT_RELEASE : TEXT_HISTORICAL_RELEASE}
              </span>
              <span>{interfaceStatusLabel(release.queryInterface.status)}</span>
              <span>
                {rollbackImpact
                  ? releaseImpactLabel(rollbackImpact.level)
                  : releaseCompatibilityLabel(release.queryInterface.version.compatibility)}
              </span>
              <span>{`${release.queryInterface.contract.parameters.length} ${TEXT_PARAMETERS}`}</span>
              <time dateTime={release.publishedAt}>{formatInterfaceTime(release.publishedAt)}</time>
              {rollbackImpact && release.signature !== props.current.signature ? (
                <button
                  type="button"
                  className="query-interface-release-rollback"
                  onClick={() => props.onRollback(release)}
                >
                  {TEXT_ROLLBACK_RELEASE}
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function releaseImpactLabel(level: QueryInterfaceReleaseImpact['level']): string {
  if (level === 'major') {
    return TEXT_RELEASE_BREAKING;
  }
  if (level === 'minor') {
    return TEXT_RELEASE_ADDITIVE;
  }
  return TEXT_RELEASE_PATCH;
}

function releaseCompatibilityLabel(
  compatibility: QueryInterface['version']['compatibility'],
): string {
  if (compatibility === 'breaking') {
    return TEXT_RELEASE_BREAKING;
  }
  if (compatibility === 'draft') {
    return interfaceStatusLabel('draft');
  }
  return TEXT_RELEASE_COMPATIBLE;
}

function releaseChangeLabel(change: QueryInterfaceReleaseChange): string {
  const subject = change.subject ? ` ${change.subject}` : '';
  const labels: Record<QueryInterfaceReleaseChange['code'], string> = {
    callable_name_changed: TEXT_CHANGE_CALLABLE,
    parameter_added_optional: `${TEXT_CHANGE_PARAMETER_ADDED}${subject}`,
    parameter_added_required: `${TEXT_CHANGE_REQUIRED_PARAMETER_ADDED}${subject}`,
    parameter_removed: `${TEXT_CHANGE_PARAMETER_REMOVED}${subject}`,
    parameter_type_changed: `${TEXT_CHANGE_PARAMETER_TYPE}${subject}`,
    parameter_required: `${TEXT_CHANGE_PARAMETER_REQUIRED}${subject}`,
    parameter_relaxed: `${TEXT_CHANGE_PARAMETER_RELAXED}${subject}`,
    parameter_default_changed: `${TEXT_CHANGE_PARAMETER_DEFAULT}${subject}`,
    result_shape_changed: TEXT_CHANGE_RESULT_SHAPE,
    result_field_added: `${TEXT_CHANGE_FIELD_ADDED}${subject}`,
    result_field_removed: `${TEXT_CHANGE_FIELD_REMOVED}${subject}`,
    result_field_type_changed: `${TEXT_CHANGE_FIELD_TYPE}${subject}`,
    result_field_became_nullable: `${TEXT_CHANGE_FIELD_NULLABLE}${subject}`,
    result_field_became_required: `${TEXT_CHANGE_FIELD_REQUIRED}${subject}`,
    record_refs_removed: TEXT_CHANGE_REFS_REMOVED,
    record_refs_added: TEXT_CHANGE_REFS_ADDED,
    pagination_mode_changed: TEXT_CHANGE_PAGINATION,
    access_policy_changed: TEXT_CHANGE_ACCESS,
    error_contract_changed: TEXT_CHANGE_ERRORS,
    query_behavior_changed: TEXT_CHANGE_QUERY,
    metadata_changed: TEXT_CHANGE_METADATA,
  };
  return labels[change.code];
}

function InterfaceDocStat(props: { label: string; value: number }): ReactElement {
  return (
    <span className="query-interface-doc-stat">
      <strong>{props.value}</strong>
      <span>{props.label}</span>
    </span>
  );
}

function InterfaceAuditTrend(props: { summary: QueryInterfaceAuditSummary }): ReactElement {
  const peak = Math.max(1, ...props.summary.trend.map((point) => point.callCount));
  return (
    <div className="query-interface-audit-observability">
      <div className="query-interface-audit-trend-heading">
        <span>{TEXT_CALL_TREND}</span>
        {props.summary.lastCalledAt ? (
          <span>{`${TEXT_LAST_CALL}: ${formatInterfaceTime(props.summary.lastCalledAt)}`}</span>
        ) : null}
      </div>
      <div className="query-interface-audit-trend" role="img" aria-label={TEXT_CALL_TREND}>
        {props.summary.trend.map((point) => {
          const height = point.callCount > 0 ? Math.max(8, (point.callCount / peak) * 100) : 0;
          const errorRatio = point.callCount > 0 ? (point.errorCount / point.callCount) * 100 : 0;
          return (
            <DesignerTooltip
              key={point.bucketStart}
              content={`${formatInterfaceTime(point.bucketStart)} | ${TEXT_CALLS} ${point.callCount} | ${TEXT_FAILURES} ${point.errorCount} | ${TEXT_AVERAGE_MS} ${point.averageDurationMs}`}
            >
              {(triggerProps) => (
                <span {...triggerProps} className="query-interface-audit-bar-slot">
                  <span className="query-interface-audit-bar" style={{ height: `${height}%` }}>
                    <span
                      className="query-interface-audit-bar-error"
                      style={{ height: `${errorRatio}%` }}
                    />
                  </span>
                </span>
              )}
            </DesignerTooltip>
          );
        })}
      </div>
      {props.summary.recentCalls.length > 0 ? (
        <div className="query-interface-audit-recent">
          <span className="query-interface-doc-section-title">{TEXT_RECENT_CALLS}</span>
          <div className="query-interface-audit-call-list">
            {props.summary.recentCalls.map((call, index) => (
              <div
                key={`${call.startedAt}-${index}`}
                className="query-interface-audit-call"
                data-status={call.status}
              >
                <span className="query-interface-audit-call-status">
                  {call.status === 'success' ? TEXT_CALL_SUCCESS : TEXT_CALL_FAILURE}
                </span>
                <span>{call.version ? `v${call.version}` : '-'}</span>
                <span>{`${call.durationMs} ms`}</span>
                <DesignerTooltip content={call.errorCode ?? `${TEXT_ROWS}: ${call.rowCount}`}>
                  {(triggerProps) => (
                    <span {...triggerProps} className="query-interface-audit-call-result">
                      {call.errorCode ?? `${TEXT_ROWS} ${call.rowCount}`}
                    </span>
                  )}
                </DesignerTooltip>
                <span>{formatInterfaceTime(call.startedAt)}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <span className="query-interface-doc-muted">{TEXT_NO_RECENT_CALLS}</span>
      )}
    </div>
  );
}

function interfaceCallableName(item: SavedQueryInterfaceView): string {
  return (
    item.publishedRelease?.callableName ??
    item.queryInterface.contract.invocation.callableName ??
    ''
  );
}

function PublishedInterfaceTester(props: {
  libraryCode: string;
  release: QueryInterfaceRelease;
  history: readonly QueryInterfaceRelease[];
  onExecuted: () => Promise<void>;
}): ReactElement {
  const { i18n } = useDesigner();
  const releases = [props.release, ...props.history].filter(
    (release) => release.queryInterface.status === 'active',
  );
  const [version, setVersion] = useState(props.release.version);
  const [parameterValues, setParameterValues] = useState<Record<string, string>>({});
  const [accessKey, setAccessKey] = useState('');
  const [status, setStatus] = useState<'idle' | 'running' | 'success' | 'error'>('idle');
  const [result, setResult] = useState<readonly Record<string, unknown>[] | undefined>();
  const [error, setError] = useState('');
  const selectedRelease =
    releases.find((candidate) => candidate.version === version) ?? props.release;
  const parameters = selectedRelease.queryInterface.contract.parameters;
  const permissionMode = selectedRelease.queryInterface.contract.permissions?.mode ?? 'none';
  const selectVersion = (nextVersion: string): void => {
    setVersion(nextVersion);
    setParameterValues({});
    setAccessKey('');
    setResult(undefined);
    setError('');
    setStatus('idle');
  };
  const invoke = async (): Promise<void> => {
    if (!props.libraryCode || status === 'running') {
      return;
    }
    setStatus('running');
    setError('');
    try {
      const parameterInput = Object.fromEntries(
        parameters
          .filter((parameter) => parameterValues[parameter.id] !== undefined)
          .map((parameter) => [
            parameter.name,
            interfaceTestParameterValue(parameter, parameterValues[parameter.id] ?? ''),
          ]),
      );
      const pagination = selectedRelease.queryInterface.query.pagination;
      const response = await withBusinessLibrarySession(props.libraryCode, (client) =>
        client.invokeQueryInterface(selectedRelease.callableName, {
          version: selectedRelease.version,
          parameters: parameterInput,
          ...(permissionMode === 'key' && accessKey ? { accessKey } : {}),
          ...(pagination?.mode === 'cursor' ? { cursor: null } : {}),
          ...(pagination?.mode === 'offset' ? { page: 0 } : {}),
          ...(pagination?.defaultLimit ? { limit: pagination.defaultLimit } : {}),
        }),
      );
      setResult(response.rows);
      setStatus('success');
    } catch (cause) {
      setResult(undefined);
      setError(
        cause instanceof QueryInterfaceInvocationError
          ? `${cause.code}${cause.details ? ` ${JSON.stringify(cause.details)}` : ''}`
          : connectionErrorMessage(cause, i18n),
      );
      setStatus('error');
    } finally {
      await props.onExecuted();
    }
  };
  const example = publishedInterfaceSdkExample(selectedRelease);

  return (
    <div className="query-interface-test-console">
      <label className="query-preview-parameter">
        <span>{TEXT_RELEASE_VERSION}</span>
        <select value={version} onChange={(event) => selectVersion(event.target.value)}>
          {releases.map((release) => (
            <option key={release.version} value={release.version}>{`v${release.version}`}</option>
          ))}
        </select>
      </label>
      {parameters.map((parameter) => (
        <label key={parameter.id} className="query-preview-parameter">
          <span>{`${parameter.label || parameter.name}${parameter.required ? ' *' : ''}`}</span>
          <input
            type={previewParameterInputType(parameter.type)}
            value={parameterValues[parameter.id] ?? ''}
            onChange={(event) =>
              setParameterValues((current) => ({
                ...current,
                [parameter.id]: event.target.value,
              }))
            }
          />
        </label>
      ))}
      {permissionMode === 'key' ? (
        <label className="query-preview-parameter">
          <span>{TEXT_ACCESS_KEY}</span>
          <input
            type="password"
            value={accessKey}
            autoComplete="off"
            onChange={(event) => setAccessKey(event.target.value)}
          />
        </label>
      ) : null}
      <button
        type="button"
        className="query-designer-button query-execution-run"
        disabled={status === 'running'}
        onClick={() => void invoke()}
      >
        {TEXT_EXECUTE_QUERY}
      </button>
      {error ? <div className="query-execution-error">{error}</div> : null}
      {result ? (
        <pre className="query-execution-result-json">{JSON.stringify(result, null, 2)}</pre>
      ) : null}
      <details className="query-execution-request">
        <summary>{TEXT_SDK_EXAMPLE}</summary>
        <pre>{example}</pre>
      </details>
    </div>
  );
}

function interfaceTestParameterValue(parameter: InterfaceParameter, value: string): unknown {
  if (parameter.type === 'number') {
    return value === '' ? undefined : Number(value);
  }
  if (parameter.type === 'boolean') {
    return value === 'true' ? true : value === 'false' ? false : undefined;
  }
  if (parameter.type === 'json') {
    return value === '' ? undefined : JSON.parse(value);
  }
  return value;
}

function publishedInterfaceSdkExample(release: QueryInterfaceRelease): string {
  return `const result = await client.invokeQueryInterface(${JSON.stringify(release.callableName)}, ${JSON.stringify(
    publishedInterfaceCallBody(release),
    null,
    2,
  )});`;
}

const TEXT_INHERITED_FROM = '\u7ee7\u627f\u81ea';
const TEXT_REWIRE_HINT =
  '\u8bf7\u5728\u753b\u5e03\u4e2d\u70b9\u51fb\u5019\u9009\u5173\u7cfb\u5207\u6362';
const TEXT_INTERFACE_MANAGER = '\u63a5\u53e3\u7ba1\u7406\u5668';
const TEXT_INTERFACE_NAME = '\u63a5\u53e3\u540d\u79f0';
const TEXT_INTERFACE_NAME_PLACEHOLDER = '\u8f93\u5165\u63a5\u53e3\u540d\u79f0';
const TEXT_INTERFACE_DESCRIPTION_PLACEHOLDER =
  '\u4e3a\u4f7f\u7528\u8005\u8865\u5145\u63a5\u53e3\u7528\u9014\u3001\u4f7f\u7528\u573a\u666f\u6216\u8fd4\u56de\u6570\u636e\u8bf4\u660e';
const TEXT_INTERFACE_SAVE_HINT =
  '\u4fdd\u5b58\u540e\u4f1a\u8fdb\u5165\u516c\u5171\u63a5\u53e3\u7ba1\u7406\u5668';
const TEXT_SAVE_INTERFACE = '\u4fdd\u5b58\u63a5\u53e3';
const TEXT_OPEN_INTERFACE = '\u6253\u5f00';
const TEXT_RENAME_INTERFACE = '\u91cd\u547d\u540d';
const TEXT_CONFIRM_RENAME = '\u786e\u5b9a';
const TEXT_CANCEL_RENAME = '\u53d6\u6d88';
const TEXT_DELETE_INTERFACE = '\u5220\u9664';
const TEXT_PUBLISH_INTERFACE = '\u53d1\u5e03';
const TEXT_REPUBLISH_INTERFACE = '\u53d1\u5e03\u66f4\u65b0';
const TEXT_DEPRECATE_INTERFACE = '\u5f03\u7528';
const TEXT_RELEASE_VERSION = '\u5df2\u53d1\u5e03';
const TEXT_RELEASE_HISTORY = '\u5386\u53f2\u7248\u672c';
const TEXT_RELEASE_LEDGER = '\u7248\u672c\u53f0\u8d26';
const TEXT_CURRENT_RELEASE = '\u5f53\u524d';
const TEXT_HISTORICAL_RELEASE = '\u5386\u53f2';
const TEXT_ROLLBACK_RELEASE = '\u56de\u6eda\u5230\u6b64\u7248\u672c';
const TEXT_ROLLBACK_RELEASE_CONFIRM =
  '\u5386\u53f2\u5951\u7ea6\u5c06\u5148\u8fc1\u79fb\u5e76\u505a\u517c\u5bb9\u6027\u68c0\u67e5\uff0c\u7136\u540e\u4ee5\u65b0\u7248\u672c\u53d1\u5e03\u3002\u5f53\u524d\u7248\u672c\u4f1a\u4fdd\u7559\u5728\u53f0\u8d26\u4e2d\u3002';
const TEXT_RELEASE_IMPACT = '\u53d1\u5e03\u5f71\u54cd';
const TEXT_RELEASE_BREAKING = '\u7834\u574f\u6027\u53d8\u66f4';
const TEXT_RELEASE_ADDITIVE = '\u517c\u5bb9\u6269\u5c55';
const TEXT_RELEASE_PATCH = '\u8865\u4e01\u66f4\u65b0';
const TEXT_RELEASE_COMPATIBLE = '\u517c\u5bb9';
const TEXT_CHANGE_CALLABLE = '\u8c03\u7528\u540d\u5df2\u53d8\u66f4';
const TEXT_CHANGE_PARAMETER_ADDED = '\u65b0\u589e\u53ef\u9009\u53c2\u6570';
const TEXT_CHANGE_REQUIRED_PARAMETER_ADDED = '\u65b0\u589e\u5fc5\u586b\u53c2\u6570';
const TEXT_CHANGE_PARAMETER_REMOVED = '\u5220\u9664\u53c2\u6570';
const TEXT_CHANGE_PARAMETER_TYPE = '\u53c2\u6570\u7c7b\u578b\u53d8\u66f4';
const TEXT_CHANGE_PARAMETER_REQUIRED = '\u53c2\u6570\u6539\u4e3a\u5fc5\u586b';
const TEXT_CHANGE_PARAMETER_RELAXED = '\u53c2\u6570\u6539\u4e3a\u53ef\u9009';
const TEXT_CHANGE_PARAMETER_DEFAULT = '\u53c2\u6570\u9ed8\u8ba4\u503c\u53d8\u66f4';
const TEXT_CHANGE_RESULT_SHAPE = '\u7ed3\u679c\u5f62\u6001\u53d8\u66f4';
const TEXT_CHANGE_FIELD_ADDED = '\u65b0\u589e\u8f93\u51fa\u5b57\u6bb5';
const TEXT_CHANGE_FIELD_REMOVED = '\u5220\u9664\u8f93\u51fa\u5b57\u6bb5';
const TEXT_CHANGE_FIELD_TYPE = '\u8f93\u51fa\u5b57\u6bb5\u7c7b\u578b\u53d8\u66f4';
const TEXT_CHANGE_FIELD_NULLABLE = '\u8f93\u51fa\u5b57\u6bb5\u6539\u4e3a\u53ef\u7a7a';
const TEXT_CHANGE_FIELD_REQUIRED = '\u8f93\u51fa\u5b57\u6bb5\u6539\u4e3a\u975e\u7a7a';
const TEXT_CHANGE_REFS_REMOVED = '\u5220\u9664\u8bb0\u5f55\u5f15\u7528';
const TEXT_CHANGE_REFS_ADDED = '\u65b0\u589e\u8bb0\u5f55\u5f15\u7528';
const TEXT_CHANGE_PAGINATION = '\u5206\u9875\u6a21\u5f0f\u53d8\u66f4';
const TEXT_CHANGE_ACCESS = '\u8bbf\u95ee\u7b56\u7565\u53d8\u66f4';
const TEXT_CHANGE_ERRORS = '\u9519\u8bef\u5951\u7ea6\u53d8\u66f4';
const TEXT_CHANGE_QUERY = '\u67e5\u8be2\u884c\u4e3a\u53d8\u66f4';
const TEXT_CHANGE_METADATA = '\u63a5\u53e3\u8bf4\u660e\u53d8\u66f4';
const TEXT_ACCESS_POLICY = '\u8bbf\u95ee\u7b56\u7565';
const TEXT_ACCESS_KEY = '\u63a5\u53e3\u5bc6\u94a5';
const TEXT_ACCESS_KEY_CONFIGURED =
  '\u5df2\u914d\u7f6e\uff0c\u8f93\u5165\u65b0\u5bc6\u94a5\u53ef\u66ff\u6362';
const TEXT_ACCESS_KEY_PLACEHOLDER = '\u81f3\u5c11 12 \u4e2a\u5b57\u7b26';
const TEXT_ENABLE_RATE_LIMIT = '\u542f\u7528\u63a5\u53e3\u9650\u6d41';
const TEXT_RATE_LIMIT = '\u9650\u6d41';
const TEXT_RATE_LIMIT_REQUESTS = '\u65f6\u95f4\u7a97\u53e3\u5185\u6700\u5927\u8c03\u7528\u6570';
const TEXT_RATE_LIMIT_WINDOW = '\u65f6\u95f4\u7a97\u53e3\uff08\u79d2\uff09';
const TEXT_CALL_STATISTICS = '\u8c03\u7528\u7edf\u8ba1';
const TEXT_CALL_TREND = '\u8fd1 24 \u5c0f\u65f6\u8c03\u7528\u8d8b\u52bf';
const TEXT_LAST_CALL = '\u6700\u8fd1\u8c03\u7528';
const TEXT_RECENT_CALLS = '\u6700\u8fd1\u8c03\u7528\u8bb0\u5f55';
const TEXT_NO_RECENT_CALLS = '\u6682\u65e0\u8c03\u7528\u8bb0\u5f55';
const TEXT_CALL_SUCCESS = '\u6210\u529f';
const TEXT_CALL_FAILURE = '\u5931\u8d25';
const TEXT_ROWS = '\u884c\u6570';
const TEXT_REFRESH_STATISTICS = '\u5237\u65b0\u7edf\u8ba1';
const TEXT_REFRESH_STATISTICS_FAILED = '\u8c03\u7528\u7edf\u8ba1\u5237\u65b0\u5931\u8d25';
const TEXT_ONLINE_TEST = '\u5728\u7ebf\u8c03\u8bd5';
const TEXT_SDK_EXAMPLE = 'SDK \u8c03\u7528\u793a\u4f8b';
const TEXT_CALLS = '\u603b\u8c03\u7528';
const TEXT_SUCCESSES = '\u6210\u529f';
const TEXT_FAILURES = '\u5931\u8d25';
const TEXT_AVERAGE_MS = '\u5e73\u5747 ms';
const TEXT_NO_SAVED_INTERFACES = '\u6682\u65e0\u5df2\u4fdd\u5b58\u63a5\u53e3';
const TEXT_NO_DESCRIPTION = '\u6682\u65e0\u63cf\u8ff0';
const TEXT_ROOT_MODEL = '\u6839\u6a21\u578b';
const TEXT_UNKNOWN_ROOT = '\u672a\u77e5\u6839\u6a21\u578b';
const TEXT_CALL_ENTRY = '\u8c03\u7528\u5165\u53e3';
const TEXT_MODELS = '\u6a21\u578b';
const TEXT_RELATIONS = '\u5173\u7cfb';
const TEXT_BRANCHES = '\u5206\u652f';
const TEXT_FILTERS = '\u7b5b\u9009';
const TEXT_FILTER_LOGIC = '\u7b5b\u9009\u903b\u8f91';
const TEXT_FILTER_GROUPS = '\u6761\u4ef6\u7ec4';
const TEXT_RELATION_FILTERS = '\u5173\u8054\u6761\u4ef6';
const TEXT_AGGREGATION = '\u5206\u7ec4\u7edf\u8ba1';
const TEXT_GROUP_BY = '\u5206\u7ec4\u5b57\u6bb5';
const TEXT_ADD_GROUP_FIELD = '\u6dfb\u52a0\u5206\u7ec4';
const TEXT_METRICS = '\u7edf\u8ba1\u6307\u6807';
const TEXT_ADD_METRIC = '\u6dfb\u52a0\u6307\u6807';
const TEXT_METRIC_NAME = '\u8f93\u51fa\u952e';
const TEXT_DISTINCT = '\u53bb\u91cd';
const TEXT_HAVING = '\u7edf\u8ba1\u540e\u7b5b\u9009';
const TEXT_ADD_HAVING = '\u6dfb\u52a0\u7edf\u8ba1\u6761\u4ef6';
const TEXT_NO_GROUPS = '\u672a\u914d\u7f6e\u5206\u7ec4\u5b57\u6bb5';
const TEXT_NO_METRICS = '\u672a\u914d\u7f6e\u7edf\u8ba1\u6307\u6807';
const TEXT_FIELDS = '\u5b57\u6bb5';
const TEXT_QUERY_PATH = '\u67e5\u8be2\u4e3b\u8def\u5f84';
const TEXT_RELATION_SUMMARY = '\u5173\u7cfb\u6458\u8981';
const TEXT_OUTPUT_FIELDS = '\u8f93\u51fa\u5b57\u6bb5';
const TEXT_RESULT_TREE_TRUNCATED = '...';
const TEXT_RESULT_TREE_REFERENCE = '$ref';
const TEXT_PARAMETERS = '\u53c2\u6570';
const TEXT_ERRORS = '\u9519\u8bef';
const TEXT_UPDATED_AT = '\u66f4\u65b0';
const TEXT_EMPTY_VALUE = '\u6682\u65e0';
const TEXT_OUTPUT_TREE = '\u6811\u5f62\u8f93\u51fa';
const TEXT_OUTPUT_AGGREGATE = '\u7edf\u8ba1\u7ed3\u679c';
const TEXT_WRITE_READONLY = '\u53ea\u8bfb';
const TEXT_WRITE_PARTIAL = '\u90e8\u5206\u53ef\u5199';
const TEXT_WRITE_WRITABLE = '\u53ef\u5199';
const TEXT_WRITE_AMBIGUOUS = '\u5199\u5165\u6709\u6b67\u4e49';
const TEXT_PARAMETERS_EDITOR = '\u8c03\u7528\u53c2\u6570';
const TEXT_ADD_PARAMETER = '\u6dfb\u52a0\u53c2\u6570';
const TEXT_ADD_FILTER = '\u6dfb\u52a0\u7b5b\u9009';
const TEXT_PARAMETER_NAME = '\u53c2\u6570\u540d';
const TEXT_PARAMETER_DESCRIPTION = '\u63cf\u8ff0';
const TEXT_PARAMETER_REQUIRED = '\u5fc5\u586b';
const TEXT_FILTER_FIELD = '\u5b57\u6bb5';
const TEXT_FILTER_VALUE = '\u503c';
const TEXT_FILTER_PARAMETER = '\u53c2\u6570';
const TEXT_FILTER_LITERAL = '\u56fa\u5b9a\u503c';
const TEXT_FILTER_ENABLED = '\u542f\u7528';
const TEXT_REMOVE = '\u79fb\u9664';
const TEXT_ALL_CONDITIONS = '\u5168\u90e8\u6761\u4ef6';
const TEXT_CONDITION_GROUP = '\u6761\u4ef6\u7ec4';
const TEXT_MATCH_ALL_CONDITIONS = '\u6240\u6709\u6761\u4ef6\u90fd\u6ee1\u8db3';
const TEXT_MATCH_ANY_CONDITION = '\u4efb\u4e00\u6761\u4ef6\u6ee1\u8db3';
const TEXT_CONDITION_ITEMS = '\u9879';
const TEXT_ADD_GROUP = '\u6dfb\u52a0\u6761\u4ef6\u7ec4';
const TEXT_ADD_RELATION_FILTER = '\u6dfb\u52a0\u5173\u8054\u6761\u4ef6';
const TEXT_NO_FILTERS = '\u6682\u65e0\u7b5b\u9009\u6761\u4ef6';
const TEXT_PICK_FIELD = '\u9009\u62e9\u5b57\u6bb5';
const TEXT_PICK_RELATION = '\u9009\u62e9\u5173\u7cfb';
const TEXT_RELATION_SCOPE = '\u5173\u8054\u8303\u56f4';
const TEXT_QUERY_NODE = '\u67e5\u8be2\u8282\u70b9';
const TEXT_ROOT_NODE = '\u6839\u8282\u70b9';
const TEXT_SORTS = '\u6392\u5e8f';
const TEXT_ADD_SORT = '\u6dfb\u52a0\u6392\u5e8f';
const TEXT_NO_SORTS = '\u672a\u914d\u7f6e\u6392\u5e8f';
const TEXT_SORT_FIELD = '\u6392\u5e8f\u5b57\u6bb5';
const TEXT_SORT_DIRECTION = '\u65b9\u5411';
const TEXT_PAGINATION = '\u5206\u9875';
const TEXT_PAGINATION_NONE = '\u4e0d\u5206\u9875';
const TEXT_PAGINATION_OFFSET = '\u504f\u79fb\u5206\u9875';
const TEXT_PAGINATION_CURSOR = '\u6e38\u6807\u5206\u9875';
const TEXT_PAGINATION_DEFAULT_LIMIT = '\u9ed8\u8ba4\u6761\u6570';
const TEXT_PAGINATION_MAX_LIMIT = '\u6700\u5927\u6761\u6570';
const TEXT_RELATION_SOURCE_TITLE = '\u9009\u62e9\u5173\u7cfb\u8d77\u70b9';
const TEXT_RELATION_SOURCE_HINT =
  '\u5f53\u524d\u6a21\u578b\u5b58\u5728\u591a\u4e2a\u67e5\u8be2\u5206\u652f\uff0c\u8bf7\u786e\u5b9a\u5173\u7cfb\u5ef6\u4f38\u7684\u6765\u6e90\u3002';
const TEXT_RELATION_SOURCE_ALL = '\u5e94\u7528\u5230\u5168\u90e8\u5206\u652f';
const TEXT_MODEL_SOURCE_TITLE = '\u9009\u62e9\u6a21\u578b\u6302\u8f7d\u5206\u652f';
const TEXT_MODEL_SOURCE_HINT =
  '\u8bf7\u70b9\u51fb\u9ad8\u4eae\u8282\u70b9\uff0c\u786e\u5b9a\u6b64\u6a21\u578b\u5e94\u6302\u8f7d\u5230\u54ea\u6761\u67e5\u8be2\u8def\u5f84\u3002';
const TEXT_EXECUTION_PREVIEW = '\u6267\u884c\u9884\u89c8';
const TEXT_EXECUTION_EMPTY =
  '\u8bf7\u5148\u5728\u753b\u5e03\u4e2d\u9009\u62e9\u67e5\u8be2\u6839\u6a21\u578b\u3002';
const TEXT_EXECUTION_LIBRARY = '\u76ee\u6807\u6570\u636e\u5e93';
const TEXT_EXECUTION_LIBRARY_MISSING =
  '\u672a\u9009\u62e9\u53ef\u6267\u884c\u7684\u6570\u636e\u5e93';
const TEXT_EXECUTE_QUERY = '\u6267\u884c\u67e5\u8be2';
const TEXT_PREVIEW_PARAMETERS = '\u8c03\u7528\u53c2\u6570';
const TEXT_PREVIEW_LIMIT = '\u9884\u89c8\u6761\u6570';
const TEXT_NO_PREVIEW_PARAMETERS = '\u5f53\u524d\u63a5\u53e3\u65e0\u8c03\u7528\u53c2\u6570';
const TEXT_EXECUTION_PLAN = '\u6267\u884c\u8ba1\u5212';
const TEXT_EXECUTION_DIAGNOSTICS = '\u80fd\u529b\u68c0\u67e5';
const TEXT_BLOCKING_ISSUE = '\u5df2\u963b\u65ad';
const TEXT_EXECUTION_WARNING = '\u63d0\u793a';
const TEXT_WIRE_REQUEST = '\u67e5\u770b\u5f15\u64ce\u8bf7\u6c42';
const TEXT_EXECUTION_RESULT = '\u8fd4\u56de\u7ed3\u679c';
const TEXT_RESULT_VIEW = '\u7ed3\u679c\u89c6\u56fe';
const TEXT_TABLE_VIEW = '\u8868\u683c';
const TEXT_EXECUTION_RUNNING = '\u6b63\u5728\u6267\u884c\u67e5\u8be2...';
const TEXT_EXECUTION_RESULT_EMPTY =
  '\u6267\u884c\u540e\u5c06\u5728\u6b64\u5904\u663e\u793a\u8fd4\u56de\u7ed3\u679c';
const TEXT_EXECUTION_NO_ROWS = '\u67e5\u8be2\u6210\u529f\uff0c\u672a\u8fd4\u56de\u6570\u636e';
const TEXT_NEXT_PAGE = '\u4e0b\u4e00\u9875';
const TEXT_STAGE_READY = '\u5c31\u7eea';
const TEXT_STAGE_BLOCKED = '\u963b\u65ad';
const TEXT_STAGE_INACTIVE = '\u672a\u542f\u7528';

function previewParameterValue(
  parameter: InterfaceParameter,
  values: Readonly<Record<string, string>>,
): string {
  if (values[parameter.id] !== undefined) {
    return values[parameter.id]!;
  }
  if (parameter.defaultValue === undefined || parameter.defaultValue === null) {
    return '';
  }
  return typeof parameter.defaultValue === 'string'
    ? parameter.defaultValue
    : parameter.type === 'json'
      ? JSON.stringify(parameter.defaultValue)
      : String(parameter.defaultValue);
}

function previewParameterInputType(
  type: InterfaceValueType,
): 'text' | 'number' | 'date' | 'datetime-local' {
  if (type === 'number') {
    return 'number';
  }
  if (type === 'date') {
    return 'date';
  }
  if (type === 'datetime') {
    return 'datetime-local';
  }
  return 'text';
}

function executionStageLabel(stage: QueryExecutionStage['id']): string {
  const labels: Record<QueryExecutionStage['id'], string> = {
    scope: '\u6570\u636e\u8303\u56f4',
    filter: '\u6761\u4ef6\u7b5b\u9009',
    traversal: '\u5173\u7cfb\u904d\u5386',
    aggregation: '\u5206\u7ec4\u7edf\u8ba1',
    result: '\u7ed3\u679c\u8f93\u51fa',
  };
  return labels[stage];
}

function executionStageSummary(stage: QueryExecutionStage): string {
  const values = stage.summary.match(/\d+/g) ?? [];
  if (stage.id === 'scope') {
    return `${values[0] ?? 0} \u4e2a\u6a21\u578b\uff0c${values[1] ?? 0} \u4e2a\u67e5\u8be2\u8282\u70b9\uff0c${values[2] ?? 0} \u4e2a\u5173\u7cfb`;
  }
  if (stage.id === 'filter') {
    return `${values[0] ?? 0} \u4e2a\u5b57\u6bb5\u6761\u4ef6\uff0c${values[1] ?? 0} \u4e2a\u5173\u8054\u6761\u4ef6`;
  }
  if (stage.id === 'traversal') {
    return `${values[0] ?? 0} \u6bb5\u4e3b\u94fe\uff0c${values[1] ?? 0} \u6bb5\u5206\u652f`;
  }
  if (stage.id === 'aggregation') {
    return values.length > 0
      ? `${values[0] ?? 0} \u4e2a\u7ef4\u5ea6\uff0c${values[1] ?? 0} \u4e2a\u6307\u6807`
      : '\u672a\u914d\u7f6e\u5206\u7ec4\u7edf\u8ba1';
  }
  return `${values[0] ?? 0} \u4e2a\u8f93\u51fa\u5b57\u6bb5\uff0c${values[1] ?? 0} \u4e2a\u6392\u5e8f\uff0c\u6700\u591a ${values[2] ?? 0} \u6761`;
}

function executionDiagnosticMessage(
  i18n: ReturnType<typeof useDesigner>['i18n'],
  diagnostic: QueryExecutionDiagnostic,
): string {
  if (i18n.locale !== 'zh') {
    return interfaceDiagnosticMessage(i18n, diagnostic) ?? diagnostic.message;
  }
  const messages: Partial<Record<string, string>> = {
    execution_root_model_missing:
      '\u6839\u6a21\u578b\u4e0d\u5b58\u5728\u4e8e\u5f53\u524d\u5f15\u64ce\u76ee\u5f55\u4e2d\u3002',
    execution_primary_edge_missing:
      '\u4e3b\u67e5\u8be2\u94fe\u4e2d\u5b58\u5728\u65e0\u6cd5\u6267\u884c\u7684\u65ad\u5f00\u5173\u7cfb\u3002',
    execution_primary_edge_ambiguous:
      '\u4e3b\u67e5\u8be2\u94fe\u4e2d\u5b58\u5728\u672a\u89e3\u51b3\u7684\u591a\u5173\u7cfb\u6b67\u4e49\u3002',
    execution_constraint_edge_unsupported:
      '\u5f53\u524d\u5f15\u64ce\u534f\u8bae\u5c1a\u4e0d\u80fd\u6267\u884c\u7ea6\u675f\u8fb9\u3002',
    execution_sort_related_field_unsupported:
      '\u666e\u901a\u67e5\u8be2\u76ee\u524d\u53ea\u652f\u6301\u6309\u6839\u8282\u70b9\u5b57\u6bb5\u6392\u5e8f\u3002',
    execution_sort_aggregate_field_unsupported:
      '\u805a\u5408\u67e5\u8be2\u53ea\u80fd\u6309\u5206\u7ec4\u7ef4\u5ea6\u6216\u7edf\u8ba1\u6307\u6807\u6392\u5e8f\u3002',
    execution_sort_target_missing:
      '\u6392\u5e8f\u76ee\u6807\u5728\u5f53\u524d\u67e5\u8be2\u4e2d\u4e0d\u53ef\u7528\u3002',
    execution_projection_client_side:
      '\u5f15\u64ce\u8fd4\u56de\u5b8c\u6574\u8bb0\u5f55\uff0c\u9884\u89c8\u5c42\u4f1a\u6309\u63a5\u53e3\u5b57\u6bb5\u8fdb\u884c\u6295\u5f71\u3002',
    execution_cross_node_or_unsupported:
      '\u8de8\u591a\u4e2a\u67e5\u8be2\u8282\u70b9\u7684 OR \u6761\u4ef6\u6682\u65e0\u6cd5\u65e0\u635f\u4e0b\u53d1\u3002',
    execution_relation_filter_edge_missing:
      '\u5173\u8054\u6761\u4ef6\u5f15\u7528\u7684\u67e5\u8be2\u5173\u7cfb\u5df2\u4e0d\u53ef\u7528\u3002',
    execution_filter_operator_unsupported:
      '\u5f53\u524d\u6761\u4ef6\u64cd\u4f5c\u7b26\u5c1a\u672a\u88ab\u5f15\u64ce\u534f\u8bae\u652f\u6301\u3002',
    execution_parameter_value_missing:
      '\u8bf7\u5148\u8865\u5168\u5fc5\u8981\u7684\u8c03\u7528\u53c2\u6570\u3002',
    execution_parameter_value_invalid:
      '\u8c03\u7528\u53c2\u6570\u7684\u503c\u4e0e\u5b57\u6bb5\u7c7b\u578b\u4e0d\u5339\u914d\u3002',
    execution_having_metric_missing:
      '\u805a\u5408\u540e\u6761\u4ef6\u5f15\u7528\u7684\u7edf\u8ba1\u6307\u6807\u5df2\u4e0d\u53ef\u7528\u3002',
    execution_having_operator_unsupported:
      '\u5f53\u524d HAVING \u64cd\u4f5c\u7b26\u5c1a\u672a\u88ab\u5f15\u64ce\u534f\u8bae\u652f\u6301\u3002',
    execution_aggregation_subject_mismatch:
      '\u805a\u5408\u7ef4\u5ea6\u548c\u6307\u6807\u5fc5\u987b\u6765\u81ea\u4e3b\u67e5\u8be2\u94fe\u7684\u7ec8\u70b9\u6a21\u578b\u3002',
    execution_aggregation_branch_filter_unsupported:
      '\u805a\u5408\u67e5\u8be2\u6682\u4e0d\u80fd\u76f4\u63a5\u4f7f\u7528\u4ec5\u5b58\u5728\u4e8e\u5206\u652f\u8282\u70b9\u7684\u5b57\u6bb5\u6761\u4ef6\u3002',
    execution_duplicate_metric_operation:
      '\u540c\u4e00\u5b57\u6bb5\u4e0d\u80fd\u91cd\u590d\u8ba1\u7b97\u76f8\u540c\u7684\u805a\u5408\u6307\u6807\u3002',
  };
  return (
    messages[diagnostic.code] ?? interfaceDiagnosticMessage(i18n, diagnostic) ?? diagnostic.message
  );
}

function executionStatusLabel(
  status: 'idle' | 'running' | 'success' | 'error',
  result: QueryPreviewResult | undefined,
): string {
  if (status === 'running') {
    return TEXT_EXECUTION_RUNNING;
  }
  if (status === 'success' && result) {
    return `\u5df2\u8fd4\u56de ${result.rows.length} \u6761\u6570\u636e\uff0c\u7c7b\u578b ${result.rawKind}`;
  }
  if (status === 'error') {
    return '\u6267\u884c\u5931\u8d25';
  }
  return '\u5c1a\u672a\u6267\u884c';
}

function executionPreviewErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('Unsupported query plan version: 3')) {
    return '\u5f53\u524d\u670d\u52a1\u7aef\u7248\u672c\u8fc7\u65e7\uff0c\u8bf7\u91cd\u542f\u6216\u5347\u7ea7 ModelDB \u670d\u52a1\u540e\u91cd\u8bd5\u3002';
  }
  if (message.includes('Unsupported query plan version: 4')) {
    return '\u5f53\u524d\u670d\u52a1\u7aef\u7248\u672c\u8fc7\u65e7\uff0c\u8bf7\u91cd\u542f\u6216\u5347\u7ea7 ModelDB \u670d\u52a1\u540e\u91cd\u8bd5\u3002';
  }
  if (message.includes('Unsupported query plan version: 5')) {
    return '\u5f53\u524d\u670d\u52a1\u7aef\u7248\u672c\u8fc7\u65e7\uff0c\u8bf7\u91cd\u542f\u6216\u5347\u7ea7 ModelDB \u670d\u52a1\u540e\u91cd\u8bd5\u3002';
  }
  if (message.includes('Unsupported query plan version: 6')) {
    return '\u5f53\u524d\u670d\u52a1\u7aef\u7248\u672c\u8fc7\u65e7\uff0c\u8bf7\u91cd\u542f\u6216\u5347\u7ea7 ModelDB \u670d\u52a1\u540e\u91cd\u8bd5\u3002';
  }
  if (message.includes('Unsupported query plan version: 7')) {
    return '\u5f53\u524d\u670d\u52a1\u7aef\u7248\u672c\u8fc7\u65e7\uff0c\u8bf7\u91cd\u542f\u6216\u5347\u7ea7 ModelDB \u670d\u52a1\u540e\u91cd\u8bd5\u3002';
  }
  return message;
}

function previewCellValue(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (value === undefined) {
    return '-';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

const QUERY_PARAMETER_TYPES: readonly InterfaceValueType[] = [
  'string',
  'number',
  'boolean',
  'date',
  'datetime',
  'json',
];

const QUERY_FILTER_OPERATORS: readonly QueryFilterOperator[] = [
  'eq',
  'neq',
  'contains',
  'startsWith',
  'endsWith',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'notIn',
  'isNull',
  'isNotNull',
];

function saveFeedbackLabel(status: QueryInterfaceSaveResult['status']): string {
  if (status === 'created') {
    return '\u63a5\u53e3\u5df2\u521b\u5efa';
  }
  if (status === 'updated') {
    return '\u540c\u4e00\u63a5\u53e3\u5df2\u66f4\u65b0\uff0c\u672a\u91cd\u590d\u65b0\u5efa';
  }
  return '\u5185\u5bb9\u672a\u53d8\u5316\uff0c\u65e0\u9700\u91cd\u590d\u4fdd\u5b58';
}

function writeModeLabel(mode: 'readonly' | 'partial' | 'writable' | 'ambiguous'): string {
  if (mode === 'partial') {
    return TEXT_WRITE_PARTIAL;
  }
  if (mode === 'writable') {
    return TEXT_WRITE_WRITABLE;
  }
  if (mode === 'ambiguous') {
    return TEXT_WRITE_AMBIGUOUS;
  }
  return TEXT_WRITE_READONLY;
}

function QueryPaginationEditor(props: {
  pagination: QueryPagination;
  onChange: (pagination: QueryPagination) => void;
  hint: string;
  enableLabel: string;
}): ReactElement {
  const numericValue = (value: string): number | undefined => {
    const next = Number(value);
    return Number.isFinite(next) && next > 0 ? Math.floor(next) : undefined;
  };

  return (
    <section className="query-designer-section query-designer-pagination-basic">
      <div className="query-designer-section-heading">
        <div>
          <h3 className="designer-panel-section-title">{TEXT_PAGINATION}</h3>
          <span className="query-designer-hint">{props.hint}</span>
        </div>
      </div>
      <div className="query-condition-pagination-row">
        <label className="query-condition-toggle query-pagination-switch">
          <input
            type="checkbox"
            checked={props.pagination.mode !== 'none'}
            aria-label={TEXT_PAGINATION}
            onChange={(event) =>
              props.onChange(
                event.target.checked
                  ? { mode: 'offset', defaultLimit: props.pagination.defaultLimit ?? 20 }
                  : { mode: 'none' },
              )
            }
          />
          <span>{props.enableLabel}</span>
        </label>
        {props.pagination.mode !== 'none' ? (
          <>
            <label>
              <span>{TEXT_PAGINATION_DEFAULT_LIMIT}</span>
              <input
                type="number"
                min="1"
                value={props.pagination.defaultLimit ?? ''}
                onChange={(event) =>
                  props.onChange({
                    ...props.pagination,
                    defaultLimit: numericValue(event.target.value),
                  })
                }
              />
            </label>
          </>
        ) : null}
      </div>
    </section>
  );
}

function QueryConditionEditor(props: {
  fields: readonly ProjectionFieldCandidate[];
  aggregationFields: readonly ProjectionFieldCandidate[];
  relationCandidates: readonly QueryRelationConditionCandidate[];
  parameters: readonly InterfaceParameter[];
  filterTree: QueryFilterGroup;
  aggregation: QueryAggregationSpec;
  sorts: readonly QuerySort[];
  onParametersChange: (parameters: readonly InterfaceParameter[]) => void;
  onFilterTreeChange: (filterTree: QueryFilterGroup) => void;
  onAggregationChange: (aggregation: QueryAggregationSpec) => void;
  onSortsChange: (sorts: readonly QuerySort[]) => void;
}): ReactElement {
  const addParameter = (): void => {
    const names = new Set(props.parameters.map((parameter) => parameter.name));
    let index = props.parameters.length + 1;
    let name = `param${index}`;
    while (names.has(name)) {
      index += 1;
      name = `param${index}`;
    }
    props.onParametersChange([
      ...props.parameters,
      {
        id: `param_${Date.now().toString(36)}_${index}`,
        name,
        type: 'string',
        required: false,
      },
    ]);
  };

  const updateParameter = (id: string, patch: Partial<InterfaceParameter>): void => {
    props.onParametersChange(
      props.parameters.map((parameter) =>
        parameter.id === id ? { ...parameter, ...patch } : parameter,
      ),
    );
  };

  const removeParameter = (id: string): void => {
    props.onParametersChange(props.parameters.filter((parameter) => parameter.id !== id));
    props.onFilterTreeChange(
      mapQueryFilterTree(props.filterTree, (filter) =>
        filter.value?.kind === 'parameter' && filter.value.parameterId === id
          ? { ...filter, value: { kind: 'literal', value: '' } }
          : filter,
      ),
    );
    if (props.aggregation.having) {
      props.onAggregationChange({
        ...props.aggregation,
        having: mapQueryFilterTree(props.aggregation.having, (filter) =>
          filter.value?.kind === 'parameter' && filter.value.parameterId === id
            ? { ...filter, value: { kind: 'literal', value: '' } }
            : filter,
        ),
      });
    }
  };

  const addFilter = (groupId: string, preferredField?: ProjectionFieldCandidate): void => {
    const field = preferredField ?? props.fields[0];
    if (!field) {
      return;
    }
    props.onFilterTreeChange(
      appendQueryFilterExpression(props.filterTree, groupId, {
        id: `filter_${createUuid()}`,
        target: { nodeId: field.nodeId, modelId: field.modelId, fieldId: field.fieldId },
        operator: 'eq',
        value: { kind: 'literal', value: field.fieldType === 'boolean' ? false : '' },
        enabled: true,
      }),
    );
  };

  const addGroup = (groupId: string): void => {
    props.onFilterTreeChange(
      appendQueryFilterExpression(props.filterTree, groupId, {
        id: `group_${createUuid()}`,
        kind: 'group',
        combinator: 'and',
        enabled: true,
        children: [],
      }),
    );
  };

  const addRelationFilter = (
    groupId: string,
    preferredRelation?: QueryRelationConditionCandidate,
  ): void => {
    const relation = preferredRelation ?? props.relationCandidates[0];
    if (!relation) {
      return;
    }
    props.onFilterTreeChange(
      appendQueryFilterExpression(props.filterTree, groupId, {
        id: `relation_filter_${createUuid()}`,
        kind: 'relation',
        target: { edgeId: relation.edgeId, relationId: relation.relationId },
        sourceNodeId: relation.sourceNodeId,
        targetNodeId: relation.targetNodeId,
        quantifier: 'any',
        enabled: true,
        condition: {
          id: `relation_group_${createUuid()}`,
          kind: 'group',
          combinator: 'and',
          enabled: true,
          children: [],
        },
      }),
    );
  };

  const updateFilter = (id: string, patch: Partial<QueryFilter>): void => {
    props.onFilterTreeChange(
      updateQueryFilterExpression(props.filterTree, id, (expression) =>
        isQueryFilterGroup(expression) || isQueryRelationFilter(expression)
          ? expression
          : { ...expression, ...patch },
      ),
    );
  };

  const updateRelationFilter = (id: string, patch: Partial<QueryRelationFilter>): void => {
    props.onFilterTreeChange(
      updateQueryFilterExpression(props.filterTree, id, (expression) =>
        isQueryRelationFilter(expression) ? { ...expression, ...patch } : expression,
      ),
    );
  };

  const updateGroup = (id: string, patch: Partial<QueryFilterGroup>): void => {
    props.onFilterTreeChange(
      updateQueryFilterExpression(props.filterTree, id, (expression) =>
        isQueryFilterGroup(expression) ? { ...expression, ...patch } : expression,
      ),
    );
  };

  const removeExpression = (id: string): void => {
    props.onFilterTreeChange(removeQueryFilterExpression(props.filterTree, id));
  };

  const addSort = (): void => {
    const field = props.fields[0];
    const target: QuerySort['target'] | undefined = props.aggregation.metrics[0]
      ? { metricId: props.aggregation.metrics[0].id }
      : (props.aggregation.groupBy[0]?.source ??
        (field
          ? { nodeId: field.nodeId, modelId: field.modelId, fieldId: field.fieldId }
          : undefined));
    if (!target) {
      return;
    }
    const priority = props.sorts.reduce((max, sort) => Math.max(max, sort.priority), -1) + 1;
    props.onSortsChange([
      ...props.sorts,
      {
        id: `sort_${Date.now().toString(36)}`,
        target,
        direction: 'asc',
        priority,
      },
    ]);
  };

  const updateSort = (id: string, patch: Partial<QuerySort>): void => {
    props.onSortsChange(props.sorts.map((sort) => (sort.id === id ? { ...sort, ...patch } : sort)));
  };

  const removeSort = (id: string): void => {
    props.onSortsChange(
      props.sorts.filter((sort) => sort.id !== id).map((sort, priority) => ({ ...sort, priority })),
    );
  };

  const sortOptions = querySortOptions(props.fields, props.aggregation);

  return (
    <>
      <section className="query-designer-section">
        <h3 className="designer-panel-section-title">{TEXT_FILTERS}</h3>
        <QueryFilterGroupEditor
          group={props.filterTree}
          fields={props.fields}
          relationCandidates={props.relationCandidates}
          parameters={props.parameters}
          depth={0}
          root
          onAddFilter={addFilter}
          onAddGroup={addGroup}
          onAddRelationFilter={addRelationFilter}
          onUpdateFilter={updateFilter}
          onUpdateRelationFilter={updateRelationFilter}
          onUpdateGroup={updateGroup}
          onRemove={removeExpression}
        />
      </section>

      <QueryAggregationEditor
        fields={props.aggregationFields}
        parameters={props.parameters}
        aggregation={props.aggregation}
        onChange={props.onAggregationChange}
        onMetricRemoved={(metricId) =>
          props.onSortsChange(
            props.sorts
              .filter((sort) => !isQueryMetricRef(sort.target) || sort.target.metricId !== metricId)
              .map((sort, priority) => ({ ...sort, priority })),
          )
        }
      />

      <section className="query-designer-section">
        <div className="query-designer-section-heading">
          <h3 className="designer-panel-section-title">{TEXT_PARAMETERS_EDITOR}</h3>
          <button type="button" className="query-designer-button" onClick={addParameter}>
            {TEXT_ADD_PARAMETER}
          </button>
        </div>
        <div className="query-condition-list">
          {props.parameters.map((parameter) => (
            <div key={parameter.id} className="query-condition-parameter-row">
              <input
                value={parameter.name}
                aria-label={TEXT_PARAMETER_NAME}
                onChange={(event) => updateParameter(parameter.id, { name: event.target.value })}
              />
              <select
                value={parameter.type}
                aria-label="Type"
                onChange={(event) =>
                  updateParameter(parameter.id, { type: event.target.value as InterfaceValueType })
                }
              >
                {QUERY_PARAMETER_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
              <label className="query-condition-toggle" title={TEXT_PARAMETER_REQUIRED}>
                <input
                  type="checkbox"
                  checked={parameter.required}
                  onChange={(event) =>
                    updateParameter(parameter.id, { required: event.target.checked })
                  }
                />
                <span>{TEXT_PARAMETER_REQUIRED}</span>
              </label>
              <button
                type="button"
                className="query-condition-remove"
                onClick={() => removeParameter(parameter.id)}
              >
                {TEXT_REMOVE}
              </button>
              <input
                className="query-condition-description"
                value={parameter.description ?? ''}
                placeholder={TEXT_PARAMETER_DESCRIPTION}
                onChange={(event) =>
                  updateParameter(parameter.id, { description: event.target.value })
                }
              />
            </div>
          ))}
        </div>
      </section>

      <section className="query-designer-section">
        <div className="query-designer-section-heading">
          <h3 className="designer-panel-section-title">{TEXT_SORTS}</h3>
          <button
            type="button"
            className="query-designer-button"
            disabled={props.fields.length === 0}
            onClick={addSort}
          >
            {TEXT_ADD_SORT}
          </button>
        </div>
        <div className="query-condition-list">
          {props.sorts.length > 0 ? (
            props.sorts.map((sort, index) => {
              return (
                <div key={sort.id} className="query-condition-sort-row">
                  <span className="query-condition-sort-priority">{index + 1}</span>
                  <select
                    value={querySortTargetKey(sort.target)}
                    aria-label={TEXT_SORT_FIELD}
                    onChange={(event) => {
                      const next = sortOptions.find(
                        (candidate) => candidate.key === event.target.value,
                      );
                      if (next) {
                        updateSort(sort.id, { target: next.target });
                      }
                    }}
                  >
                    {sortOptions.map((candidate) => (
                      <option key={candidate.key} value={candidate.key}>
                        {candidate.label}
                      </option>
                    ))}
                  </select>
                  <select
                    value={sort.direction}
                    aria-label={TEXT_SORT_DIRECTION}
                    onChange={(event) =>
                      updateSort(sort.id, {
                        direction: event.target.value as QuerySort['direction'],
                      })
                    }
                  >
                    <option value="asc">ASC</option>
                    <option value="desc">DESC</option>
                  </select>
                  <button
                    type="button"
                    className="query-condition-remove"
                    onClick={() => removeSort(sort.id)}
                  >
                    {TEXT_REMOVE}
                  </button>
                </div>
              );
            })
          ) : (
            <span className="query-designer-empty">{TEXT_NO_SORTS}</span>
          )}
        </div>
      </section>
    </>
  );
}

function QueryAggregationResultSchema(props: {
  fields: QueryInterface['query']['result']['schema'];
}): ReactElement {
  return (
    <div className="query-interface-result-tree query-aggregation-result-schema" role="tree">
      <div className="query-interface-result-tree-line">
        <span className="query-interface-result-tree-punctuation">{'[{'}</span>
      </div>
      {props.fields.map((field) => (
        <div key={field.name} className="query-interface-result-tree-field">
          <span className="query-interface-result-tree-field-key">{field.name}</span>
          <span className="query-interface-result-tree-field-type">{field.type}</span>
          {!field.nullable ? (
            <span className="query-interface-result-tree-required">required</span>
          ) : null}
        </div>
      ))}
      <div className="query-interface-result-tree-line">
        <span className="query-interface-result-tree-punctuation">{'}]'}</span>
      </div>
    </div>
  );
}

function QueryAggregationEditor(props: {
  fields: readonly ProjectionFieldCandidate[];
  parameters: readonly InterfaceParameter[];
  aggregation: QueryAggregationSpec;
  onChange: (aggregation: QueryAggregationSpec) => void;
  onMetricRemoved: (metricId: string) => void;
}): ReactElement {
  const addGroupField = (): void => {
    const selectedKeys = new Set(
      props.aggregation.groupBy.map((group) =>
        queryProjectionFieldKey(group.source.nodeId, group.source.fieldId),
      ),
    );
    const field =
      props.fields.find((candidate) => !selectedKeys.has(candidate.key)) ?? props.fields[0];
    if (!field) {
      return;
    }
    props.onChange({
      ...props.aggregation,
      groupBy: [
        ...props.aggregation.groupBy,
        {
          id: `group_field_${createUuid()}`,
          source: { nodeId: field.nodeId, modelId: field.modelId, fieldId: field.fieldId },
          outputName: uniqueAggregationOutputName(field.fieldKey, props.aggregation),
        },
      ],
    });
  };

  const updateGroupField = (
    id: string,
    patch: Partial<QueryAggregationSpec['groupBy'][number]>,
  ): void => {
    props.onChange({
      ...props.aggregation,
      groupBy: props.aggregation.groupBy.map((group) =>
        group.id === id ? { ...group, ...patch } : group,
      ),
    });
  };

  const removeGroupField = (id: string): void => {
    props.onChange({
      ...props.aggregation,
      groupBy: props.aggregation.groupBy.filter((group) => group.id !== id),
    });
  };

  const addMetric = (): void => {
    const field = props.fields[0];
    if (!field) {
      return;
    }
    const metricFunction: QueryAggregateMetric['function'] = 'count';
    props.onChange({
      ...props.aggregation,
      metrics: [
        ...props.aggregation.metrics,
        {
          id: `metric_${createUuid()}`,
          function: metricFunction,
          source: { nodeId: field.nodeId, modelId: field.modelId, fieldId: field.fieldId },
          outputName: uniqueAggregationOutputName(
            `${metricFunction}_${field.fieldKey}`,
            props.aggregation,
          ),
          distinct: false,
        },
      ],
    });
  };

  const updateMetric = (id: string, patch: Partial<QueryAggregateMetric>): void => {
    props.onChange({
      ...props.aggregation,
      metrics: props.aggregation.metrics.map((metric) =>
        metric.id === id ? { ...metric, ...patch } : metric,
      ),
    });
  };

  const removeMetric = (id: string): void => {
    let having = props.aggregation.having;
    if (having) {
      for (const filter of flattenQueryFilterTree(having)) {
        if (isQueryMetricRef(filter.target) && filter.target.metricId === id) {
          having = removeQueryFilterExpression(having, filter.id);
        }
      }
    }
    props.onChange({
      ...props.aggregation,
      metrics: props.aggregation.metrics.filter((metric) => metric.id !== id),
      having,
    });
    props.onMetricRemoved(id);
  };

  const havingRoot = props.aggregation.having ?? createHavingRoot();
  const changeHaving = (having: QueryFilterGroup): void => {
    props.onChange({ ...props.aggregation, having });
  };
  const addHavingFilter = (groupId: string): void => {
    const metric = props.aggregation.metrics[0];
    if (!metric) {
      return;
    }
    const type = aggregateMetricValueType(metric, props.fields);
    changeHaving(
      appendQueryFilterExpression(havingRoot, groupId, {
        id: `having_${createUuid()}`,
        target: { metricId: metric.id },
        operator: type === 'number' ? 'gt' : 'eq',
        value: { kind: 'literal', value: type === 'number' ? 0 : '' },
        enabled: true,
      }),
    );
  };
  const addHavingGroup = (groupId: string): void => {
    changeHaving(
      appendQueryFilterExpression(havingRoot, groupId, {
        id: `having_group_${createUuid()}`,
        kind: 'group',
        combinator: 'and',
        enabled: true,
        children: [],
      }),
    );
  };
  const updateHavingFilter = (id: string, patch: Partial<QueryFilter>): void => {
    changeHaving(
      updateQueryFilterExpression(havingRoot, id, (expression) =>
        isQueryFilterGroup(expression) || isQueryRelationFilter(expression)
          ? expression
          : { ...expression, ...patch },
      ),
    );
  };
  const updateHavingGroup = (id: string, patch: Partial<QueryFilterGroup>): void => {
    changeHaving(
      updateQueryFilterExpression(havingRoot, id, (expression) =>
        isQueryFilterGroup(expression) ? { ...expression, ...patch } : expression,
      ),
    );
  };
  const removeHavingExpression = (id: string): void => {
    changeHaving(removeQueryFilterExpression(havingRoot, id));
  };

  return (
    <>
      <section className="query-designer-section query-aggregation-section">
        <div className="query-designer-section-heading">
          <h3 className="designer-panel-section-title">{TEXT_AGGREGATION}</h3>
          <div className="query-aggregation-heading-actions">
            <button
              type="button"
              className="query-designer-button"
              disabled={props.fields.length === 0}
              onClick={addGroupField}
            >
              {TEXT_ADD_GROUP_FIELD}
            </button>
            <button
              type="button"
              className="query-designer-button"
              disabled={props.fields.length === 0}
              onClick={addMetric}
            >
              {TEXT_ADD_METRIC}
            </button>
          </div>
        </div>

        <div className="query-aggregation-lane">
          <span className="query-aggregation-lane-title">{TEXT_GROUP_BY}</span>
          <div className="query-aggregation-list">
            {props.aggregation.groupBy.length > 0 ? (
              props.aggregation.groupBy.map((group) => {
                const field = props.fields.find(
                  (candidate) =>
                    candidate.nodeId === group.source.nodeId &&
                    candidate.fieldId === group.source.fieldId,
                );
                return (
                  <div key={group.id} className="query-aggregation-row">
                    <QueryFieldPicker
                      fields={props.fields}
                      value={field?.key}
                      onChange={(next) =>
                        updateGroupField(group.id, {
                          source: {
                            nodeId: next.nodeId,
                            modelId: next.modelId,
                            fieldId: next.fieldId,
                          },
                        })
                      }
                    />
                    <input
                      value={group.outputName}
                      aria-label={TEXT_METRIC_NAME}
                      onChange={(event) =>
                        updateGroupField(group.id, {
                          outputName: normalizeAggregationOutputName(event.target.value),
                        })
                      }
                    />
                    <button
                      type="button"
                      className="query-condition-remove"
                      onClick={() => removeGroupField(group.id)}
                    >
                      {TEXT_REMOVE}
                    </button>
                  </div>
                );
              })
            ) : (
              <span className="query-designer-empty">{TEXT_NO_GROUPS}</span>
            )}
          </div>
        </div>

        <div className="query-aggregation-lane">
          <span className="query-aggregation-lane-title">{TEXT_METRICS}</span>
          <div className="query-aggregation-list">
            {props.aggregation.metrics.length > 0 ? (
              props.aggregation.metrics.map((metric) => {
                const field = props.fields.find(
                  (candidate) =>
                    candidate.nodeId === metric.source.nodeId &&
                    candidate.fieldId === metric.source.fieldId,
                );
                const functions = aggregateFunctionsForField(field?.fieldType);
                return (
                  <div key={metric.id} className="query-aggregation-row query-metric-row">
                    <select
                      value={metric.function}
                      aria-label={TEXT_METRICS}
                      onChange={(event) =>
                        updateMetric(metric.id, {
                          function: event.target.value as QueryAggregateMetric['function'],
                        })
                      }
                    >
                      {functions.map((metricFunction) => (
                        <option key={metricFunction} value={metricFunction}>
                          {metricFunction.toUpperCase()}
                        </option>
                      ))}
                    </select>
                    <QueryFieldPicker
                      fields={props.fields}
                      value={field?.key}
                      onChange={(next) => {
                        const nextFunctions = aggregateFunctionsForField(next.fieldType);
                        updateMetric(metric.id, {
                          source: {
                            nodeId: next.nodeId,
                            modelId: next.modelId,
                            fieldId: next.fieldId,
                          },
                          function: nextFunctions.includes(metric.function)
                            ? metric.function
                            : 'count',
                        });
                      }}
                    />
                    <input
                      value={metric.outputName}
                      aria-label={TEXT_METRIC_NAME}
                      onChange={(event) =>
                        updateMetric(metric.id, {
                          outputName: normalizeAggregationOutputName(event.target.value),
                        })
                      }
                    />
                    <label className="query-condition-toggle" title={TEXT_DISTINCT}>
                      <input
                        type="checkbox"
                        checked={metric.distinct === true}
                        onChange={(event) =>
                          updateMetric(metric.id, { distinct: event.target.checked })
                        }
                      />
                      <span>{TEXT_DISTINCT}</span>
                    </label>
                    <button
                      type="button"
                      className="query-condition-remove"
                      onClick={() => removeMetric(metric.id)}
                    >
                      {TEXT_REMOVE}
                    </button>
                  </div>
                );
              })
            ) : (
              <span className="query-designer-empty">{TEXT_NO_METRICS}</span>
            )}
          </div>
        </div>
      </section>

      {props.aggregation.metrics.length > 0 ? (
        <section className="query-designer-section">
          <h3 className="designer-panel-section-title">{TEXT_HAVING}</h3>
          <QueryMetricFilterGroupEditor
            group={havingRoot}
            metrics={props.aggregation.metrics}
            fields={props.fields}
            parameters={props.parameters}
            depth={0}
            root
            onAddFilter={addHavingFilter}
            onAddGroup={addHavingGroup}
            onUpdateFilter={updateHavingFilter}
            onUpdateGroup={updateHavingGroup}
            onRemove={removeHavingExpression}
          />
        </section>
      ) : null}
    </>
  );
}

function QueryMetricFilterGroupEditor(props: {
  group: QueryFilterGroup;
  metrics: readonly QueryAggregateMetric[];
  fields: readonly ProjectionFieldCandidate[];
  parameters: readonly InterfaceParameter[];
  depth: number;
  root?: boolean;
  onAddFilter: (groupId: string) => void;
  onAddGroup: (groupId: string) => void;
  onUpdateFilter: (id: string, patch: Partial<QueryFilter>) => void;
  onUpdateGroup: (id: string, patch: Partial<QueryFilterGroup>) => void;
  onRemove: (id: string) => void;
}): ReactElement {
  return (
    <div
      className="query-filter-group query-having-group"
      data-root={props.root ? 'true' : 'false'}
      data-combinator={props.group.combinator}
    >
      <div className="query-filter-group-header">
        <div className="query-filter-group-identity">
          <span className="query-filter-logic-badge" aria-hidden>
            {props.group.combinator.toUpperCase()}
          </span>
          <span className="query-filter-group-copy">
            <span className="query-filter-group-title">
              {props.root ? TEXT_HAVING : TEXT_CONDITION_GROUP}
            </span>
            <small>
              {props.group.combinator === 'and'
                ? TEXT_MATCH_ALL_CONDITIONS
                : TEXT_MATCH_ANY_CONDITION}
              {` \u00b7 ${props.group.children.length} ${TEXT_CONDITION_ITEMS}`}
            </small>
          </span>
          <div
            className="query-designer-segment query-filter-combinator"
            role="group"
            aria-label={TEXT_FILTER_LOGIC}
          >
            {(['and', 'or'] as const).map((combinator) => (
              <button
                key={combinator}
                type="button"
                data-active={props.group.combinator === combinator ? 'true' : 'false'}
                aria-pressed={props.group.combinator === combinator}
                onClick={() => props.onUpdateGroup(props.group.id, { combinator })}
              >
                {combinator.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
        <div className="query-filter-group-actions">
          <button
            type="button"
            className="query-filter-action"
            onClick={() => props.onAddFilter(props.group.id)}
          >
            {TEXT_ADD_HAVING}
          </button>
          <button
            type="button"
            className="query-filter-action"
            disabled={props.depth >= 4}
            onClick={() => props.onAddGroup(props.group.id)}
          >
            {TEXT_ADD_GROUP}
          </button>
          {!props.root ? (
            <button
              type="button"
              className="query-filter-action query-filter-action--danger"
              onClick={() => props.onRemove(props.group.id)}
            >
              {TEXT_REMOVE}
            </button>
          ) : null}
        </div>
      </div>
      <div className="query-filter-group-children">
        {props.group.children.length > 0 ? (
          props.group.children.map((child) =>
            isQueryFilterGroup(child) ? (
              <QueryMetricFilterGroupEditor
                key={child.id}
                group={child}
                metrics={props.metrics}
                fields={props.fields}
                parameters={props.parameters}
                depth={props.depth + 1}
                onAddFilter={props.onAddFilter}
                onAddGroup={props.onAddGroup}
                onUpdateFilter={props.onUpdateFilter}
                onUpdateGroup={props.onUpdateGroup}
                onRemove={props.onRemove}
              />
            ) : isQueryRelationFilter(child) ? null : (
              <QueryMetricFilterPredicateEditor
                key={child.id}
                filter={child}
                metrics={props.metrics}
                fields={props.fields}
                parameters={props.parameters}
                onUpdate={(patch) => props.onUpdateFilter(child.id, patch)}
                onRemove={() => props.onRemove(child.id)}
              />
            ),
          )
        ) : (
          <span className="query-designer-empty query-filter-group-empty">{TEXT_NO_FILTERS}</span>
        )}
      </div>
    </div>
  );
}

function QueryMetricFilterPredicateEditor(props: {
  filter: QueryFilter;
  metrics: readonly QueryAggregateMetric[];
  fields: readonly ProjectionFieldCandidate[];
  parameters: readonly InterfaceParameter[];
  onUpdate: (patch: Partial<QueryFilter>) => void;
  onRemove: () => void;
}): ReactElement {
  const target = props.filter.target;
  const metric = isQueryMetricRef(target)
    ? props.metrics.find((item) => item.id === target.metricId)
    : undefined;
  const type = metric ? aggregateMetricValueType(metric, props.fields) : 'number';
  const operators = filterOperatorsForField(type);
  const requiresValue = !['isNull', 'isNotNull'].includes(props.filter.operator);
  const parameterMode = props.filter.value?.kind === 'parameter';
  const literalValue =
    props.filter.value?.kind === 'literal' ? (props.filter.value.value ?? '') : '';
  return (
    <div className="query-filter-predicate query-metric-filter-predicate">
      <div className="query-filter-predicate-main">
        <select
          className="query-metric-filter-target"
          value={metric?.id ?? ''}
          aria-label={TEXT_METRICS}
          onChange={(event) => {
            const next = props.metrics.find((item) => item.id === event.target.value);
            if (next) {
              const nextType = aggregateMetricValueType(next, props.fields);
              props.onUpdate({
                target: { metricId: next.id },
                operator: filterOperatorsForField(nextType).includes(props.filter.operator)
                  ? props.filter.operator
                  : 'eq',
              });
            }
          }}
        >
          {props.metrics.map((item) => (
            <option key={item.id} value={item.id}>
              {item.outputName}
            </option>
          ))}
        </select>
        <select
          className="query-filter-operator"
          value={props.filter.operator}
          aria-label="Operator"
          onChange={(event) => {
            const operator = event.target.value as QueryFilterOperator;
            props.onUpdate({
              operator,
              value: ['isNull', 'isNotNull'].includes(operator)
                ? undefined
                : (props.filter.value ?? { kind: 'literal', value: '' }),
            });
          }}
        >
          {operators.map((operator) => (
            <option key={operator} value={operator}>
              {filterOperatorLabel(operator)}
            </option>
          ))}
        </select>
      </div>
      {requiresValue ? (
        <div className="query-filter-predicate-value">
          <div className="query-designer-segment">
            <button
              type="button"
              data-active={!parameterMode ? 'true' : 'false'}
              onClick={() => props.onUpdate({ value: { kind: 'literal', value: '' } })}
            >
              {TEXT_FILTER_LITERAL}
            </button>
            <button
              type="button"
              data-active={parameterMode ? 'true' : 'false'}
              disabled={props.parameters.length === 0}
              onClick={() =>
                props.parameters[0]
                  ? props.onUpdate({
                      value: { kind: 'parameter', parameterId: props.parameters[0].id },
                    })
                  : undefined
              }
            >
              {TEXT_FILTER_PARAMETER}
            </button>
          </div>
          {parameterMode ? (
            <select
              value={props.filter.value?.kind === 'parameter' ? props.filter.value.parameterId : ''}
              onChange={(event) =>
                props.onUpdate({
                  value: { kind: 'parameter', parameterId: event.target.value },
                })
              }
            >
              {props.parameters.map((parameter) => (
                <option key={parameter.id} value={parameter.id}>
                  {parameter.name}
                </option>
              ))}
            </select>
          ) : (
            <input
              type={literalInputType(type)}
              value={String(literalValue)}
              aria-label={TEXT_FILTER_VALUE}
              onChange={(event) =>
                props.onUpdate({
                  value: {
                    kind: 'literal',
                    value:
                      type === 'number' && event.target.value !== ''
                        ? Number(event.target.value)
                        : event.target.value,
                  },
                })
              }
            />
          )}
        </div>
      ) : null}
      <div className="query-filter-predicate-actions">
        <label className="query-condition-toggle" title={TEXT_FILTER_ENABLED}>
          <input
            type="checkbox"
            checked={props.filter.enabled}
            onChange={(event) => props.onUpdate({ enabled: event.target.checked })}
          />
          <span>{TEXT_FILTER_ENABLED}</span>
        </label>
        <button type="button" className="query-condition-remove" onClick={props.onRemove}>
          {TEXT_REMOVE}
        </button>
      </div>
    </div>
  );
}

function QueryFilterGroupEditor(props: {
  group: QueryFilterGroup;
  fields: readonly ProjectionFieldCandidate[];
  relationCandidates: readonly QueryRelationConditionCandidate[];
  parameters: readonly InterfaceParameter[];
  depth: number;
  root?: boolean;
  onAddFilter: (groupId: string, preferredField?: ProjectionFieldCandidate) => void;
  onAddGroup: (groupId: string) => void;
  onAddRelationFilter: (
    groupId: string,
    preferredRelation?: QueryRelationConditionCandidate,
  ) => void;
  onUpdateFilter: (id: string, patch: Partial<QueryFilter>) => void;
  onUpdateRelationFilter: (id: string, patch: Partial<QueryRelationFilter>) => void;
  onUpdateGroup: (id: string, patch: Partial<QueryFilterGroup>) => void;
  onRemove: (id: string) => void;
}): ReactElement {
  const canNest = props.depth < 4;
  return (
    <div
      className="query-filter-group"
      data-root={props.root ? 'true' : 'false'}
      data-enabled={props.group.enabled ? 'true' : 'false'}
      data-combinator={props.group.combinator}
    >
      <div className="query-filter-group-header">
        <div className="query-filter-group-identity">
          <span className="query-filter-logic-badge" aria-hidden>
            {props.group.combinator.toUpperCase()}
          </span>
          <span className="query-filter-group-copy">
            <span className="query-filter-group-title">
              {props.root ? TEXT_ALL_CONDITIONS : TEXT_CONDITION_GROUP}
            </span>
            <small>
              {props.group.combinator === 'and'
                ? TEXT_MATCH_ALL_CONDITIONS
                : TEXT_MATCH_ANY_CONDITION}
              {` \u00b7 ${props.group.children.length} ${TEXT_CONDITION_ITEMS}`}
            </small>
          </span>
          <div
            className="query-designer-segment query-filter-combinator"
            role="group"
            aria-label={TEXT_FILTER_LOGIC}
          >
            {(['and', 'or'] as const).map((combinator) => (
              <button
                key={combinator}
                type="button"
                data-active={props.group.combinator === combinator ? 'true' : 'false'}
                aria-pressed={props.group.combinator === combinator}
                onClick={() => props.onUpdateGroup(props.group.id, { combinator })}
              >
                {combinator.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
        <div className="query-filter-group-actions">
          <button
            type="button"
            className="query-filter-action"
            disabled={props.fields.length === 0}
            onClick={() => props.onAddFilter(props.group.id, props.fields[0])}
          >
            {TEXT_ADD_FILTER}
          </button>
          <button
            type="button"
            className="query-filter-action"
            disabled={props.relationCandidates.length === 0}
            onClick={() => props.onAddRelationFilter(props.group.id, props.relationCandidates[0])}
          >
            {TEXT_ADD_RELATION_FILTER}
          </button>
          <button
            type="button"
            className="query-filter-action"
            disabled={!canNest}
            onClick={() => props.onAddGroup(props.group.id)}
          >
            {TEXT_ADD_GROUP}
          </button>
          {!props.root ? (
            <button
              type="button"
              className="query-filter-action query-filter-action--danger"
              onClick={() => props.onRemove(props.group.id)}
            >
              {TEXT_REMOVE}
            </button>
          ) : null}
        </div>
      </div>

      <div className="query-filter-group-children">
        {props.group.children.length > 0 ? (
          props.group.children.map((child) =>
            isQueryFilterGroup(child) ? (
              <QueryFilterGroupEditor
                key={child.id}
                group={child}
                fields={props.fields}
                relationCandidates={props.relationCandidates}
                parameters={props.parameters}
                depth={props.depth + 1}
                onAddFilter={props.onAddFilter}
                onAddGroup={props.onAddGroup}
                onAddRelationFilter={props.onAddRelationFilter}
                onUpdateFilter={props.onUpdateFilter}
                onUpdateRelationFilter={props.onUpdateRelationFilter}
                onUpdateGroup={props.onUpdateGroup}
                onRemove={props.onRemove}
              />
            ) : isQueryRelationFilter(child) ? (
              <QueryRelationFilterEditor
                key={child.id}
                filter={child}
                candidates={props.relationCandidates}
                fields={props.fields}
                parameters={props.parameters}
                depth={props.depth + 1}
                onAddFilter={props.onAddFilter}
                onAddGroup={props.onAddGroup}
                onAddRelationFilter={props.onAddRelationFilter}
                onUpdateFilter={props.onUpdateFilter}
                onUpdateRelationFilter={props.onUpdateRelationFilter}
                onUpdateGroup={props.onUpdateGroup}
                onRemove={props.onRemove}
              />
            ) : (
              <QueryFilterPredicateEditor
                key={child.id}
                filter={child}
                fields={props.fields}
                parameters={props.parameters}
                onUpdate={(patch) => props.onUpdateFilter(child.id, patch)}
                onRemove={() => props.onRemove(child.id)}
              />
            ),
          )
        ) : (
          <span className="query-designer-empty query-filter-group-empty">{TEXT_NO_FILTERS}</span>
        )}
      </div>
    </div>
  );
}

function QueryRelationFilterEditor(props: {
  filter: QueryRelationFilter;
  candidates: readonly QueryRelationConditionCandidate[];
  fields: readonly ProjectionFieldCandidate[];
  parameters: readonly InterfaceParameter[];
  depth: number;
  onAddFilter: (groupId: string, preferredField?: ProjectionFieldCandidate) => void;
  onAddGroup: (groupId: string) => void;
  onAddRelationFilter: (
    groupId: string,
    preferredRelation?: QueryRelationConditionCandidate,
  ) => void;
  onUpdateFilter: (id: string, patch: Partial<QueryFilter>) => void;
  onUpdateRelationFilter: (id: string, patch: Partial<QueryRelationFilter>) => void;
  onUpdateGroup: (id: string, patch: Partial<QueryFilterGroup>) => void;
  onRemove: (id: string) => void;
}): ReactElement {
  const selected = props.candidates.find(
    (candidate) => candidate.edgeId === props.filter.target.edgeId,
  );
  const targetFields = props.fields.filter((field) => field.nodeId === props.filter.targetNodeId);
  const nestedRelations = props.candidates.filter(
    (candidate) => candidate.sourceNodeId === props.filter.targetNodeId,
  );

  const selectRelation = (candidate: QueryRelationConditionCandidate): void => {
    props.onUpdateRelationFilter(props.filter.id, {
      target: { edgeId: candidate.edgeId, relationId: candidate.relationId },
      sourceNodeId: candidate.sourceNodeId,
      targetNodeId: candidate.targetNodeId,
      condition: { ...props.filter.condition, children: [] },
    });
  };

  return (
    <div className="query-relation-filter" data-enabled={props.filter.enabled ? 'true' : 'false'}>
      <div className="query-relation-filter-header">
        <QueryRelationPicker
          candidates={props.candidates}
          value={selected?.edgeId}
          onChange={selectRelation}
        />
        <div className="query-designer-segment query-relation-quantifier" role="group">
          {(['any', 'all', 'none'] as const).map((quantifier) => (
            <button
              key={quantifier}
              type="button"
              data-active={props.filter.quantifier === quantifier ? 'true' : 'false'}
              onClick={() => props.onUpdateRelationFilter(props.filter.id, { quantifier })}
            >
              {relationQuantifierLabel(quantifier)}
            </button>
          ))}
        </div>
        <div className="query-relation-filter-actions">
          <label className="query-condition-toggle" title={TEXT_FILTER_ENABLED}>
            <input
              type="checkbox"
              checked={props.filter.enabled}
              onChange={(event) =>
                props.onUpdateRelationFilter(props.filter.id, { enabled: event.target.checked })
              }
            />
            <span>{TEXT_FILTER_ENABLED}</span>
          </label>
          <button
            type="button"
            className="query-condition-remove"
            onClick={() => props.onRemove(props.filter.id)}
          >
            {TEXT_REMOVE}
          </button>
        </div>
      </div>

      {selected ? (
        <div className="query-relation-filter-path">
          <span>{selected.sourceLabel}</span>
          <strong>{selected.label}</strong>
          <span>{selected.targetLabel}</span>
        </div>
      ) : null}

      <QueryFilterGroupEditor
        group={props.filter.condition}
        fields={targetFields}
        relationCandidates={nestedRelations}
        parameters={props.parameters}
        depth={props.depth}
        root
        onAddFilter={props.onAddFilter}
        onAddGroup={props.onAddGroup}
        onAddRelationFilter={props.onAddRelationFilter}
        onUpdateFilter={props.onUpdateFilter}
        onUpdateRelationFilter={props.onUpdateRelationFilter}
        onUpdateGroup={props.onUpdateGroup}
        onRemove={props.onRemove}
      />
    </div>
  );
}

function QueryRelationPicker(props: {
  candidates: readonly QueryRelationConditionCandidate[];
  value: string | undefined;
  onChange: (candidate: QueryRelationConditionCandidate) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const selected = props.candidates.find((candidate) => candidate.edgeId === props.value);
  return (
    <div className="query-relation-picker" data-open={open ? 'true' : 'false'}>
      <button
        type="button"
        className="query-relation-picker-trigger"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{selected?.label ?? TEXT_PICK_RELATION}</span>
        <small>
          {selected ? `${selected.sourceLabel} -> ${selected.targetLabel}` : TEXT_RELATION_SCOPE}
        </small>
        <span className="query-relation-picker-chevron" aria-hidden>
          v
        </span>
      </button>
      {open ? (
        <div className="query-relation-picker-panel">
          {props.candidates.map((candidate) => (
            <button
              key={candidate.edgeId}
              type="button"
              data-active={candidate.edgeId === selected?.edgeId ? 'true' : 'false'}
              onClick={() => {
                props.onChange(candidate);
                setOpen(false);
              }}
            >
              <span>{candidate.sourceLabel}</span>
              <strong>{candidate.label}</strong>
              <span>{candidate.targetLabel}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function QueryFilterPredicateEditor(props: {
  filter: QueryFilter;
  fields: readonly ProjectionFieldCandidate[];
  parameters: readonly InterfaceParameter[];
  onUpdate: (patch: Partial<QueryFilter>) => void;
  onRemove: () => void;
}): ReactElement {
  const field = queryFieldCandidateByRef(props.filter, props.fields);
  const operators = filterOperatorsForField(field?.fieldType);
  const requiresValue = !['isNull', 'isNotNull'].includes(props.filter.operator);
  const parameterMode = props.filter.value?.kind === 'parameter';
  const literalValue =
    props.filter.value?.kind === 'literal' ? (props.filter.value.value ?? '') : '';

  const selectField = (next: ProjectionFieldCandidate): void => {
    props.onUpdate({
      target: { nodeId: next.nodeId, modelId: next.modelId, fieldId: next.fieldId },
      operator: filterOperatorsForField(next.fieldType).includes(props.filter.operator)
        ? props.filter.operator
        : 'eq',
    });
  };

  return (
    <div className="query-filter-predicate" data-enabled={props.filter.enabled ? 'true' : 'false'}>
      <div className="query-filter-predicate-main">
        <QueryFieldPicker fields={props.fields} value={field?.key} onChange={selectField} />
        <select
          className="query-filter-operator"
          value={props.filter.operator}
          aria-label="Operator"
          onChange={(event) => {
            const operator = event.target.value as QueryFilterOperator;
            props.onUpdate({
              operator,
              value: ['isNull', 'isNotNull'].includes(operator)
                ? undefined
                : (props.filter.value ?? { kind: 'literal', value: '' }),
            });
          }}
        >
          {operators.map((operator) => (
            <option key={operator} value={operator}>
              {filterOperatorLabel(operator)}
            </option>
          ))}
        </select>
      </div>

      {requiresValue ? (
        <div className="query-filter-predicate-value">
          <div className="query-designer-segment">
            <button
              type="button"
              data-active={!parameterMode ? 'true' : 'false'}
              onClick={() => props.onUpdate({ value: { kind: 'literal', value: '' } })}
            >
              {TEXT_FILTER_LITERAL}
            </button>
            <button
              type="button"
              data-active={parameterMode ? 'true' : 'false'}
              disabled={props.parameters.length === 0}
              onClick={() =>
                props.parameters[0]
                  ? props.onUpdate({
                      value: { kind: 'parameter', parameterId: props.parameters[0].id },
                    })
                  : undefined
              }
            >
              {TEXT_FILTER_PARAMETER}
            </button>
          </div>
          {parameterMode ? (
            <select
              value={props.filter.value?.kind === 'parameter' ? props.filter.value.parameterId : ''}
              aria-label={TEXT_FILTER_PARAMETER}
              onChange={(event) =>
                props.onUpdate({
                  value: { kind: 'parameter', parameterId: event.target.value },
                })
              }
            >
              {props.parameters.map((parameter) => (
                <option key={parameter.id} value={parameter.id}>
                  {parameter.name}
                </option>
              ))}
            </select>
          ) : field?.fieldType === 'boolean' ? (
            <select
              value={String(literalValue)}
              aria-label={TEXT_FILTER_VALUE}
              onChange={(event) =>
                props.onUpdate({
                  value: { kind: 'literal', value: event.target.value === 'true' },
                })
              }
            >
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          ) : (
            <input
              type={literalInputType(field?.fieldType)}
              value={String(literalValue)}
              aria-label={TEXT_FILTER_VALUE}
              placeholder={TEXT_FILTER_VALUE}
              onChange={(event) =>
                props.onUpdate({
                  value: {
                    kind: 'literal',
                    value:
                      field?.fieldType === 'number' && event.target.value !== ''
                        ? Number(event.target.value)
                        : event.target.value,
                  },
                })
              }
            />
          )}
        </div>
      ) : null}

      <div className="query-filter-predicate-actions">
        <label className="query-condition-toggle" title={TEXT_FILTER_ENABLED}>
          <input
            type="checkbox"
            checked={props.filter.enabled}
            onChange={(event) => props.onUpdate({ enabled: event.target.checked })}
          />
          <span>{TEXT_FILTER_ENABLED}</span>
        </label>
        <button type="button" className="query-condition-remove" onClick={props.onRemove}>
          {TEXT_REMOVE}
        </button>
      </div>
    </div>
  );
}

function QueryFieldPicker(props: {
  fields: readonly ProjectionFieldCandidate[];
  value: string | undefined;
  onChange: (field: ProjectionFieldCandidate) => void;
}): ReactElement {
  const selected = props.fields.find((field) => field.key === props.value);
  const [open, setOpen] = useState(false);
  const [scopeNodeId, setScopeNodeId] = useState(selected?.nodeId ?? props.fields[0]?.nodeId ?? '');
  const nodeFields = new Map<string, ProjectionFieldCandidate[]>();
  for (const field of props.fields) {
    const entries = nodeFields.get(field.nodeId) ?? [];
    entries.push(field);
    nodeFields.set(field.nodeId, entries);
  }
  const activeNodeId = nodeFields.has(scopeNodeId)
    ? scopeNodeId
    : (selected?.nodeId ?? props.fields[0]?.nodeId ?? '');

  useEffect(() => {
    if (selected?.nodeId) {
      setScopeNodeId(selected.nodeId);
    }
  }, [selected?.nodeId]);

  return (
    <div className="query-field-picker" data-open={open ? 'true' : 'false'}>
      <button
        type="button"
        className="query-field-picker-trigger"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="query-field-picker-node">{selected?.nodeLabel ?? TEXT_PICK_FIELD}</span>
        <span className="query-field-picker-key">{selected?.fieldKey ?? TEXT_FILTER_FIELD}</span>
        <span className="query-field-picker-chevron" aria-hidden>
          v
        </span>
      </button>
      {open ? (
        <div className="query-field-picker-panel">
          <div className="query-field-picker-scopes" aria-label={TEXT_QUERY_NODE}>
            {[...nodeFields.values()].map((fields) => {
              const first = fields[0];
              return (
                <button
                  key={first.nodeId}
                  type="button"
                  data-active={activeNodeId === first.nodeId ? 'true' : 'false'}
                  onClick={() => setScopeNodeId(first.nodeId)}
                >
                  {first.nodeLabel}
                </button>
              );
            })}
          </div>
          <div className="query-field-picker-fields">
            {(nodeFields.get(activeNodeId) ?? []).map((field) => (
              <DesignerTooltip
                key={field.key}
                content={field.fieldDescription || field.fieldDisplayName || field.fieldKey}
              >
                {(triggerProps) => (
                  <button
                    {...triggerProps}
                    type="button"
                    data-active={field.key === selected?.key ? 'true' : 'false'}
                    onClick={() => {
                      props.onChange(field);
                      setOpen(false);
                    }}
                  >
                    <span className="query-field-picker-field-key">{field.fieldKey}</span>
                    <span className="query-field-picker-field-meta">
                      {field.fieldDisplayName !== field.fieldKey
                        ? field.fieldDisplayName
                        : field.fieldDescription}
                    </span>
                    <span className="query-field-picker-field-type">{field.fieldType}</span>
                  </button>
                )}
              </DesignerTooltip>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function queryFieldCandidateByRef(
  filter: QueryFilter,
  fields: readonly ProjectionFieldCandidate[],
): ProjectionFieldCandidate | undefined {
  if (!('fieldId' in filter.target)) {
    return undefined;
  }
  const target = filter.target;
  return fields.find((field) => field.nodeId === target.nodeId && field.fieldId === target.fieldId);
}

function filterOperatorsForField(
  type: InterfaceValueType | undefined,
): readonly QueryFilterOperator[] {
  if (type === 'boolean') {
    return ['eq', 'neq', 'isNull', 'isNotNull'];
  }
  if (type === 'number' || type === 'date' || type === 'datetime') {
    return ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'notIn', 'isNull', 'isNotNull'];
  }
  if (type === 'json') {
    return ['eq', 'neq', 'contains', 'in', 'notIn', 'isNull', 'isNotNull'];
  }
  return QUERY_FILTER_OPERATORS;
}

function literalInputType(
  type: InterfaceValueType | undefined,
): 'text' | 'number' | 'date' | 'datetime-local' {
  if (type === 'number') {
    return 'number';
  }
  if (type === 'date') {
    return 'date';
  }
  if (type === 'datetime') {
    return 'datetime-local';
  }
  return 'text';
}

function queryAggregationHasContent(aggregation: QueryAggregationSpec): boolean {
  return (
    aggregation.groupBy.length > 0 ||
    aggregation.metrics.length > 0 ||
    Boolean(aggregation.having && queryFilterExpressionCount(aggregation.having) > 0)
  );
}

function createHavingRoot(): QueryFilterGroup {
  return {
    id: 'having_root',
    kind: 'group',
    combinator: 'and',
    enabled: true,
    children: [],
  };
}

function normalizeAggregationOutputName(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, '').replace(/^[^A-Za-z_]+/, '');
}

function uniqueAggregationOutputName(base: string, aggregation: QueryAggregationSpec): string {
  const normalized = normalizeAggregationOutputName(base) || 'value';
  const used = new Set([
    ...aggregation.groupBy.map((group) => group.outputName),
    ...aggregation.metrics.map((metric) => metric.outputName),
  ]);
  if (!used.has(normalized)) {
    return normalized;
  }
  let index = 2;
  while (used.has(`${normalized}_${index}`)) {
    index += 1;
  }
  return `${normalized}_${index}`;
}

function aggregateFunctionsForField(
  type: InterfaceValueType | undefined,
): readonly QueryAggregateMetric['function'][] {
  if (type === 'number') {
    return ['count', 'sum', 'avg', 'min', 'max'];
  }
  return ['count', 'min', 'max'];
}

function aggregateMetricValueType(
  metric: QueryAggregateMetric,
  fields: readonly ProjectionFieldCandidate[],
): InterfaceValueType {
  if (metric.function === 'count' || metric.function === 'sum' || metric.function === 'avg') {
    return 'number';
  }
  return (
    fields.find(
      (field) => field.nodeId === metric.source.nodeId && field.fieldId === metric.source.fieldId,
    )?.fieldType ?? 'string'
  );
}

function isQueryMetricRef(target: QueryFilter['target']): target is QueryMetricRef {
  return 'metricId' in target;
}

function querySortTargetKey(target: QuerySort['target']): string {
  return isQueryMetricRef(target)
    ? `metric:${target.metricId}`
    : `field:${target.nodeId}:${target.fieldId}`;
}

function querySortOptions(
  fields: readonly ProjectionFieldCandidate[],
  aggregation: QueryAggregationSpec,
): Array<{ key: string; label: string; target: QuerySort['target'] }> {
  if (queryAggregationHasContent(aggregation)) {
    return [
      ...aggregation.groupBy.map((group) => ({
        key: querySortTargetKey(group.source),
        label: `${group.outputName} (${TEXT_GROUP_BY})`,
        target: group.source,
      })),
      ...aggregation.metrics.map((metric) => ({
        key: querySortTargetKey({ metricId: metric.id }),
        label: `${metric.outputName} (${metric.function.toUpperCase()})`,
        target: { metricId: metric.id },
      })),
    ];
  }
  return fields.map((field) => ({
    key: querySortTargetKey({
      nodeId: field.nodeId,
      modelId: field.modelId,
      fieldId: field.fieldId,
    }),
    label: `${field.nodeLabel}.${field.fieldKey}`,
    target: { nodeId: field.nodeId, modelId: field.modelId, fieldId: field.fieldId },
  }));
}

function filterOperatorLabel(operator: QueryFilterOperator): string {
  const labels: Record<QueryFilterOperator, string> = {
    eq: '\u7b49\u4e8e (=)',
    neq: '\u4e0d\u7b49\u4e8e (!=)',
    contains: '\u5305\u542b',
    startsWith: '\u5f00\u5934\u4e3a',
    endsWith: '\u7ed3\u5c3e\u4e3a',
    gt: '\u5927\u4e8e (>)',
    gte: '\u5927\u4e8e\u7b49\u4e8e (>=)',
    lt: '\u5c0f\u4e8e (<)',
    lte: '\u5c0f\u4e8e\u7b49\u4e8e (<=)',
    in: '\u5c5e\u4e8e',
    notIn: '\u4e0d\u5c5e\u4e8e',
    isNull: '\u4e3a\u7a7a',
    isNotNull: '\u4e0d\u4e3a\u7a7a',
  };
  return labels[operator];
}

function relationQuantifierLabel(quantifier: QueryRelationFilter['quantifier']): string {
  if (quantifier === 'all') {
    return '\u5168\u90e8\u6ee1\u8db3';
  }
  if (quantifier === 'none') {
    return '\u4e0d\u5b58\u5728';
  }
  return '\u5b58\u5728\u4efb\u610f';
}

function paginationModeLabel(mode: QueryPagination['mode']): string {
  if (mode === 'offset') {
    return TEXT_PAGINATION_OFFSET;
  }
  if (mode === 'cursor') {
    return TEXT_PAGINATION_CURSOR;
  }
  return TEXT_PAGINATION_NONE;
}

function accessPolicyLabel(mode: InterfacePermissionPolicy['mode']): string {
  if (mode === 'key') {
    return '\u4e13\u5c5e\u5bc6\u94a5';
  }
  if (mode === 'disabled') {
    return '\u505c\u7528\u5916\u90e8\u8c03\u7528';
  }
  if (mode === 'role') {
    return '\u89d2\u8272\u7b56\u7565';
  }
  if (mode === 'custom') {
    return '\u81ea\u5b9a\u4e49\u7b56\u7565';
  }
  return '\u8fde\u63a5\u8ba4\u8bc1';
}

interface ProjectionFieldCandidate {
  key: string;
  nodeId: string;
  nodeRole: 'root' | 'primary' | 'branch';
  modelId: string;
  modelKey: string;
  nodeLabel: string;
  fieldId: string;
  modelName: string;
  fieldKey: string;
  fieldDisplayName: string;
  fieldDescription: string;
  fieldType: InterfaceValueType;
  required: boolean;
}

function interfaceStatusLabel(status: QueryInterface['status']): string {
  if (status === 'active') {
    return '\u5df2\u53d1\u5e03';
  }
  if (status === 'deprecated') {
    return '\u5df2\u5f03\u7528';
  }
  if (status === 'archived') {
    return '\u5df2\u5f52\u6863';
  }
  return '\u8349\u7a3f';
}

interface QueryRelationConditionCandidate {
  edgeId: string;
  relationId: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourceLabel: string;
  targetLabel: string;
  label: string;
}

function ProjectionFieldTree(props: {
  candidates: readonly ProjectionFieldCandidate[];
  selectedFieldKeys: readonly string[];
  onSelectedFieldKeysChange: (keys: readonly string[]) => void;
  emptyLabel: string;
}): ReactElement {
  const selected = new Set(props.selectedFieldKeys);
  const groups = new Map<string, ProjectionFieldCandidate[]>();
  for (const candidate of props.candidates) {
    const entries = groups.get(candidate.nodeId) ?? [];
    entries.push(candidate);
    groups.set(candidate.nodeId, entries);
  }

  const toggleField = (key: string): void => {
    const next = new Set(selected);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    props.onSelectedFieldKeysChange([...next]);
  };

  if (groups.size === 0) {
    return <span className="query-designer-empty">{props.emptyLabel}</span>;
  }

  return (
    <div className="query-designer-projection-tree">
      {[...groups.values()].map((fields) => {
        const first = fields[0];
        return (
          <section key={first.nodeId} className="query-designer-projection-model">
            <span className="query-designer-projection-model-name">{first.modelName}</span>
            <div className="query-designer-projection-fields">
              {fields.map((field) => (
                <label key={field.key} className="query-designer-projection-field">
                  <input
                    type="checkbox"
                    checked={selected.has(field.key)}
                    onChange={() => toggleField(field.key)}
                  />
                  <span className="query-designer-projection-field-copy">
                    <span className="query-designer-projection-field-key">{field.fieldKey}</span>
                    {field.required ? (
                      <span className="query-designer-projection-field-required">required</span>
                    ) : null}
                    {field.fieldDisplayName !== field.fieldKey ? (
                      <span className="query-designer-projection-field-name">
                        {field.fieldDisplayName}
                      </span>
                    ) : null}
                    {field.fieldDescription ? (
                      <DesignerTooltip content={field.fieldDescription}>
                        {(triggerProps) => (
                          <span
                            {...triggerProps}
                            className="query-designer-projection-field-description"
                          >
                            {field.fieldDescription}
                          </span>
                        )}
                      </DesignerTooltip>
                    ) : null}
                  </span>
                </label>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

interface QueryResultStructureNode {
  nodeId: string;
  nodeKey: string;
  fields: ReturnType<typeof queryInterfaceFieldDoc>[];
  children: QueryResultStructureChild[];
}

interface QueryResultStructureChild {
  relationName: string;
  cardinality: 'one' | 'many';
  node?: QueryResultStructureNode;
  referenceName?: string;
  truncated?: boolean;
}

function QueryResultStructureTree(props: {
  queryInterface: QueryInterface;
  models: readonly EngineModelNode[];
  relations: readonly EngineRelationEdge[];
  locale: string;
  emptyLabel: string;
}): ReactElement {
  const tree = buildQueryResultStructure(
    props.queryInterface,
    props.models,
    props.relations,
    props.locale,
  );
  if (!tree) {
    return <span className="query-interface-doc-muted">{props.emptyLabel}</span>;
  }

  return (
    <div className="query-interface-result-tree" role="tree" aria-label={TEXT_OUTPUT_FIELDS}>
      <QueryResultStructureNodeView node={tree} depth={0} />
    </div>
  );
}

function QueryResultStructureNodeView(props: {
  node: QueryResultStructureNode;
  depth: number;
  relationName?: string;
  cardinality?: 'one' | 'many';
}): ReactElement {
  const isCollection = props.relationName && props.cardinality === 'many';
  const suffix = isCollection ? ']' : '';

  return (
    <div className="query-interface-result-tree-node" role="treeitem" aria-level={props.depth + 1}>
      <div className="query-interface-result-tree-line" style={{ paddingLeft: props.depth * 14 }}>
        <span className="query-interface-result-tree-model">
          {props.relationName ?? props.node.nodeKey}
        </span>
        <span className="query-interface-result-tree-punctuation">
          {isCollection ? ': [{' : ' {'}
        </span>
      </div>

      {props.node.fields.map((field) => {
        const annotation = [
          field.displayName !== field.fieldKey ? field.displayName : undefined,
          field.description || undefined,
        ]
          .filter((value): value is string => Boolean(value))
          .join(' · ');
        return (
          <div
            key={field.id}
            className="query-interface-result-tree-line query-interface-result-tree-field-line"
            style={{ paddingLeft: (props.depth + 1) * 14 }}
          >
            <DesignerTooltip content={`${field.sourceLabel}${annotation ? `\n${annotation}` : ''}`}>
              {(triggerProps) => (
                <span {...triggerProps} className="query-interface-result-tree-field">
                  {field.fieldKey}
                </span>
              )}
            </DesignerTooltip>
            <span className="query-interface-result-tree-punctuation">: </span>
            <span className="query-interface-result-tree-type">{field.fieldType}</span>
            {field.required ? (
              <span className="query-interface-result-tree-required"> required</span>
            ) : null}
            {annotation ? (
              <DesignerTooltip content={annotation}>
                {(triggerProps) => (
                  <span {...triggerProps} className="query-interface-result-tree-comment">
                    {` // ${annotation}`}
                  </span>
                )}
              </DesignerTooltip>
            ) : null}
          </div>
        );
      })}

      {props.node.children.map((child, index) => {
        if (child.node) {
          return (
            <QueryResultStructureNodeView
              key={`${child.relationName}-${index}`}
              node={child.node}
              depth={props.depth + 1}
              relationName={child.relationName}
              cardinality={child.cardinality}
            />
          );
        }
        return (
          <div
            key={`${child.relationName}-${index}`}
            className="query-interface-result-tree-line query-interface-result-tree-reference"
            style={{ paddingLeft: (props.depth + 1) * 14 }}
          >
            <span>
              {child.truncated
                ? TEXT_RESULT_TREE_TRUNCATED
                : `${TEXT_RESULT_TREE_REFERENCE} ${child.referenceName}`}
            </span>
          </div>
        );
      })}

      <div className="query-interface-result-tree-line" style={{ paddingLeft: props.depth * 14 }}>
        <span className="query-interface-result-tree-punctuation">{`}${suffix}`}</span>
      </div>
    </div>
  );
}

function buildQueryResultStructure(
  queryInterface: QueryInterface,
  models: readonly EngineModelNode[],
  relations: readonly EngineRelationEdge[],
  locale: string,
): QueryResultStructureNode | undefined {
  const nodesById = new Map(queryInterface.designGraph.nodes.map((node) => [node.id, node]));
  const fieldsByNodeId = new Map<string, ReturnType<typeof queryInterfaceFieldDoc>[]>();
  const outputNodeIds = queryResultOutputNodeIds(queryInterface);
  for (const field of queryInterface.query.projection.fields) {
    if (!field.visible || !outputNodeIds.has(field.source.nodeId)) {
      continue;
    }
    const fields = fieldsByNodeId.get(field.source.nodeId) ?? [];
    fields.push(queryInterfaceFieldDoc(field, models, locale));
    fieldsByNodeId.set(field.source.nodeId, fields);
  }

  const outgoing = new Map<string, QueryInterface['designGraph']['edges']>();
  for (const edge of queryInterface.designGraph.edges) {
    if (edge.purpose === 'constraint') {
      continue;
    }
    const entries = outgoing.get(edge.fromNodeId) ?? [];
    entries.push(edge);
    outgoing.set(edge.fromNodeId, entries);
  }

  const visit = (
    nodeId: string,
    path: ReadonlySet<string>,
    depth: number,
  ): QueryResultStructureNode | undefined => {
    const node = nodesById.get(nodeId);
    if (!node) {
      return undefined;
    }
    const nextPath = new Set(path);
    nextPath.add(nodeId);
    const children: QueryResultStructureChild[] = [];
    for (const edge of outgoing.get(nodeId) ?? []) {
      const target = nodesById.get(edge.toNodeId);
      if (!target) {
        continue;
      }
      if (depth >= 5) {
        children.push({
          relationName: resultRelationKey(edge, relations),
          cardinality: edge.cardinality,
          truncated: true,
        });
        continue;
      }
      if (nextPath.has(edge.toNodeId)) {
        children.push({
          relationName: resultRelationKey(edge, relations),
          cardinality: edge.cardinality,
          referenceName: modelKeyById(target.modelId, models),
        });
        continue;
      }
      const child = visit(edge.toNodeId, nextPath, depth + 1);
      if (child) {
        children.push({
          relationName: resultRelationKey(edge, relations),
          cardinality: edge.cardinality,
          node: child,
        });
      }
    }
    return {
      nodeId,
      nodeKey: modelKeyById(node.modelId, models),
      fields: fieldsByNodeId.get(nodeId) ?? [],
      children,
    };
  };

  return visit(queryInterface.designGraph.rootNodeId, new Set(), 0);
}

function queryResultOutputNodeIds(queryInterface: QueryInterface): ReadonlySet<string> {
  const rootNodeId = queryInterface.designGraph.rootNodeId;
  const outputNodeIds = new Set<string>([rootNodeId]);
  const pendingNodeIds = [rootNodeId];
  const outgoing = new Map<string, QueryInterface['designGraph']['edges']>();
  for (const edge of queryInterface.designGraph.edges) {
    if (edge.purpose === 'constraint') {
      continue;
    }
    const entries = outgoing.get(edge.fromNodeId) ?? [];
    entries.push(edge);
    outgoing.set(edge.fromNodeId, entries);
  }
  while (pendingNodeIds.length > 0) {
    const nodeId = pendingNodeIds.shift();
    if (!nodeId) {
      continue;
    }
    for (const edge of outgoing.get(nodeId) ?? []) {
      if (!outputNodeIds.has(edge.toNodeId)) {
        outputNodeIds.add(edge.toNodeId);
        pendingNodeIds.push(edge.toNodeId);
      }
    }
  }
  return outputNodeIds;
}

function formatInterfaceTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleDateString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function QueryEdgeEditor(props: {
  edge: QueryGraphEdgeState;
  relation: EngineRelationEdge;
  models: readonly EngineModelNode[];
}): ReactElement {
  const sourceModelId = queryEdgeSourceModelId(
    props.relation,
    props.edge.direction,
    props.edge.usage,
  );
  const targetModelId = queryEdgeTargetModelId(props.relation, props.edge.direction);
  const sourceName = modelNameById(sourceModelId, props.models);
  const targetName = modelNameById(targetModelId, props.models);
  const inherited =
    props.edge.usage?.kind === 'inherited'
      ? `${TEXT_INHERITED_FROM} ${modelNameById(props.edge.usage.ownerModelId, props.models)}`
      : undefined;

  return (
    <div className="query-designer-edge-editor">
      <div className="query-designer-edge-editor-main">
        <DesignerTooltip content={`${sourceName} -> ${targetName}`}>
          {(triggerProps) => (
            <span {...triggerProps} className="query-designer-edge-editor-title">
              {sourceName}
              {' -> '}
              {targetName}
            </span>
          )}
        </DesignerTooltip>
        <DesignerTooltip content={relationLabel(props.relation, props.edge.direction)}>
          {(triggerProps) => (
            <span {...triggerProps} className="query-designer-edge-editor-subtitle">
              {relationLabel(props.relation, props.edge.direction)}
              {inherited ? ` / ${inherited}` : ''}
            </span>
          )}
        </DesignerTooltip>
      </div>
      <span className="query-designer-edge-editor-hint">{TEXT_REWIRE_HINT}</span>
    </div>
  );
}

function QueryGraphPreview(props: {
  models: readonly EngineModelNode[];
  relationViews: readonly {
    edge: QueryGraphEdgeState;
    relation: EngineRelationEdge;
  }[];
  graphInstances: QueryGraphInstances;
  rootModelId: string | undefined;
  emptyLabel: string;
  inheritedLabel: (name: string) => string;
  onRemoveNode: (nodeId: string) => void;
  onRemoveEdge: (edge: Pick<QueryGraphEdgeState, 'relationId' | 'direction' | 'key'>) => void;
  selectableNodeIds?: ReadonlySet<string>;
  onSelectNode?: (nodeId: string) => void;
  readOnly?: boolean;
  allowFullscreen?: boolean;
}): ReactElement {
  const markerId = useId().replace(/:/g, '');
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [fullscreen, setFullscreen] = useState(false);
  const graph = useMemo(
    () =>
      buildPreviewGraph({
        models: props.models,
        relationViews: props.relationViews,
        graphInstances: props.graphInstances,
        rootModelId: props.rootModelId,
        inheritedLabel: props.inheritedLabel,
      }),
    [
      props.graphInstances,
      props.inheritedLabel,
      props.models,
      props.relationViews,
      props.rootModelId,
    ],
  );

  useEffect(() => {
    if (!fullscreen) {
      return;
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setFullscreen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [fullscreen]);

  const setNextZoom = (nextZoom: number): void => {
    setZoom(clamp(nextZoom, 0.35, 3.5));
  };

  const fitView = (): void => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const graphSurface = (variant: 'panel' | 'fullscreen'): ReactElement => (
    <QueryGraphPreviewSurface
      graph={graph}
      markerId={`${markerId}-${variant}`}
      zoom={zoom}
      pan={pan}
      onPanChange={setPan}
      onZoomChange={(nextZoom, nextPan) => {
        setZoom(nextZoom);
        setPan(nextPan);
      }}
      onRemoveNode={props.onRemoveNode}
      onRemoveEdge={props.onRemoveEdge}
      selectableNodeIds={props.selectableNodeIds}
      onSelectNode={props.onSelectNode}
      readOnly={props.readOnly}
      emptyLabel={props.emptyLabel}
      variant={variant}
    />
  );

  if (graph.nodes.length === 0) {
    return (
      <div className="query-designer-graph-preview" data-empty="true">
        <span className="query-designer-empty">{props.emptyLabel}</span>
      </div>
    );
  }

  const fullscreenDialog =
    fullscreen && typeof document !== 'undefined'
      ? createPortal(
          <div className="query-designer-graph-dialog" role="dialog" aria-modal="true">
            <button
              type="button"
              className="query-designer-graph-dialog-backdrop"
              aria-label="Close query graph preview"
              onClick={() => setFullscreen(false)}
            />
            <div className="query-designer-graph-dialog-body">
              <div className="query-designer-graph-dialog-bar">
                <span>{props.emptyLabel}</span>
                <div className="query-designer-graph-dialog-actions">
                  <button type="button" title="Zoom out" onClick={() => setNextZoom(zoom - 0.15)}>
                    -
                  </button>
                  <button type="button" title="Fit view" onClick={fitView}>
                    {Math.round(zoom * 100)}%
                  </button>
                  <button type="button" title="Zoom in" onClick={() => setNextZoom(zoom + 0.15)}>
                    +
                  </button>
                  <button type="button" title="Close" onClick={() => setFullscreen(false)}>
                    x
                  </button>
                </div>
              </div>
              <div className="query-designer-graph-fullscreen-stage">
                {graphSurface('fullscreen')}
              </div>
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <div className="query-designer-graph-preview">
        <div className="query-designer-graph-toolbar" aria-label="Query graph preview controls">
          <button type="button" title="Zoom out" onClick={() => setNextZoom(zoom - 0.15)}>
            -
          </button>
          <button type="button" title="Fit view" onClick={fitView}>
            1:1
          </button>
          <button type="button" title="Zoom in" onClick={() => setNextZoom(zoom + 0.15)}>
            +
          </button>
          {props.allowFullscreen !== false ? (
            <button type="button" title="Fullscreen" onClick={() => setFullscreen(true)}>
              []
            </button>
          ) : null}
        </div>
        <div className="query-designer-graph-zoom">{Math.round(zoom * 100)}%</div>
        {graphSurface('panel')}
      </div>
      {fullscreenDialog}
    </>
  );
}

function QueryRelationSourcePicker(props: {
  relationId: string;
  candidates: readonly QueryRelationPickCandidate[];
  graphInstances: QueryGraphInstances;
  models: readonly EngineModelNode[];
  relations: readonly EngineRelationEdge[];
  onSelect: (sourceNodeId: string) => void;
  onSelectAll: () => void;
  onCancel: () => void;
}): ReactElement | null {
  const relation = props.relations.find((item) => item.id === props.relationId);
  const candidateNodeIds = useMemo(
    () => new Set(props.candidates.map((candidate) => candidate.sourceNodeId)),
    [props.candidates],
  );
  const relationViews = useMemo(
    () =>
      props.graphInstances.edges.flatMap((edge) => {
        const item = props.relations.find((relation) => relation.id === edge.relationId);
        return item ? [{ edge, relation: item }] : [];
      }),
    [props.graphInstances.edges, props.relations],
  );
  const rootModelId = props.graphInstances.rootNodeId
    ? props.graphInstances.nodes.find((node) => node.id === props.graphInstances.rootNodeId)
        ?.modelId
    : undefined;
  if (!relation || props.candidates.length === 0 || typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div className="query-relation-source-dialog" role="dialog" aria-modal="true">
      <button
        type="button"
        className="query-relation-source-dialog-backdrop"
        aria-label={TEXT_CANCEL_RENAME}
        onClick={props.onCancel}
      />
      <div className="query-relation-source-dialog-body">
        <div className="query-relation-source-dialog-header">
          <div>
            <span className="query-relation-source-dialog-title">{TEXT_RELATION_SOURCE_TITLE}</span>
            <span className="query-relation-source-dialog-hint">
              {`${relationLabel(relation)} · ${TEXT_RELATION_SOURCE_HINT}`}
            </span>
          </div>
          <button
            type="button"
            className="query-relation-source-dialog-close"
            onClick={props.onCancel}
          >
            x
          </button>
        </div>
        <div className="query-relation-source-dialog-stage">
          <QueryGraphPreview
            models={props.models}
            relationViews={relationViews}
            graphInstances={props.graphInstances}
            rootModelId={rootModelId}
            emptyLabel={TEXT_RELATION_SOURCE_TITLE}
            inheritedLabel={(name) => `${TEXT_INHERITED_FROM}${name}`}
            onRemoveNode={() => undefined}
            onRemoveEdge={() => undefined}
            selectableNodeIds={candidateNodeIds}
            onSelectNode={props.onSelect}
            readOnly
            allowFullscreen={false}
          />
        </div>
        <div className="query-relation-source-dialog-actions">
          <button type="button" className="query-designer-button" onClick={props.onSelectAll}>
            {TEXT_RELATION_SOURCE_ALL}
          </button>
          <button type="button" className="query-designer-button" onClick={props.onCancel}>
            {TEXT_CANCEL_RENAME}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function QueryModelSourcePicker(props: {
  modelId: string;
  candidates: readonly QueryModelPickCandidate[];
  graphInstances: QueryGraphInstances;
  models: readonly EngineModelNode[];
  relations: readonly EngineRelationEdge[];
  onSelect: (candidate: QueryModelPickCandidate) => void;
  onSelectAll: () => void;
  onCancel: () => void;
}): ReactElement | null {
  const candidateNodeIds = useMemo(
    () => new Set(props.candidates.map((candidate) => candidate.sourceNodeId)),
    [props.candidates],
  );
  const relationViews = useMemo(
    () =>
      props.graphInstances.edges.flatMap((edge) => {
        const relation = props.relations.find((item) => item.id === edge.relationId);
        return relation ? [{ edge, relation }] : [];
      }),
    [props.graphInstances.edges, props.relations],
  );
  const rootModelId = props.graphInstances.rootNodeId
    ? props.graphInstances.nodes.find((node) => node.id === props.graphInstances.rootNodeId)
        ?.modelId
    : undefined;
  const targetModel = props.models.find((model) => model.id === props.modelId);
  if (props.candidates.length === 0 || typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div className="query-relation-source-dialog" role="dialog" aria-modal="true">
      <button
        type="button"
        className="query-relation-source-dialog-backdrop"
        aria-label={TEXT_CANCEL_RENAME}
        onClick={props.onCancel}
      />
      <div className="query-relation-source-dialog-body">
        <div className="query-relation-source-dialog-header">
          <div>
            <span className="query-relation-source-dialog-title">{TEXT_MODEL_SOURCE_TITLE}</span>
            <span className="query-relation-source-dialog-hint">
              {`${targetModel ? modelLabel(targetModel) : props.modelId} · ${TEXT_MODEL_SOURCE_HINT}`}
            </span>
          </div>
          <button
            type="button"
            className="query-relation-source-dialog-close"
            onClick={props.onCancel}
          >
            x
          </button>
        </div>
        <div className="query-relation-source-dialog-stage">
          <QueryGraphPreview
            models={props.models}
            relationViews={relationViews}
            graphInstances={props.graphInstances}
            rootModelId={rootModelId}
            emptyLabel={TEXT_MODEL_SOURCE_TITLE}
            inheritedLabel={(name) => `${TEXT_INHERITED_FROM}${name}`}
            onRemoveNode={() => undefined}
            onRemoveEdge={() => undefined}
            selectableNodeIds={candidateNodeIds}
            onSelectNode={(sourceNodeId) => {
              const candidate = props.candidates.find((item) => item.sourceNodeId === sourceNodeId);
              if (candidate) {
                props.onSelect(candidate);
              }
            }}
            readOnly
            allowFullscreen={false}
          />
        </div>
        <div className="query-relation-source-dialog-actions">
          <button type="button" className="query-designer-button" onClick={props.onSelectAll}>
            {TEXT_RELATION_SOURCE_ALL}
          </button>
          <button type="button" className="query-designer-button" onClick={props.onCancel}>
            {TEXT_CANCEL_RENAME}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

interface PreviewGraphNode {
  id: string;
  x: number;
  y: number;
  radius: number;
  label: string;
  fullLabel: string;
  kind: 'root' | 'primary' | 'branch';
}

interface PreviewGraphEdge {
  id: string;
  role: QueryGraphEdgeRole;
  path: string;
  label: string;
  labelX: number;
  labelY: number;
  inherited: string | undefined;
  sourceNodeId: string;
  targetNodeId: string;
  key: string;
  relationId: string;
  direction: QueryGraphEdgeDirection;
}

interface PreviewGraph {
  nodes: PreviewGraphNode[];
  edges: PreviewGraphEdge[];
  bounds: { x: number; y: number; width: number; height: number };
}

type QueryPreviewHitTarget =
  | { kind: 'model'; id: string; key: string }
  | {
      kind: 'edge';
      relationId: string;
      direction: QueryGraphEdgeDirection;
      edgeKey: string;
      key: string;
    };

function QueryGraphPreviewSurface(props: {
  graph: PreviewGraph;
  markerId: string;
  zoom: number;
  pan: { x: number; y: number };
  onPanChange: (pan: { x: number; y: number }) => void;
  onZoomChange: (zoom: number, pan: { x: number; y: number }) => void;
  onRemoveNode: (nodeId: string) => void;
  onRemoveEdge: (edge: Pick<QueryGraphEdgeState, 'relationId' | 'direction' | 'key'>) => void;
  selectableNodeIds?: ReadonlySet<string>;
  onSelectNode?: (nodeId: string) => void;
  readOnly?: boolean;
  emptyLabel: string;
  variant: 'panel' | 'fullscreen';
}): ReactElement {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<
    | {
        pointerId: number;
        clientX: number;
        clientY: number;
        pan: { x: number; y: number };
        moved: boolean;
        target: QueryPreviewHitTarget | undefined;
      }
    | undefined
  >(undefined);
  const lastTapRef = useRef<{ key: string; time: number } | undefined>(undefined);
  const [isDragging, setIsDragging] = useState(false);
  const viewBox = previewViewBox(props.graph.bounds, props.zoom, props.pan);
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) {
      return;
    }
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      const rect = svg.getBoundingClientRect();
      const ratioX = (event.clientX - rect.left) / rect.width;
      const ratioY = (event.clientY - rect.top) / rect.height;
      const worldX = viewBox.x + ratioX * viewBox.width;
      const worldY = viewBox.y + ratioY * viewBox.height;
      const nextZoom = clamp(props.zoom * (event.deltaY > 0 ? 0.9 : 1.1), 0.35, 3.5);
      const nextBaseViewBox = previewViewBox(props.graph.bounds, nextZoom, { x: 0, y: 0 });
      const nextWidth = props.graph.bounds.width / nextZoom;
      const nextHeight = props.graph.bounds.height / nextZoom;
      props.onZoomChange(nextZoom, {
        x: worldX - ratioX * nextWidth - nextBaseViewBox.x,
        y: worldY - ratioY * nextHeight - nextBaseViewBox.y,
      });
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [props, viewBox]);

  const handlePointerDown = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (event.button !== 0) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const target = queryPreviewHitTarget(event.target);
    dragRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      pan: props.pan,
      moved: false,
      target,
    };
    setIsDragging(true);
  };
  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>): void => {
    const drag = dragRef.current;
    const svg = svgRef.current;
    if (!drag || !svg) {
      return;
    }
    if (Math.hypot(event.clientX - drag.clientX, event.clientY - drag.clientY) > 4) {
      drag.moved = true;
    }
    const rect = svg.getBoundingClientRect();
    const deltaX = ((event.clientX - drag.clientX) / rect.width) * viewBox.width;
    const deltaY = ((event.clientY - drag.clientY) / rect.height) * viewBox.height;
    props.onPanChange({
      x: drag.pan.x - deltaX,
      y: drag.pan.y - deltaY,
    });
  };
  const stopDragging = (event: ReactPointerEvent<SVGSVGElement>): void => {
    const drag = dragRef.current;
    if (drag?.pointerId === event.pointerId) {
      dragRef.current = undefined;
      setIsDragging(false);
      if (!drag.moved && drag.target) {
        if (
          drag.target.kind === 'model' &&
          props.selectableNodeIds?.has(drag.target.id) &&
          props.onSelectNode
        ) {
          props.onSelectNode(drag.target.id);
          return;
        }
        if (props.readOnly) {
          return;
        }
        const now = window.performance.now();
        const previous = lastTapRef.current;
        if (previous && previous.key === drag.target.key && now - previous.time < 320) {
          lastTapRef.current = undefined;
          if (drag.target.kind === 'model') {
            props.onRemoveNode(drag.target.id);
          } else {
            props.onRemoveEdge({
              relationId: drag.target.relationId,
              direction: drag.target.direction,
              key: drag.target.edgeKey,
            });
          }
          return;
        }
        lastTapRef.current = { key: drag.target.key, time: now };
      }
    }
  };
  return (
    <svg
      ref={svgRef}
      className="query-designer-graph-svg"
      data-variant={props.variant}
      data-dragging={isDragging ? 'true' : 'false'}
      data-source-selecting={props.selectableNodeIds ? 'true' : 'false'}
      viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
      role="img"
      aria-label={props.emptyLabel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={stopDragging}
      onPointerCancel={stopDragging}
    >
      <defs>
        {(['primary', 'branch', 'constraint'] as const).map((role) => (
          <marker
            key={role}
            id={`${props.markerId}-${role}`}
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path
              className={`query-designer-graph-arrow query-designer-graph-arrow-${role}`}
              d="M 0 0 L 8 4 L 0 8 z"
            />
          </marker>
        ))}
      </defs>
      <rect
        className="query-designer-graph-canvas"
        x={props.graph.bounds.x}
        y={props.graph.bounds.y}
        width={props.graph.bounds.width}
        height={props.graph.bounds.height}
        rx="18"
      />
      <g className="query-designer-graph-grid" aria-hidden="true">
        {gridLines(props.graph.bounds, 80).map((line) => (
          <path key={line.key} d={line.path} />
        ))}
      </g>
      <g>
        {props.graph.edges.map((edge) => (
          <g
            key={edge.id}
            data-query-preview-relation-id={edge.relationId}
            data-query-preview-direction={edge.direction}
            data-query-preview-relation-key={edge.key}
          >
            <path
              className="query-designer-graph-edge-hit"
              d={edge.path}
              data-query-preview-relation-id={edge.relationId}
              data-query-preview-direction={edge.direction}
              data-query-preview-relation-key={edge.key}
            />
            <path
              className={`query-designer-graph-edge query-designer-graph-edge-${edge.role}`}
              d={edge.path}
              markerEnd={`url(#${props.markerId}-${edge.role})`}
            />
            <DesignerTooltip content={edge.label}>
              {(triggerProps) => (
                <g
                  {...triggerProps}
                  className={`query-designer-graph-edge-label query-designer-graph-edge-label-${edge.role}`}
                  transform={`translate(${edge.labelX} ${edge.labelY})`}
                  data-query-preview-relation-id={edge.relationId}
                  data-query-preview-direction={edge.direction}
                  data-query-preview-relation-key={edge.key}
                >
                  <rect x="-54" y="-11" width="108" height="20" rx="10" />
                  <text y="4">{compactPreviewLabel(edge.label)}</text>
                </g>
              )}
            </DesignerTooltip>
            {edge.inherited ? (
              <DesignerTooltip content={edge.inherited}>
                {(triggerProps) => (
                  <text
                    {...triggerProps}
                    className="query-designer-graph-edge-note"
                    x={edge.labelX}
                    y={edge.labelY + 23}
                  >
                    {edge.inherited}
                  </text>
                )}
              </DesignerTooltip>
            ) : null}
          </g>
        ))}
      </g>
      <g>
        {props.graph.nodes.map((node) => (
          <DesignerTooltip key={node.id} content={node.fullLabel}>
            {(triggerProps) => (
              <g
                {...triggerProps}
                className="query-designer-graph-node"
                data-kind={node.kind}
                data-source-candidate={props.selectableNodeIds?.has(node.id) ? 'true' : 'false'}
                data-query-preview-model-id={node.id}
                transform={`translate(${node.x} ${node.y})`}
              >
                <circle className="query-designer-graph-node-shell" r={node.radius} />
                <circle className="query-designer-graph-node-core" r="8" cy="-16" />
                <text className="query-designer-graph-node-title" y="8">
                  {node.label}
                </text>
                <path className="query-designer-graph-node-field" d="M -24 22 H 24" />
                <path className="query-designer-graph-node-field" d="M -17 32 H 17" />
              </g>
            )}
          </DesignerTooltip>
        ))}
      </g>
      <rect
        className="query-designer-graph-viewport"
        x={viewBox.x + 8}
        y={viewBox.y + 8}
        width={viewBox.width - 16}
        height={viewBox.height - 16}
        rx="14"
      />
    </svg>
  );
}

function buildPreviewGraph(input: {
  models: readonly EngineModelNode[];
  relationViews: readonly {
    edge: QueryGraphEdgeState;
    relation: EngineRelationEdge;
  }[];
  graphInstances: QueryGraphInstances;
  rootModelId: string | undefined;
  inheritedLabel: (name: string) => string;
}): PreviewGraph {
  const nodeRadius = 46;
  const primaryGap = 320;
  const treeLeafGap = 290;
  const positions = new Map<string, { x: number; y: number }>();
  const orderedPrimaryNodeIds =
    input.graphInstances.primaryPathNodeIds.length > 0
      ? input.graphInstances.primaryPathNodeIds
      : input.graphInstances.rootNodeId
        ? [input.graphInstances.rootNodeId]
        : [];
  const relationById = new Map(
    input.relationViews.map((item) => [item.relation.id, item.relation]),
  );
  const nodeById = new Map(input.graphInstances.nodes.map((node) => [node.id, node]));
  const nodeIds = new Set(input.graphInstances.nodes.map((node) => node.id));
  const edgeEndpoints = input.graphInstances.edges
    .map((edge) => {
      const relation = relationById.get(edge.relationId);
      return relation ? { edge, relation } : undefined;
    })
    .filter((edge): edge is { edge: QueryGraphEdgeInstance; relation: EngineRelationEdge } =>
      Boolean(edge),
    );

  edgeEndpoints.forEach(({ edge }) => {
    nodeIds.add(edge.sourceNodeId);
    nodeIds.add(edge.targetNodeId);
  });

  const traversalChildren = new Map<string, QueryGraphEdgeInstance[]>();
  for (const { edge } of edgeEndpoints) {
    if (edge.role === 'constraint') {
      continue;
    }
    const entries = traversalChildren.get(edge.sourceNodeId) ?? [];
    entries.push(edge);
    traversalChildren.set(edge.sourceNodeId, entries);
  }

  let nextLeafY = 0;
  const placeTreeNode = (nodeId: string, depth: number, ancestors: ReadonlySet<string>): number => {
    const existing = positions.get(nodeId);
    if (existing) {
      return existing.y;
    }
    positions.set(nodeId, { x: depth * primaryGap, y: 0 });
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(nodeId);
    const children = (traversalChildren.get(nodeId) ?? []).filter(
      (edge) => !nextAncestors.has(edge.targetNodeId),
    );
    if (children.length === 0) {
      const leafY = nextLeafY;
      nextLeafY += treeLeafGap;
      positions.set(nodeId, { x: depth * primaryGap, y: leafY });
      return leafY;
    }
    const childYs = children.map((edge) =>
      placeTreeNode(edge.targetNodeId, depth + 1, nextAncestors),
    );
    const y = childYs.reduce((total, value) => total + value, 0) / childYs.length;
    positions.set(nodeId, { x: depth * primaryGap, y });
    return y;
  };

  const rootNodeId = input.graphInstances.rootNodeId;
  const rootY = rootNodeId ? placeTreeNode(rootNodeId, 0, new Set()) : 0;
  if (rootY !== 0) {
    for (const position of positions.values()) {
      position.y -= rootY;
    }
  }

  Array.from(nodeIds).forEach((nodeId, index) => {
    if (positions.has(nodeId)) {
      return;
    }
    positions.set(nodeId, {
      x: (index % 3) * primaryGap,
      y: treeLeafGap + Math.floor(index / 3) * treeLeafGap,
    });
  });

  resolvePreviewNodeCollisions(
    positions,
    Array.from(nodeIds),
    rootNodeId ? new Set([rootNodeId]) : new Set(),
    184,
  );

  const nodes = Array.from(nodeIds)
    .map((nodeId) => {
      const position = positions.get(nodeId);
      const instance = nodeById.get(nodeId);
      if (!instance) {
        return undefined;
      }
      const modelName = modelNameById(instance.modelId, input.models);
      const fullLabel =
        instance.alias === instance.modelId
          ? modelName
          : instance.alias.replace(instance.modelId, modelName);
      return position
        ? {
            id: nodeId,
            x: position.x,
            y: position.y,
            radius: nodeRadius,
            label: compactPreviewLabel(fullLabel),
            fullLabel,
            kind:
              input.graphInstances.rootNodeId === nodeId
                ? 'root'
                : orderedPrimaryNodeIds.includes(nodeId)
                  ? 'primary'
                  : 'branch',
          }
        : undefined;
    })
    .filter((node): node is PreviewGraphNode => Boolean(node));

  const edges = edgeEndpoints
    .map(({ edge, relation }, index) => {
      const source = positions.get(edge.sourceNodeId);
      const target = positions.get(edge.targetNodeId);
      if (!source || !target) {
        return undefined;
      }
      const sourceAnchor = edgeAnchor(source, target, nodeRadius);
      const targetAnchor = edgeAnchor(target, source, nodeRadius);
      const path = curvedPreviewPath(sourceAnchor, targetAnchor, edge.role, index);
      return {
        id: `${edge.role}-${edge.direction}-${relation.id}-${index}`,
        role: edge.role,
        path,
        label: relationLabel(relation, edge.direction),
        labelX: (sourceAnchor.x + targetAnchor.x) / 2,
        labelY: (sourceAnchor.y + targetAnchor.y) / 2 - 10,
        inherited:
          edge.usage?.kind === 'inherited'
            ? input.inheritedLabel(modelNameById(edge.usage.ownerModelId, input.models))
            : undefined,
        sourceNodeId: edge.sourceNodeId,
        targetNodeId: edge.targetNodeId,
        key: edge.key,
        relationId: relation.id,
        direction: edge.direction,
      };
    })
    .filter((edge): edge is PreviewGraphEdge => Boolean(edge));

  return { nodes, edges, bounds: previewBounds(nodes) };
}

function queryPreviewHitTarget(target: EventTarget | null): QueryPreviewHitTarget | undefined {
  if (!(target instanceof Element)) {
    return undefined;
  }
  const modelElement = target.closest('[data-query-preview-model-id]');
  if (modelElement) {
    const id = modelElement.getAttribute('data-query-preview-model-id');
    return id ? { kind: 'model', id, key: `model:${id}` } : undefined;
  }
  const edgeElement = target.closest('[data-query-preview-relation-id]');
  if (edgeElement) {
    const relationId = edgeElement.getAttribute('data-query-preview-relation-id');
    const direction = edgeElement.getAttribute('data-query-preview-direction');
    const edgeKey = edgeElement.getAttribute('data-query-preview-relation-key');
    if (relationId && edgeKey && (direction === 'forward' || direction === 'reverse')) {
      return {
        kind: 'edge',
        relationId,
        direction,
        edgeKey,
        key: `edge:${edgeKey}`,
      };
    }
  }
  return undefined;
}

function compactPreviewLabel(label: string): string {
  return label.length > 10 ? `${label.slice(0, 10)}...` : label;
}

function resolvePreviewNodeCollisions(
  positions: Map<string, { x: number; y: number }>,
  nodeIds: readonly string[],
  lockedNodeIds: ReadonlySet<string>,
  minDistance: number,
): void {
  for (let pass = 0; pass < 10; pass += 1) {
    for (let i = 0; i < nodeIds.length; i += 1) {
      for (let j = i + 1; j < nodeIds.length; j += 1) {
        const aId = nodeIds[i];
        const bId = nodeIds[j];
        const a = positions.get(aId);
        const b = positions.get(bId);
        if (!a || !b) {
          continue;
        }
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.hypot(dx, dy);
        if (distance >= minDistance) {
          continue;
        }
        const overlap = (minDistance - distance) / 2 + 4;
        const nx = distance === 0 ? 0 : dx / distance;
        const ny = distance === 0 ? (j % 2 === 0 ? 1 : -1) : dy / distance;
        const aLocked = lockedNodeIds.has(aId);
        const bLocked = lockedNodeIds.has(bId);
        if (aLocked && bLocked) {
          continue;
        }
        if (aLocked) {
          b.x += nx * overlap * 2;
          b.y += ny * overlap * 2;
          continue;
        }
        if (bLocked) {
          a.x -= nx * overlap * 2;
          a.y -= ny * overlap * 2;
          continue;
        }
        a.x -= nx * overlap;
        a.y -= ny * overlap;
        b.x += nx * overlap;
        b.y += ny * overlap;
      }
    }
  }
}

function queryEdgeSourceModelId(
  relation: EngineRelationEdge,
  direction: QueryGraphEdgeDirection,
  usage?: QueryGraphRelationUsage,
): string {
  if (usage?.kind === 'inherited') {
    return usage.childModelId;
  }
  return direction === 'forward' ? relation.source_model_id : relation.target_model_id;
}

function queryEdgeTargetModelId(
  relation: EngineRelationEdge,
  direction: QueryGraphEdgeDirection,
): string {
  return direction === 'forward' ? relation.target_model_id : relation.source_model_id;
}

function curvedPreviewPath(
  source: { x: number; y: number },
  target: { x: number; y: number },
  role: QueryGraphEdgeRole,
  index: number,
): string {
  const bend = role === 'constraint' ? -54 : 34 + (index % 2) * 14;
  const midX = (source.x + target.x) / 2;
  const midY = (source.y + target.y) / 2 + bend;
  return `M ${source.x} ${source.y} Q ${midX} ${midY} ${target.x} ${target.y}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function edgeAnchor(
  from: { x: number; y: number },
  to: { x: number; y: number },
  radius: number,
): { x: number; y: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy) || 1;
  return {
    x: from.x + (dx / distance) * radius,
    y: from.y + (dy / distance) * radius,
  };
}

function previewBounds(nodes: readonly PreviewGraphNode[]): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  if (nodes.length === 0) {
    return { x: -80, y: -60, width: 320, height: 190 };
  }
  const padding = 132;
  const minX = Math.min(...nodes.map((node) => node.x - node.radius)) - padding;
  const minY = Math.min(...nodes.map((node) => node.y - node.radius)) - padding;
  const maxX = Math.max(...nodes.map((node) => node.x + node.radius)) + padding;
  const maxY = Math.max(...nodes.map((node) => node.y + node.radius)) + padding;
  return {
    x: minX,
    y: minY,
    width: Math.max(maxX - minX, 360),
    height: Math.max(maxY - minY, 220),
  };
}

function previewViewBox(
  bounds: { x: number; y: number; width: number; height: number },
  zoom: number,
  pan: { x: number; y: number },
): { x: number; y: number; width: number; height: number } {
  const width = bounds.width / zoom;
  const height = bounds.height / zoom;
  return {
    x: bounds.x + (bounds.width - width) / 2 + pan.x,
    y: bounds.y + (bounds.height - height) / 2 + pan.y,
    width,
    height,
  };
}

function gridLines(
  bounds: { x: number; y: number; width: number; height: number },
  step: number,
): { key: string; path: string }[] {
  const lines: { key: string; path: string }[] = [];
  const startX = Math.floor(bounds.x / step) * step;
  const endX = bounds.x + bounds.width;
  const startY = Math.floor(bounds.y / step) * step;
  const endY = bounds.y + bounds.height;
  for (let x = startX; x <= endX; x += step) {
    lines.push({ key: `v-${x}`, path: `M ${x} ${bounds.y} V ${endY}` });
  }
  for (let y = startY; y <= endY; y += step) {
    lines.push({ key: `h-${y}`, path: `M ${bounds.x} ${y} H ${endX}` });
  }
  return lines;
}

function QueryPathNode(props: { model: EngineModelNode }): ReactElement {
  return <span className="query-designer-path-node">{modelLabel(props.model)}</span>;
}

function modelLabel(model: EngineModelNode): string {
  return model.name_i18n?.zh || model.name_i18n?.en || model.model_name || model.id;
}

function relationLabel(
  relation: EngineRelationEdge,
  direction: QueryGraphEdgeDirection = 'forward',
): string {
  if (direction === 'reverse') {
    return (
      relation.reverse_name_i18n?.zh ||
      relation.reverse_name_i18n?.en ||
      relation.reverse_name ||
      relation.engine_reverse_name ||
      relation.id
    );
  }
  return (
    relation.forward_name_i18n?.zh ||
    relation.forward_name_i18n?.en ||
    relation.forward_name ||
    relation.engine_forward_name ||
    relation.id
  );
}

function relationEndpointLabel(
  relation: EngineRelationEdge,
  direction: 'forward' | 'reverse',
  models: readonly EngineModelNode[],
  usage?: QueryGraphRelationUsage,
  inheritedLabel?: (name: string) => string,
): string {
  const sourceModelId =
    usage?.kind === 'inherited'
      ? usage.childModelId
      : direction === 'forward'
        ? relation.source_model_id
        : relation.target_model_id;
  const targetModelId =
    direction === 'forward' ? relation.target_model_id : relation.source_model_id;
  const source = models.find((model) => model.id === sourceModelId);
  const target = models.find((model) => model.id === targetModelId);
  const inherited =
    usage?.kind === 'inherited' && inheritedLabel
      ? ` 璺?${inheritedLabel(modelNameById(usage.ownerModelId, models))}`
      : '';
  return `${source ? modelLabel(source) : sourceModelId} -> ${target ? modelLabel(target) : targetModelId}${inherited}`;
}

function modelNameById(modelId: string, models: readonly EngineModelNode[]): string {
  const model = models.find((item) => item.id === modelId);
  return model ? modelLabel(model) : modelId;
}

function modelKeyById(modelId: string, models: readonly EngineModelNode[]): string {
  const model = models.find((item) => item.id === modelId);
  return model?.model_name || modelId;
}

function resultRelationKey(
  edge: QueryInterface['designGraph']['edges'][number],
  relations: readonly EngineRelationEdge[],
): string {
  const relation = relations.find((item) => item.id === edge.relationId);
  if (!relation) {
    return edge.alias;
  }
  if (edge.traversal === 'reverse') {
    return relation.engine_reverse_name ?? relation.reverse_name ?? edge.alias;
  }
  return relation.engine_forward_name ?? relation.forward_name ?? edge.alias;
}

function buildProjectionFieldCandidates(
  nodes: readonly QueryGraphInstances['nodes'][number][],
  models: readonly EngineModelNode[],
  locale: string,
): ProjectionFieldCandidate[] {
  const modelsById = new Map(models.map((model) => [model.id, model]));
  return nodes.flatMap((node) => {
    const model = modelsById.get(node.modelId);
    if (!model) {
      return [];
    }
    const nodeLabel = queryConditionNodeLabel(node, models);
    return sortPropsBySort(model.props_objects_array).map((prop) => ({
      key: queryProjectionFieldKey(node.id, prop.id),
      nodeId: node.id,
      nodeRole: node.role,
      modelId: node.modelId,
      modelKey: model.model_name || node.modelId,
      nodeLabel,
      fieldId: prop.id,
      modelName: modelLabel(model),
      fieldKey: prop.name || prop.id,
      fieldDisplayName: resolveI18nForLocale(prop.name_i18n, locale, prop.name || prop.id),
      fieldDescription: resolveI18nForLocale(prop.description_i18n, locale, ''),
      fieldType: interfaceValueTypeForPropType(prop.type),
      required: Boolean(prop.is_required),
    }));
  });
}

function buildQueryRelationConditionCandidates(
  graph: QueryGraphInstances,
  models: readonly EngineModelNode[],
  relations: readonly EngineRelationEdge[],
): QueryRelationConditionCandidate[] {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  return graph.edges.flatMap((edge) => {
    const relation = relations.find((item) => item.id === edge.relationId);
    const source = nodesById.get(edge.sourceNodeId);
    const target = nodesById.get(edge.targetNodeId);
    if (!relation || !source || !target) {
      return [];
    }
    return [
      {
        edgeId: `edge_${edge.id}`,
        relationId: relation.id,
        sourceNodeId: source.id,
        targetNodeId: target.id,
        sourceLabel: queryConditionNodeLabel(source, models),
        targetLabel: queryConditionNodeLabel(target, models),
        label: relationLabel(relation, edge.direction),
      },
    ];
  });
}

function queryConditionNodeLabel(
  node: QueryGraphInstances['nodes'][number],
  models: readonly EngineModelNode[],
): string {
  const model = models.find((item) => item.id === node.modelId);
  const displayModelName = model ? modelLabel(model) : node.modelId;
  if (node.role === 'root') {
    return `${displayModelName} \u00b7 ${TEXT_ROOT_NODE}`;
  }
  if (node.alias === node.modelId) {
    return displayModelName;
  }
  const alias = node.alias.startsWith(`${node.modelId}.`)
    ? node.alias.slice(node.modelId.length + 1)
    : node.alias.startsWith(node.modelId)
      ? node.alias.slice(node.modelId.length)
      : node.alias;
  return `${displayModelName} \u00b7 ${alias || node.alias}`;
}

function queryInterfaceFieldDoc(
  field: QueryInterface['query']['projection']['fields'][number],
  models: readonly EngineModelNode[],
  locale: string,
): {
  id: string;
  fieldKey: string;
  fieldType: string;
  required: boolean;
  displayName: string;
  sourceLabel: string;
  description: string;
} {
  const model = models.find((item) => item.id === field.source.modelId);
  const prop = model?.props_objects_array.find((item) => item.id === field.source.fieldId);
  const fieldName = prop
    ? resolveI18nForLocale(prop.name_i18n, locale, prop.name || field.source.fieldId)
    : field.source.fieldId;
  const description = prop ? resolveI18nForLocale(prop.description_i18n, locale, '') : '';

  return {
    id: field.id,
    fieldKey: prop?.name || field.outputName,
    fieldType: interfaceValueTypeForPropType(prop?.type),
    required: Boolean(prop?.is_required),
    displayName: fieldName,
    sourceLabel: `${model ? modelLabel(model) : field.source.modelId} · ${fieldName}`,
    description,
  };
}

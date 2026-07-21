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
import type { EngineModelNode, EngineRelationEdge } from '../types/engine-schema.js';
import { useDesigner } from '../context/designer-context.js';
import { DesignerTooltip } from './base/designer-tooltip.js';
import { resolveI18nForLocale } from '../utils/i18n-resolve.js';
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
  removeQueryChainNodeInstance,
  removeQueryChainRelation,
  reverseQueryChainPrimaryPath,
  validateEngineInterface,
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
  type InterfaceValueType,
  type QueryFilter,
  type QueryFilterOperator,
  type QueryInterface,
} from '../query-designer/index.js';

export interface SavedQueryInterfaceView {
  id: string;
  name: string;
  queryInterface: QueryInterface;
  queryChain: QueryChainState;
  createdAt: string;
  updatedAt: string;
  signature?: string;
  projectionConfigured?: boolean;
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
  const [filters, setFilters] = useState<readonly QueryFilter[]>([]);
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
      filters,
    });
  }, [
    effectiveRootId,
    edgeStates,
    filters,
    graphInstances,
    models,
    parameters,
    projectionFieldKeys,
    relations,
  ]);

  const validation = draft ? validateEngineInterface(draft) : null;
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
    setFilters(props.activeQueryInterface?.queryInterface.query.filters ?? []);
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
    setFilters([]);
    props.onQueryChainChange(EMPTY_QUERY_CHAIN_STATE);
  };
  const reversePrimaryPath = (): void => {
    props.onQueryChainChange(reverseQueryChainPrimaryPath(props.queryChain, relations));
  };
  const saveCurrentInterface = (): void => {
    if (!draft) {
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
            disabled={!draft || modelPathIds.length === 0}
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
            props.onQueryChainChange(removeQueryChainRelation(props.queryChain, edge, relations))
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
              edge.direction === 'forward' ? relation.target_model_id : relation.source_model_id;
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

      <section className="query-designer-section">
        <h3 className="designer-panel-section-title">{i18n.t('ui', 'queryProjection')}</h3>
        <ProjectionFieldTree
          candidates={projectionCandidates}
          selectedFieldKeys={projectionFieldKeys ?? defaultProjectionFieldKeys}
          onSelectedFieldKeysChange={(nextKeys) => setProjectionFieldKeys(nextKeys)}
          emptyLabel={i18n.t('ui', 'queryNoProjection')}
        />
      </section>

      {panelMode === 'filters' ? (
        <QueryConditionEditor
          fields={projectionCandidates}
          parameters={parameters}
          filters={filters}
          onParametersChange={setParameters}
          onFiltersChange={setFilters}
        />
      ) : null}

      {panelMode === 'preview' ? (
        <section className="query-designer-section">
          <h3 className="designer-panel-section-title">{i18n.t('ui', 'queryPanelMode_preview')}</h3>
          <span className="query-designer-empty">{i18n.t('ui', 'queryPreviewMvpHint')}</span>
        </section>
      ) : null}

      <section className="query-designer-section">
        <h3 className="designer-panel-section-title">{i18n.t('ui', 'queryInterfaceDraft')}</h3>
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
                {issue.message}
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}

export function QueryInterfaceManagerPanel(props: {
  savedQueryInterfaces: readonly SavedQueryInterfaceView[];
  onOpenQueryInterface: (id: string) => void;
  onRenameQueryInterface: (id: string, name: string) => void;
  onDeleteQueryInterface: (id: string) => void;
}): ReactElement {
  const { data, i18n } = useDesigner();

  return (
    <div className="query-interface-manager-panel">
      <section className="query-designer-section">
        <h3 className="designer-panel-section-title">{TEXT_INTERFACE_MANAGER}</h3>
        <div className="query-interface-list">
          {props.savedQueryInterfaces.length > 0 ? (
            props.savedQueryInterfaces.map((item) => (
              <QueryInterfaceDocCard
                key={item.id}
                item={item}
                models={data.models}
                relations={data.relations}
                locale={i18n.locale}
                onOpen={() => props.onOpenQueryInterface(item.id)}
                onRename={(name) => props.onRenameQueryInterface(item.id, name)}
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
  models: readonly EngineModelNode[];
  relations: readonly EngineRelationEdge[];
  locale: string;
  onOpen: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
}): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(props.item.name);
  const queryInterface = props.item.queryInterface;
  const rootNode = queryInterface.designGraph.nodes.find(
    (node) => node.id === queryInterface.designGraph.rootNodeId,
  );
  const rootName = rootNode ? modelNameById(rootNode.modelId, props.models) : TEXT_UNKNOWN_ROOT;
  const invocation =
    queryInterface.contract.invocation.endpoint ||
    queryInterface.contract.invocation.callableName ||
    queryInterface.name;
  const primaryPath = queryInterface.query.traversal.primaryPath
    .map((nodeId) => queryInterface.designGraph.nodes.find((node) => node.id === nodeId))
    .filter((node): node is NonNullable<typeof node> => Boolean(node));
  const pathLabel = primaryPath
    .map((node) => modelNameById(node.modelId, props.models))
    .join(' -> ');
  const branchCount = queryInterface.query.traversal.branches.length;
  const filterCount = queryInterface.query.filters.filter((filter) => filter.enabled).length;
  const projectionFields = queryInterface.query.projection.fields.filter((field) => field.visible);
  const outputNodeIds = queryResultOutputNodeIds(queryInterface);
  const outputProjectionFields = projectionFields.filter((field) =>
    outputNodeIds.has(field.source.nodeId),
  );
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
            <button type="button" onClick={() => setRenaming((value) => !value)}>
              {TEXT_RENAME_INTERFACE}
            </button>
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
            <span>{queryInterface.status}</span>
            <span>{`v${queryInterface.version.current}`}</span>
            <span>{queryInterface.contract.invocation.method}</span>
            <span>{TEXT_OUTPUT_TREE}</span>
            <span>{writeModeLabel(writableMode)}</span>
          </div>

          <div className="query-interface-doc-call">
            <span>{TEXT_CALL_ENTRY}</span>
            <code>{invocation}</code>
          </div>

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
            <InterfaceDocStat label={TEXT_FIELDS} value={outputProjectionFields.length} />
          </div>

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
            <span className="query-interface-doc-section-title">{TEXT_OUTPUT_FIELDS}</span>
            <QueryResultStructureTree
              queryInterface={queryInterface}
              models={props.models}
              relations={props.relations}
              locale={props.locale}
              emptyLabel={TEXT_EMPTY_VALUE}
            />
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

function InterfaceDocStat(props: { label: string; value: number }): ReactElement {
  return (
    <span className="query-interface-doc-stat">
      <strong>{props.value}</strong>
      <span>{props.label}</span>
    </span>
  );
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
const TEXT_NO_SAVED_INTERFACES = '\u6682\u65e0\u5df2\u4fdd\u5b58\u63a5\u53e3';
const TEXT_NO_DESCRIPTION = '\u6682\u65e0\u63cf\u8ff0';
const TEXT_ROOT_MODEL = '\u6839\u6a21\u578b';
const TEXT_UNKNOWN_ROOT = '\u672a\u77e5\u6839\u6a21\u578b';
const TEXT_CALL_ENTRY = '\u8c03\u7528\u5165\u53e3';
const TEXT_MODELS = '\u6a21\u578b';
const TEXT_RELATIONS = '\u5173\u7cfb';
const TEXT_BRANCHES = '\u5206\u652f';
const TEXT_FILTERS = '\u7b5b\u9009';
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
const TEXT_RELATION_SOURCE_TITLE = '\u9009\u62e9\u5173\u7cfb\u8d77\u70b9';
const TEXT_RELATION_SOURCE_HINT =
  '\u5f53\u524d\u6a21\u578b\u5b58\u5728\u591a\u4e2a\u67e5\u8be2\u5206\u652f\uff0c\u8bf7\u786e\u5b9a\u5173\u7cfb\u5ef6\u4f38\u7684\u6765\u6e90\u3002';
const TEXT_RELATION_SOURCE_ALL = '\u5e94\u7528\u5230\u5168\u90e8\u5206\u652f';
const TEXT_MODEL_SOURCE_TITLE = '\u9009\u62e9\u6a21\u578b\u6302\u8f7d\u5206\u652f';
const TEXT_MODEL_SOURCE_HINT =
  '\u8bf7\u70b9\u51fb\u9ad8\u4eae\u8282\u70b9\uff0c\u786e\u5b9a\u6b64\u6a21\u578b\u5e94\u6302\u8f7d\u5230\u54ea\u6761\u67e5\u8be2\u8def\u5f84\u3002';

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

function QueryConditionEditor(props: {
  fields: readonly ProjectionFieldCandidate[];
  parameters: readonly InterfaceParameter[];
  filters: readonly QueryFilter[];
  onParametersChange: (parameters: readonly InterfaceParameter[]) => void;
  onFiltersChange: (filters: readonly QueryFilter[]) => void;
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
    props.onFiltersChange(
      props.filters.map((filter) =>
        filter.value?.kind === 'parameter' && filter.value.parameterId === id
          ? { ...filter, value: { kind: 'literal', value: '' } }
          : filter,
      ),
    );
  };

  const addFilter = (): void => {
    const field = props.fields[0];
    if (!field) {
      return;
    }
    props.onFiltersChange([
      ...props.filters,
      {
        id: `filter_${Date.now().toString(36)}`,
        target: { nodeId: field.nodeId, modelId: field.modelId, fieldId: field.fieldId },
        operator: 'eq',
        value: { kind: 'literal', value: '' },
        enabled: true,
      },
    ]);
  };

  const updateFilter = (id: string, patch: Partial<QueryFilter>): void => {
    props.onFiltersChange(
      props.filters.map((filter) => (filter.id === id ? { ...filter, ...patch } : filter)),
    );
  };

  const removeFilter = (id: string): void => {
    props.onFiltersChange(props.filters.filter((filter) => filter.id !== id));
  };

  const fieldByRef = (filter: QueryFilter): ProjectionFieldCandidate | undefined => {
    const target = filter.target;
    if (!('fieldId' in target)) {
      return undefined;
    }
    return props.fields.find(
      (field) => field.nodeId === target.nodeId && field.fieldId === target.fieldId,
    );
  };

  return (
    <>
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
          <h3 className="designer-panel-section-title">{TEXT_FILTERS}</h3>
          <button
            type="button"
            className="query-designer-button"
            disabled={props.fields.length === 0}
            onClick={addFilter}
          >
            {TEXT_ADD_FILTER}
          </button>
        </div>
        <div className="query-condition-list">
          {props.filters.map((filter) => {
            const field = fieldByRef(filter);
            const requiresValue = !['isNull', 'isNotNull'].includes(filter.operator);
            const parameterMode = filter.value?.kind === 'parameter';
            return (
              <div key={filter.id} className="query-condition-filter-row">
                <select
                  value={field?.key ?? ''}
                  aria-label={TEXT_FILTER_FIELD}
                  onChange={(event) => {
                    const next = props.fields.find(
                      (candidate) => candidate.key === event.target.value,
                    );
                    if (next) {
                      updateFilter(filter.id, {
                        target: {
                          nodeId: next.nodeId,
                          modelId: next.modelId,
                          fieldId: next.fieldId,
                        },
                      });
                    }
                  }}
                >
                  {props.fields.map((candidate) => (
                    <option key={candidate.key} value={candidate.key}>
                      {`${candidate.modelKey}.${candidate.fieldKey}`}
                    </option>
                  ))}
                </select>
                <select
                  value={filter.operator}
                  aria-label="Operator"
                  onChange={(event) =>
                    updateFilter(filter.id, { operator: event.target.value as QueryFilterOperator })
                  }
                >
                  {QUERY_FILTER_OPERATORS.map((operator) => (
                    <option key={operator} value={operator}>
                      {filterOperatorLabel(operator)}
                    </option>
                  ))}
                </select>
                {requiresValue ? (
                  <div className="query-condition-value">
                    <div className="query-designer-segment">
                      <button
                        type="button"
                        data-active={!parameterMode ? 'true' : 'false'}
                        onClick={() =>
                          updateFilter(filter.id, { value: { kind: 'literal', value: '' } })
                        }
                      >
                        {TEXT_FILTER_LITERAL}
                      </button>
                      <button
                        type="button"
                        data-active={parameterMode ? 'true' : 'false'}
                        disabled={props.parameters.length === 0}
                        onClick={() =>
                          props.parameters[0]
                            ? updateFilter(filter.id, {
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
                        value={filter.value?.kind === 'parameter' ? filter.value.parameterId : ''}
                        aria-label={TEXT_FILTER_PARAMETER}
                        onChange={(event) =>
                          updateFilter(filter.id, {
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
                        value={String(
                          filter.value?.kind === 'literal' ? (filter.value.value ?? '') : '',
                        )}
                        aria-label={TEXT_FILTER_VALUE}
                        placeholder={TEXT_FILTER_VALUE}
                        onChange={(event) =>
                          updateFilter(filter.id, {
                            value: { kind: 'literal', value: event.target.value },
                          })
                        }
                      />
                    )}
                  </div>
                ) : null}
                <label className="query-condition-toggle" title={TEXT_FILTER_ENABLED}>
                  <input
                    type="checkbox"
                    checked={filter.enabled}
                    onChange={(event) => updateFilter(filter.id, { enabled: event.target.checked })}
                  />
                  <span>{TEXT_FILTER_ENABLED}</span>
                </label>
                <button
                  type="button"
                  className="query-condition-remove"
                  onClick={() => removeFilter(filter.id)}
                >
                  {TEXT_REMOVE}
                </button>
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}

function filterOperatorLabel(operator: QueryFilterOperator): string {
  const labels: Record<QueryFilterOperator, string> = {
    eq: 'eq (=)',
    neq: 'neq (!=)',
    contains: 'contains',
    startsWith: 'startsWith',
    endsWith: 'endsWith',
    gt: 'gt (>)',
    gte: 'gte (>=)',
    lt: 'lt (<)',
    lte: 'lte (<=)',
    in: 'in',
    notIn: 'notIn',
    isNull: 'isNull',
    isNotNull: 'isNotNull',
  };
  return labels[operator];
}

interface ProjectionFieldCandidate {
  key: string;
  nodeId: string;
  nodeRole: 'root' | 'primary' | 'branch';
  modelId: string;
  modelKey: string;
  fieldId: string;
  modelName: string;
  fieldKey: string;
  fieldDisplayName: string;
  fieldDescription: string;
  required: boolean;
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
    return model.props_objects_array.map((prop) => ({
      key: queryProjectionFieldKey(node.id, prop.id),
      nodeId: node.id,
      nodeRole: node.role,
      modelId: node.modelId,
      modelKey: model.model_name || node.modelId,
      fieldId: prop.id,
      modelName: modelLabel(model),
      fieldKey: prop.name || prop.id,
      fieldDisplayName: resolveI18nForLocale(prop.name_i18n, locale, prop.name || prop.id),
      fieldDescription: resolveI18nForLocale(prop.description_i18n, locale, ''),
      required: Boolean(prop.is_required),
    }));
  });
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

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import { createPortal } from 'react-dom';
import type { EngineModelNode, EngineRelationEdge } from '../types/engine-schema.js';
import { useDesigner } from '../context/designer-context.js';
import { DesignerTooltip } from './base/designer-tooltip.js';
import {
  EMPTY_QUERY_CHAIN_STATE,
  buildQueryInterfaceDraft,
  outgoingRelationsForModel,
  queryChainEdgeStates,
  queryChainModelIds,
  queryChainPrimaryModelIds,
  queryChainTailModelId,
  validateEngineInterface,
  type QueryChainState,
  type QueryGraphEdgeDirection,
  type QueryGraphEdgeRole,
  type QueryGraphEdgeState,
  type QueryGraphRelationUsage,
} from '../query-designer/index.js';

export function QueryDesignerPanel(props: {
  selectedModelId: string | undefined;
  queryChain: QueryChainState;
  onQueryChainChange: (queryChain: QueryChainState) => void;
}): ReactElement {
  const { data, i18n, modes } = useDesigner();
  const [panelMode, setPanelMode] = useState<
    'chain' | 'fields' | 'filters' | 'contract' | 'preview'
  >('chain');

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
  const primaryModelIds = queryChainPrimaryModelIds(props.queryChain, relations);

  const draft = useMemo(() => {
    if (!effectiveRootId) {
      return null;
    }
    return buildQueryInterfaceDraft({
      rootModelId: effectiveRootId,
      edgeStates,
      models,
      relations,
    });
  }, [effectiveRootId, edgeStates, models, relations]);

  const validation = draft ? validateEngineInterface(draft) : null;

  const resetChain = (): void => {
    props.onQueryChainChange(EMPTY_QUERY_CHAIN_STATE);
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
          primaryModelIds={primaryModelIds}
          rootModelId={effectiveRootId}
          emptyLabel={i18n.t('ui', 'queryPickRootHint')}
          inheritedLabel={(name) => i18n.t('ui', 'queryInheritedFrom', { name })}
        />
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
                    ? ` · ${i18n.t('ui', 'queryInheritedFrom', {
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
        <div className="query-designer-field-list">
          {draft?.query.projection.fields.length ? (
            draft.query.projection.fields.map((field) => (
              <span key={field.id} className="query-designer-field-chip">
                {field.outputName}
              </span>
            ))
          ) : (
            <span className="query-designer-empty">{i18n.t('ui', 'queryNoProjection')}</span>
          )}
        </div>
      </section>

      {panelMode === 'filters' ? (
        <section className="query-designer-section">
          <h3 className="designer-panel-section-title">{i18n.t('ui', 'queryPanelMode_filters')}</h3>
          <span className="query-designer-empty">{i18n.t('ui', 'queryFilterMvpHint')}</span>
        </section>
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

function QueryGraphPreview(props: {
  models: readonly EngineModelNode[];
  relationViews: readonly {
    edge: QueryGraphEdgeState;
    relation: EngineRelationEdge;
  }[];
  primaryModelIds: readonly string[];
  rootModelId: string | undefined;
  emptyLabel: string;
  inheritedLabel: (name: string) => string;
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
        primaryModelIds: props.primaryModelIds,
        rootModelId: props.rootModelId,
        inheritedLabel: props.inheritedLabel,
      }),
    [
      props.inheritedLabel,
      props.models,
      props.primaryModelIds,
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
          <button type="button" title="Fullscreen" onClick={() => setFullscreen(true)}>
            []
          </button>
        </div>
        <div className="query-designer-graph-zoom">{Math.round(zoom * 100)}%</div>
        {graphSurface('panel')}
      </div>
      {fullscreenDialog}
    </>
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
  sourceModelId: string;
  targetModelId: string;
}

interface PreviewGraph {
  nodes: PreviewGraphNode[];
  edges: PreviewGraphEdge[];
  bounds: { x: number; y: number; width: number; height: number };
}

function QueryGraphPreviewSurface(props: {
  graph: PreviewGraph;
  markerId: string;
  zoom: number;
  pan: { x: number; y: number };
  onPanChange: (pan: { x: number; y: number }) => void;
  onZoomChange: (zoom: number, pan: { x: number; y: number }) => void;
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
      }
    | undefined
  >(undefined);
  const [isDragging, setIsDragging] = useState(false);
  const viewBox = previewViewBox(props.graph.bounds, props.zoom, props.pan);
  const handleWheel = (event: ReactWheelEvent<SVGSVGElement>): void => {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
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
  const handlePointerDown = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (event.button !== 0) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      pan: props.pan,
    };
    setIsDragging(true);
  };
  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>): void => {
    const drag = dragRef.current;
    const svg = svgRef.current;
    if (!drag || !svg) {
      return;
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
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = undefined;
      setIsDragging(false);
    }
  };
  return (
    <svg
      ref={svgRef}
      className="query-designer-graph-svg"
      data-variant={props.variant}
      data-dragging={isDragging ? 'true' : 'false'}
      viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
      role="img"
      aria-label={props.emptyLabel}
      onWheel={handleWheel}
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
          <g key={edge.id}>
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
  primaryModelIds: readonly string[];
  rootModelId: string | undefined;
  inheritedLabel: (name: string) => string;
}): PreviewGraph {
  const nodeRadius = 46;
  const positions = new Map<string, { x: number; y: number }>();
  const orderedPrimaryIds =
    input.primaryModelIds.length > 0
      ? input.primaryModelIds
      : input.rootModelId
        ? [input.rootModelId]
        : [];
  const primaryCount = orderedPrimaryIds.length;
  orderedPrimaryIds.forEach((modelId, index) => {
    positions.set(modelId, {
      x: primaryCount === 1 ? 0 : index * 220,
      y: 0,
    });
  });

  const edgeEndpoints = input.relationViews.map(({ edge, relation }) => ({
    edge,
    relation,
    sourceModelId: queryEdgeSourceModelId(relation, edge.direction, edge.usage),
    targetModelId: queryEdgeTargetModelId(relation, edge.direction),
  }));
  const nodeIds = new Set<string>(orderedPrimaryIds);
  edgeEndpoints.forEach((edge) => {
    nodeIds.add(edge.sourceModelId);
    nodeIds.add(edge.targetModelId);
  });

  const branchSlots = new Map<string, number>();
  for (const edge of edgeEndpoints) {
    if (positions.has(edge.targetModelId)) {
      continue;
    }
    const sourcePosition = positions.get(edge.sourceModelId);
    const slot = branchSlots.get(edge.sourceModelId) ?? 0;
    branchSlots.set(edge.sourceModelId, slot + 1);
    positions.set(edge.targetModelId, {
      x: (sourcePosition?.x ?? 0) + (slot % 2 === 0 ? 150 : -150),
      y: edge.edge.role === 'constraint' ? 130 : 155 + Math.floor(slot / 2) * 120,
    });
  }

  Array.from(nodeIds).forEach((modelId, index) => {
    if (positions.has(modelId)) {
      return;
    }
    positions.set(modelId, {
      x: (index % 3) * 180,
      y: 180 + Math.floor(index / 3) * 120,
    });
  });

  const nodes = Array.from(nodeIds)
    .map((modelId) => {
      const position = positions.get(modelId);
      const fullLabel = modelNameById(modelId, input.models);
      return position
        ? {
            id: modelId,
            x: position.x,
            y: position.y,
            radius: nodeRadius,
            label: compactPreviewLabel(fullLabel),
            fullLabel,
            kind:
              input.rootModelId === modelId
                ? 'root'
                : orderedPrimaryIds.includes(modelId)
                  ? 'primary'
                  : 'branch',
          }
        : undefined;
    })
    .filter((node): node is PreviewGraphNode => Boolean(node));

  const edges = edgeEndpoints
    .map((edge, index) => {
      const source = positions.get(edge.sourceModelId);
      const target = positions.get(edge.targetModelId);
      if (!source || !target) {
        return undefined;
      }
      const sourceAnchor = edgeAnchor(source, target, nodeRadius);
      const targetAnchor = edgeAnchor(target, source, nodeRadius);
      const path = curvedPreviewPath(sourceAnchor, targetAnchor, edge.edge.role, index);
      return {
        id: `${edge.edge.role}-${edge.edge.direction}-${edge.relation.id}-${index}`,
        role: edge.edge.role,
        path,
        label: relationLabel(edge.relation, edge.edge.direction),
        labelX: (sourceAnchor.x + targetAnchor.x) / 2,
        labelY: (sourceAnchor.y + targetAnchor.y) / 2 - 10,
        inherited:
          edge.edge.usage?.kind === 'inherited'
            ? input.inheritedLabel(modelNameById(edge.edge.usage.ownerModelId, input.models))
            : undefined,
        sourceModelId: edge.sourceModelId,
        targetModelId: edge.targetModelId,
      };
    })
    .filter((edge): edge is PreviewGraphEdge => Boolean(edge));

  return { nodes, edges, bounds: previewBounds(nodes) };
}

function compactPreviewLabel(label: string): string {
  return label.length > 10 ? `${label.slice(0, 10)}...` : label;
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
  const padding = 96;
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
      ? ` · ${inheritedLabel(modelNameById(usage.ownerModelId, models))}`
      : '';
  return `${source ? modelLabel(source) : sourceModelId} -> ${target ? modelLabel(target) : targetModelId}${inherited}`;
}

function modelNameById(modelId: string, models: readonly EngineModelNode[]): string {
  const model = models.find((item) => item.id === modelId);
  return model ? modelLabel(model) : modelId;
}

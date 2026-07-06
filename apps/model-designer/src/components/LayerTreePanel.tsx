import { useCallback, useEffect, useState, type DragEvent, type ReactElement } from 'react';
import { useDesigner } from '../context/designer-context.js';
import type { LayerTreeNode } from '../types/layer-tree.js';
import type { LayerDropZone } from '../utils/layer-tree-ops.js';
import {
  isLayerRootGroupId,
  LAYER_DEFAULT_PAGE_ID,
  LAYER_ROOT_GROUP_ID,
} from '../config/layer-tree-defaults.js';
import { collectAllPageIds, collectPageIdsInSubtree } from '../utils/layer-tree-ops.js';
import {
  findLayerNode,
  resolveLayerAddParentGroupId,
  resolveLayerNodeLabel,
} from '../utils/layer-tree-label.js';
import { LayerNodeEditor } from './LayerNodeEditor.js';

function detectDropZone(ev: DragEvent, row: HTMLElement): LayerDropZone {
  const rect = row.getBoundingClientRect();
  const y = ev.clientY - rect.top;
  const third = rect.height / 3;
  if (y < third) {
    return 'before';
  }
  if (y > third * 2) {
    return 'after';
  }
  return 'inside';
}

function isTreeActionTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return Boolean(target.closest('button, input, textarea, select, .designer-tree-editor'));
}

type DropHint = { targetId: string; zone: LayerDropZone };

function TreeNodes(props: {
  roots: readonly LayerTreeNode[];
  depth: number;
  canvasSelectedModelId: string | undefined;
  selectedNodeId: string | undefined;
  onSelectNode: (id: string) => void;
  readOnly: boolean;
  editingId: string | null;
  onEdit: (id: string | null) => void;
  dragId: string | null;
  dropHint: DropHint | null;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onDropHint: (hint: DropHint | null) => void;
  onDrop: (dragId: string, targetId: string, zone: LayerDropZone) => void;
}): ReactElement {
  const { data, layers, i18n } = useDesigner();

  const rowDropClass = (id: string): string => {
    if (!props.dropHint || props.dropHint.targetId !== id) {
      return '';
    }
    if (props.dropHint.zone === 'before') {
      return ' designer-tree-row--drop-before';
    }
    if (props.dropHint.zone === 'after') {
      return ' designer-tree-row--drop-after';
    }
    return ' designer-tree-row--drop-inside';
  };

  const rowSelectedClass = (id: string): string =>
    props.selectedNodeId === id ? ' designer-tree-row--selected' : '';

  const bindRowDrag = (
    n: LayerTreeNode,
    rowClass: string,
    body: ReactElement,
    afterRow?: ReactElement,
  ): ReactElement => {
    const canDrag = !props.readOnly && !isLayerRootGroupId(n.id);
    const pageHoverClass =
      n.kind === 'page' && data.hoveredLayerPageId === n.id ? ' designer-tree-page--hovered' : '';
    return (
      <div className="designer-tree-node">
        <div
          className={`${rowClass}${rowDropClass(n.id)}${rowSelectedClass(n.id)}${pageHoverClass}`}
          draggable={canDrag}
          onMouseEnter={() => {
            if (n.kind === 'page' && n.id !== LAYER_DEFAULT_PAGE_ID) {
              data.setHoveredLayerPageId(n.id);
            }
          }}
          onMouseLeave={() => {
            if (n.kind === 'page') {
              data.setHoveredLayerPageId(undefined);
            }
          }}
          onClick={(e) => {
            if (isTreeActionTarget(e.target)) {
              return;
            }
            props.onSelectNode(n.id);
            if (n.kind === 'page') {
              layers.setActiveLayer(n.id);
            }
          }}
          onDoubleClick={(e) => {
            if (isTreeActionTarget(e.target) || props.readOnly) {
              return;
            }
            props.onEdit(props.editingId === n.id ? null : n.id);
          }}
          onDragStart={(e) => {
            if (!canDrag || isTreeActionTarget(e.target)) {
              e.preventDefault();
              return;
            }
            props.onDragStart(n.id);
            e.dataTransfer.setData('text/plain', n.id);
            e.dataTransfer.effectAllowed = 'move';
          }}
          onDragEnd={() => props.onDragEnd()}
          onDragOver={(e) => {
            if (props.readOnly || !props.dragId || props.dragId === n.id) {
              return;
            }
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const zone = detectDropZone(e, e.currentTarget as HTMLElement);
            if (isLayerRootGroupId(n.id) && zone !== 'inside') {
              props.onDropHint(null);
              return;
            }
            props.onDropHint({ targetId: n.id, zone });
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
              props.onDropHint(null);
            }
          }}
          onDrop={(e) => {
            e.preventDefault();
            if (props.readOnly || !props.dragId) {
              return;
            }
            const zone = detectDropZone(e, e.currentTarget as HTMLElement);
            if (isLayerRootGroupId(n.id) && zone !== 'inside') {
              return;
            }
            props.onDrop(props.dragId, n.id, zone);
            props.onDropHint(null);
          }}
        >
          {body}
        </div>
        {props.editingId === n.id ? (
          <LayerNodeEditor
            nodeId={n.id}
            readOnly={props.readOnly}
            onClose={() => props.onEdit(null)}
          />
        ) : null}
        {afterRow}
      </div>
    );
  };

  return (
    <>
      {props.roots.map((n) => {
        const title = resolveLayerNodeLabel(n, i18n.locale);
        if (n.kind === 'group') {
          return (
            <div
              key={n.id}
              className="designer-tree-group"
              style={{ marginLeft: props.depth * 12 }}
            >
              {bindRowDrag(
                n,
                'designer-tree-row designer-tree-row--group',
                <>
                  <span className="designer-tree-icon" aria-hidden>
                    📁
                  </span>
                  <span className="designer-tree-label" title={i18n.t('ui', 'treeDoubleClickEdit')}>
                    {title}
                  </span>
                  <button
                    type="button"
                    className="designer-tree-mini"
                    onClick={() => data.toggleLayerTreeNode(n.id)}
                  >
                    {n.isVisible ? i18n.t('ui', 'layerHide') : i18n.t('ui', 'layerShow')}
                  </button>
                </>,
                <TreeNodes
                  roots={n.children}
                  depth={props.depth + 1}
                  canvasSelectedModelId={props.canvasSelectedModelId}
                  selectedNodeId={props.selectedNodeId}
                  onSelectNode={props.onSelectNode}
                  readOnly={props.readOnly}
                  editingId={props.editingId}
                  onEdit={props.onEdit}
                  dragId={props.dragId}
                  dropHint={props.dropHint}
                  onDragStart={props.onDragStart}
                  onDragEnd={props.onDragEnd}
                  onDropHint={props.onDropHint}
                  onDrop={props.onDrop}
                />,
              )}
            </div>
          );
        }

        return (
          <div key={n.id} style={{ marginLeft: props.depth * 12 }}>
            {bindRowDrag(
              n,
              'designer-tree-row designer-tree-page',
              <>
                <input
                  type="radio"
                  name="designer-active-layer-tree"
                  checked={layers.activeLayerId === n.id}
                  onChange={() => layers.setActiveLayer(n.id)}
                />
                <span className="designer-tree-icon" aria-hidden>
                  📄
                </span>
                <span className="designer-tree-label" title={i18n.t('ui', 'treeDoubleClickEdit')}>
                  {title}
                </span>
                <button
                  type="button"
                  className="designer-tree-mini"
                  onClick={() => data.toggleLayerTreeNode(n.id)}
                >
                  {n.isVisible ? i18n.t('ui', 'layerHide') : i18n.t('ui', 'layerShow')}
                </button>
                <button
                  type="button"
                  className="designer-tree-mini"
                  disabled={!props.canvasSelectedModelId || props.readOnly}
                  title={i18n.t('ui', 'treeAssignSelection')}
                  onClick={() => {
                    if (props.canvasSelectedModelId) {
                      data.assignModelToPage(props.canvasSelectedModelId, n.id);
                    }
                  }}
                >
                  {i18n.t('ui', 'treeAssignSelection')}
                </button>
              </>,
            )}
          </div>
        );
      })}
    </>
  );
}

export function LayerTreePanel(props: {
  selectedId: string | undefined;
  readOnly?: boolean;
}): ReactElement {
  const { data, i18n, layers } = useDesigner();
  const readOnly = props.readOnly ?? false;
  const [, bump] = useState(0);
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>(LAYER_ROOT_GROUP_ID);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<DropHint | null>(null);

  useEffect(() => data.subscribe(() => bump((n) => n + 1)), [data]);

  useEffect(() => {
    data.setLayerTreePanelOpen(true);
    return () => data.setLayerTreePanelOpen(false);
  }, [data]);

  useEffect(() => {
    if (selectedNodeId && findLayerNode(data.layerTreeRoots, selectedNodeId)) {
      return;
    }
    setSelectedNodeId(LAYER_ROOT_GROUP_ID);
  }, [data.layerTreeRoots, selectedNodeId]);

  const addParentGroupId = resolveLayerAddParentGroupId(
    data.layerTreeRoots,
    selectedNodeId,
    LAYER_ROOT_GROUP_ID,
  );

  const handleDrop = useCallback(
    (fromId: string, targetId: string, zone: LayerDropZone) => {
      data.moveLayerNode(fromId, targetId, zone);
      setDragId(null);
    },
    [data],
  );

  const addGroup = (): void => {
    const id = data.addLayerGroup(addParentGroupId);
    setSelectedNodeId(id);
  };

  const addPage = (): void => {
    const id = data.addLayerPage(addParentGroupId);
    setSelectedNodeId(id);
  };

  const canDeleteSelected = Boolean(
    selectedNodeId &&
    !isLayerRootGroupId(selectedNodeId) &&
    findLayerNode(data.layerTreeRoots, selectedNodeId),
  );

  const deleteSelected = (): void => {
    if (!selectedNodeId || isLayerRootGroupId(selectedNodeId)) {
      return;
    }
    const target = findLayerNode(data.layerTreeRoots, selectedNodeId);
    if (!target) {
      return;
    }
    const removedPageIds = collectPageIdsInSubtree(target);
    const activeWasDeleted = Boolean(
      layers.activeLayerId && removedPageIds.includes(layers.activeLayerId),
    );
    if (!data.removeLayerNode(selectedNodeId)) {
      return;
    }
    if (editingId === selectedNodeId) {
      setEditingId(null);
    }
    setSelectedNodeId(LAYER_ROOT_GROUP_ID);
    if (activeWasDeleted) {
      const fallback = collectAllPageIds(data.layerTreeRoots)[0] ?? null;
      layers.setActiveLayer(fallback);
    }
  };

  return (
    <div className="designer-layer-tree designer-scrollbar-hide">
      <div className="designer-tree-toolbar">
        <button
          type="button"
          className="designer-tree-action"
          disabled={readOnly}
          title={i18n.t('ui', 'treeAddGroupHint')}
          onClick={addGroup}
        >
          {i18n.t('ui', 'treeAddGroup')}
        </button>
        <button
          type="button"
          className="designer-tree-action"
          disabled={readOnly}
          title={i18n.t('ui', 'treeAddPageHint')}
          onClick={addPage}
        >
          {i18n.t('ui', 'treeAddPage')}
        </button>
        <button
          type="button"
          className="designer-tree-action designer-tree-action--danger"
          disabled={readOnly || !canDeleteSelected}
          title={i18n.t('ui', 'treeDeleteHint')}
          onClick={deleteSelected}
        >
          {i18n.t('ui', 'treeDelete')}
        </button>
      </div>
      <p className="designer-tree-hint">{i18n.t('ui', 'treeDragHint')}</p>
      <TreeNodes
        roots={data.layerTreeRoots}
        depth={0}
        canvasSelectedModelId={props.selectedId}
        selectedNodeId={selectedNodeId}
        onSelectNode={setSelectedNodeId}
        readOnly={readOnly}
        editingId={editingId}
        onEdit={setEditingId}
        dragId={dragId}
        dropHint={dropHint}
        onDragStart={setDragId}
        onDragEnd={() => {
          setDragId(null);
          setDropHint(null);
        }}
        onDropHint={setDropHint}
        onDrop={handleDrop}
      />
    </div>
  );
}

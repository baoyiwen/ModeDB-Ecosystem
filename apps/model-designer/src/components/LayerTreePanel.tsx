import { Fragment, useEffect, useState, type ReactElement } from 'react';
import { useDesigner } from '../context/designer-context.js';
import type { LayerTreeNode } from '../types/layer-tree.js';

function TreeNodes(props: {
  roots: readonly LayerTreeNode[];
  depth: number;
  selectedId: string | undefined;
}): ReactElement {
  const { data, layers, i18n } = useDesigner();

  return (
    <>
      {props.roots.map((n) => (
        <Fragment key={n.id}>
          {n.kind === 'group' ? (
            <div className="designer-tree-group" style={{ marginLeft: props.depth * 12 }}>
              <div className="designer-tree-row">
                <span className="designer-tree-icon" aria-hidden>
                  📁
                </span>
                <span className="designer-tree-label">{n.label}</span>
                <button
                  type="button"
                  className="designer-tree-mini"
                  onClick={() => {
                    const label = window.prompt(i18n.t('ui', 'treePageName'));
                    if (label?.trim()) {
                      data.addLayerPage(n.id, label.trim());
                    }
                  }}
                >
                  {i18n.t('ui', 'treeAddPage')}
                </button>
                <button
                  type="button"
                  className="designer-tree-mini"
                  onClick={() => {
                    const label = window.prompt(i18n.t('ui', 'treeGroupName'));
                    if (label?.trim()) {
                      data.addLayerGroup(n.id, label.trim());
                    }
                  }}
                >
                  {i18n.t('ui', 'treeAddGroup')}
                </button>
                <button
                  type="button"
                  className="designer-tree-mini"
                  onClick={() => data.toggleLayerTreeNode(n.id)}
                >
                  {n.isVisible ? i18n.t('ui', 'layerHide') : i18n.t('ui', 'layerShow')}
                </button>
              </div>
              <TreeNodes roots={n.children} depth={props.depth + 1} selectedId={props.selectedId} />
            </div>
          ) : (
            <label
              className="designer-tree-row designer-tree-page"
              style={{ marginLeft: props.depth * 12 }}
            >
              <input
                type="radio"
                name="designer-active-layer-tree"
                checked={layers.activeLayerId === n.id}
                onChange={() => layers.setActiveLayer(n.id)}
              />
              <span className="designer-tree-icon" aria-hidden>
                📄
              </span>
              <span className="designer-tree-label">{n.label}</span>
              <button
                type="button"
                className="designer-tree-mini"
                onClick={(e) => {
                  e.preventDefault();
                  data.toggleLayerTreeNode(n.id);
                }}
              >
                {n.isVisible ? i18n.t('ui', 'layerHide') : i18n.t('ui', 'layerShow')}
              </button>
              <button
                type="button"
                className="designer-tree-mini"
                disabled={!props.selectedId}
                title={i18n.t('ui', 'treeAssignSelection')}
                onClick={(e) => {
                  e.preventDefault();
                  if (props.selectedId) {
                    data.assignModelToPage(props.selectedId, n.id);
                  }
                }}
              >
                {i18n.t('ui', 'treeAssignSelection')}
              </button>
            </label>
          )}
        </Fragment>
      ))}
    </>
  );
}

export function LayerTreePanel(props: { selectedId: string | undefined }): ReactElement {
  const { data, i18n } = useDesigner();
  const [, bump] = useState(0);

  useEffect(() => data.subscribe(() => bump((n) => n + 1)), [data]);

  return (
    <div className="designer-layer-tree">
      <div className="designer-tree-toolbar">
        <button
          type="button"
          className="designer-tree-action"
          onClick={() => {
            const label = window.prompt(i18n.t('ui', 'treeGroupName'));
            if (label?.trim()) {
              data.addLayerGroup(null, label.trim());
            }
          }}
        >
          {i18n.t('ui', 'treeNewRootGroup')}
        </button>
      </div>
      <TreeNodes roots={data.layerTreeRoots} depth={0} selectedId={props.selectedId} />
    </div>
  );
}

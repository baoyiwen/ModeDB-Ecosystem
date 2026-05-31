import { useEffect, useState, type ReactElement } from 'react';
import { useDesigner } from '../context/designer-context.js';
import { I18nLocaleRows } from './i18n-locale-rows.js';
import { findLayerNode } from '../utils/layer-tree-label.js';
import { isLayerRootGroupId } from '../config/layer-tree-defaults.js';

export function LayerNodeEditor(props: {
  nodeId: string;
  readOnly: boolean;
  onClose: () => void;
}): ReactElement | null {
  const { data, i18n } = useDesigner();
  const [, bump] = useState(0);
  useEffect(() => data.subscribe(() => bump((n) => n + 1)), [data]);

  const node = findLayerNode(data.layerTreeRoots, props.nodeId);

  if (!node) {
    return null;
  }

  const isRoot = isLayerRootGroupId(node.id);

  return (
    <div className="designer-tree-editor designer-glass-inset">
      <div className="designer-tree-editor-header">
        <span className="designer-field-label">
          {node.kind === 'group' ? i18n.t('ui', 'treeEditGroup') : i18n.t('ui', 'treeEditPage')}
          {isRoot ? ` (${i18n.t('ui', 'treeRootGroupBadge')})` : ''}
        </span>
        <button type="button" className="designer-tree-mini" onClick={props.onClose}>
          ×
        </button>
      </div>
      <label className="designer-field">
        <span className="designer-field-label">{i18n.t('ui', 'treeLayerName')}</span>
        <input
          className="designer-input"
          disabled={props.readOnly}
          value={node.label}
          onChange={(e) => data.updateLayerNode(node.id, { label: e.target.value })}
        />
      </label>
      <I18nLocaleRows
        disabled={props.readOnly}
        summary={i18n.t('ui', 'treeLayerDisplayName')}
        value={(node.name_i18n as Record<string, string> | undefined) ?? {}}
        onCommit={(next) => data.updateLayerNode(node.id, { name_i18n: next })}
        pickLocaleLabel={i18n.t('ui', 'i18nPickLocale')}
        addRowHint={i18n.t('ui', 'i18nAddLocaleFill')}
      />
      <I18nLocaleRows
        disabled={props.readOnly}
        multiline
        summary={i18n.t('ui', 'treeLayerDescription')}
        value={(node.description_i18n as Record<string, string> | undefined) ?? {}}
        onCommit={(next) => data.updateLayerNode(node.id, { description_i18n: next })}
        pickLocaleLabel={i18n.t('ui', 'i18nPickLocale')}
        addRowHint={i18n.t('ui', 'i18nAddLocaleFill')}
      />
    </div>
  );
}

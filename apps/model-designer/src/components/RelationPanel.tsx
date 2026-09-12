import { useEffect, useState, type ReactElement } from 'react';
import { useDesigner } from '../context/designer-context.js';
import {
  resolveModelDisplayName,
  resolveRelationForwardLabel,
  resolveRelationReverseLabel,
  resolveInheritRelationLabel,
} from '../utils/i18n-resolve.js';
import { GRAPH_NODE_LINK_KIND, isInheritRelation } from '../config/graph-edge-kinds.js';
import {
  RELATION_CARDINALITY_MANY,
  RELATION_CARDINALITY_ONE,
} from '../config/relation-cardinality.js';
import { makeUniqueName, sanitizeUniqueNameFragment } from '../utils/name-validation.js';
import { relationCardinalityLabel, relationNamesUsedInScope } from '../utils/relation-identity.js';
import { createUuid } from '../utils/random-id.js';

export function RelationPanel(props: {
  modelId: string | undefined;
  readOnly?: boolean;
}): ReactElement {
  const { i18n, data } = useDesigner();
  const readOnly = props.readOnly ?? false;
  const [, bump] = useState(0);
  useEffect(() => i18n.subscribe(() => bump((n) => n + 1)), [i18n]);
  useEffect(() => data.subscribe(() => bump((n) => n + 1)), [data]);

  const mid = props.modelId;
  const rels = mid
    ? data.relations.filter((r) => r.source_model_id === mid || r.target_model_id === mid)
    : [];

  const renderRel = (r: (typeof rels)[number]): ReactElement => {
    const src = data.models.find((m) => m.id === r.source_model_id);
    const tgt = data.models.find((m) => m.id === r.target_model_id);
    const srcLabel = src ? resolveModelDisplayName(src, i18n.locale) : r.source_model_id;
    const tgtLabel = tgt ? resolveModelDisplayName(tgt, i18n.locale) : r.target_model_id;
    const isInherit = isInheritRelation(r.kind);
    return (
      <div key={r.id} className="designer-rel-card designer-glass-inset">
        <div className="designer-prop-inherited-value" style={{ fontWeight: 650 }}>
          {isInherit ? (
            <span>{resolveInheritRelationLabel(r, i18n.locale)}</span>
          ) : (
            <>
              <span>{resolveRelationForwardLabel(r, i18n.locale)}</span>
              <span style={{ color: '#94a3b8', margin: '0 6px' }}>·</span>
              <span style={{ color: '#64748b' }}>
                {resolveRelationReverseLabel(r, i18n.locale)}
              </span>
            </>
          )}
        </div>
        <div style={{ fontSize: 11, color: '#64748b', marginTop: 6 }}>
          <span>{srcLabel}</span>
          <span style={{ margin: '0 6px', color: '#94a3b8' }}>→</span>
          <span>{tgtLabel}</span>
          {isInherit ? (
            <span style={{ marginLeft: 8, color: '#94a3b8' }}>
              ({i18n.t('ui', 'inheritRelationBadge')})
            </span>
          ) : null}
        </div>
        {!isInherit && (
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>
            {i18n.t('ui', 'relationCardinalityLabel')}: {relationCardinalityLabel(r)}
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 12 }}>
      {rels.map(renderRel)}
      {rels.length === 0 && <div style={{ color: '#64748b' }}>—</div>}
      <button
        type="button"
        className="designer-btn designer-btn-primary"
        disabled={!mid || readOnly}
        onClick={() => {
          if (!mid) {
            return;
          }
          const self = data.models.find((m) => m.id === mid);
          if (!self) {
            return;
          }
          // 优先链接到其他模型；找不到就退化为自关联，仍满足"成对"约定。
          const target = data.models.find((m) => m.id !== mid) ?? self;
          const isSelf = target.id === mid;
          const s = sanitizeUniqueNameFragment(self.model_name) || 'source';
          const t = sanitizeUniqueNameFragment(target.model_name) || 'target';
          const forwardBase = isSelf ? 'children' : `${s}-${t}`;
          const reverseBase = isSelf ? 'parent' : `${t}-${s}`;
          const used = relationNamesUsedInScope(data.relations, mid, target.id);
          const forward_name = makeUniqueName(forwardBase, used);
          used.add(forward_name);
          const reverse_name = makeUniqueName(reverseBase, used);
          data.addRelation({
            id: createUuid(),
            source_model_id: mid,
            target_model_id: target.id,
            forward_name,
            reverse_name,
            engine_forward_name: forward_name,
            engine_reverse_name: reverse_name,
            kind: GRAPH_NODE_LINK_KIND,
            self_cardinality: RELATION_CARDINALITY_MANY,
            source_cardinality: RELATION_CARDINALITY_ONE,
            target_cardinality: RELATION_CARDINALITY_MANY,
          });
        }}
      >
        {i18n.t('ui', 'addRelation')}
      </button>
    </div>
  );
}

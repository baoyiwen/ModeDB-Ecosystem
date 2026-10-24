import assert from 'node:assert/strict';
import {
  assetGraphVault,
  AtlasSingleVault,
  collectDesignerAsset,
  type AssetGraph,
} from '@mode-db/core';
import {
  buildQueryInterfaceDraft,
  compilePublishedQueryExecutionTemplate,
  queryChainGraphInstances,
  type QueryChainState,
} from '../../apps/model-designer/src/query-designer/index.js';
import {
  GRAPH_INHERIT_KIND,
  GRAPH_NODE_LINK_KIND,
} from '../../apps/model-designer/src/config/graph-edge-kinds.js';
import type {
  EngineModelNode,
  EngineRelationEdge,
} from '../../apps/model-designer/src/types/engine-schema.js';

export const fixtureTime = '2026-10-23T00:00:00.000Z';
export function designerFixture(complex = true) {
  const names = complex ? ['Base', 'Mid', 'Child', 'Item'] : ['Item'];
  const fieldName = (name: string) => (name === 'Item' ? 'label' : name.toLowerCase() + 'Label');
  const models: EngineModelNode[] = names.map((name) => ({
    id: 'meta_' + name,
    model_name: name,
    parent_id: name === 'Child' ? 'meta_Mid' : name === 'Mid' ? 'meta_Base' : null,
    props_objects_array: [
      {
        id: 'field_' + name,
        name: fieldName(name),
        type: 'string',
      } as EngineModelNode['props_objects_array'][number],
    ],
  }));
  const relations: EngineRelationEdge[] = complex
    ? [
        {
          id: 'old_random_inherit_base',
          source_model_id: 'meta_Base',
          target_model_id: 'meta_Mid',
          kind: GRAPH_INHERIT_KIND,
        },
        {
          id: 'old_random_inherit_mid',
          source_model_id: 'meta_Mid',
          target_model_id: 'meta_Child',
          kind: GRAPH_INHERIT_KIND,
        },
        {
          id: 'rel_items',
          source_model_id: 'meta_Base',
          target_model_id: 'meta_Item',
          forward_name: 'items',
          reverse_name: 'owner',
          kind: GRAPH_NODE_LINK_KIND,
          source_cardinality: 'one',
          target_cardinality: 'many',
        },
        {
          id: 'rel_peers',
          source_model_id: 'meta_Item',
          target_model_id: 'meta_Item',
          forward_name: 'peers',
          reverse_name: 'peeredBy',
          kind: GRAPH_NODE_LINK_KIND,
          source_cardinality: 'many',
          target_cardinality: 'many',
        },
      ]
    : [];
  const chain: QueryChainState = complex
    ? {
        rootModelId: 'meta_Child',
        activeModelId: 'meta_Item',
        primaryRelationIds: ['forward:rel_items', 'forward:rel_peers'],
        branchRelationIds: ['reverse:rel_items::source::qnode_meta_Item_1'],
        constraintRelationIds: [],
        relationUsages: {
          'forward:rel_items': {
            kind: 'inherited',
            childModelId: 'meta_Child',
            ownerModelId: 'meta_Base',
            inheritRelationId: 'old_random_inherit_base',
          },
        },
      }
    : {
        rootModelId: 'meta_Item',
        activeModelId: 'meta_Item',
        primaryRelationIds: [],
        branchRelationIds: [],
        constraintRelationIds: [],
        relationUsages: {},
      };
  const instances = queryChainGraphInstances(chain, relations);
  const query = buildQueryInterfaceDraft({
    rootModelId: chain.rootModelId!,
    models,
    relations,
    graphInstances: instances,
    edgeStates: instances.edges,
    createdAt: fixtureTime,
    permissions: { mode: 'none' },
  });
  query.name = 'Imported_Query';
  query.contract.invocation.callableName = 'Imported_Query';
  const compilation = compilePublishedQueryExecutionTemplate({
    queryInterface: query,
    models,
    relations,
  });
  assert.ok(compilation.template, JSON.stringify(compilation.diagnostics));
  const graph: AssetGraph = {
    version: 1,
    atlas: 'source',
    includeData: !complex,
    models: models.map((model) => ({
      definition: {
        name: model.model_name,
        parentId: model.parent_id?.replace('meta_', '') ?? null,
        fields: [fieldName(model.model_name)],
        fieldTypes: { [fieldName(model.model_name)]: { type: 'String' } },
      },
      rows: complex
        ? []
        : [{ _id: 'synthetic-record', _createdAt: fixtureTime, label: 'Synthetic imported data' }],
    })),
    relations: relations
      .filter((r) => r.kind === GRAPH_NODE_LINK_KIND)
      .map((r) => ({
        definition: {
          source: r.source_model_id.replace('meta_', ''),
          target: r.target_model_id.replace('meta_', ''),
          forward: r.forward_name!,
          reverse: r.reverse_name!,
          logic: r.id === 'rel_peers' ? 'many-to-many' : 'one-to-many',
          matchOn: null,
        },
        index: { fwd: {}, rev: {} },
      })),
  };
  const workspace = new AtlasSingleVault();
  const put = (model: string, data: Record<string, unknown>[]) =>
    workspace.set(
      'm:' + model,
      data
        .map((r) => JSON.stringify({ _createdAt: fixtureTime, library_code: 'source', ...r }))
        .join('\n'),
    );
  put(
    'sys_model',
    models.map((m) => ({
      _id: m.id,
      engine_name: m.model_name,
      name: { en: m.model_name, zh: '合成' + m.model_name },
      description: {},
    })),
  );
  put(
    'sys_props',
    models.map((m) => ({
      _id: 'field_' + m.model_name,
      model_engine_name: m.model_name,
      engine_name: fieldName(m.model_name),
      name: { en: 'Label', zh: '标签' },
    })),
  );
  put(
    'sys_relation',
    relations
      .filter((r) => r.kind === GRAPH_NODE_LINK_KIND)
      .map((r) => ({
        _id: r.id,
        engine_name: r.forward_name,
        name: {},
        canvas_meta: JSON.stringify({
          source: r.source_model_id.replace('meta_', ''),
          target: r.target_model_id.replace('meta_', ''),
          sourceId: r.source_model_id,
          targetId: r.target_model_id,
          engineForward: r.forward_name,
          engineReverse: r.reverse_name,
        }),
      })),
  );
  put('sys_query_interface', [
    {
      _id: 'query-row',
      interface_id: query.id,
      display_name: 'Imported Query',
      query_json: JSON.stringify(query),
      chain_json: JSON.stringify(chain),
      projection_configured: true,
      release_json: JSON.stringify({
        version: query.version.current,
        callableName: 'Imported_Query',
        publishedAt: fixtureTime,
        signature: 'source-signature',
        queryInterface: { ...query, status: 'active' },
        executionTemplate: compilation.template,
      }),
    },
  ]);
  const business = assetGraphVault(graph, 'source');
  const collected = collectDesignerAsset(business, workspace, {
    models: [],
    includeData: !complex,
    designer: { queries: [query.id], operations: [], bindings: [] },
  });
  return { ...collected, business, workspace, models, relations, chain, query };
}

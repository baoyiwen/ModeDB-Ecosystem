import assert from 'node:assert/strict';
import { it } from 'node:test';
import {
  AtlasSingleVault,
  designerAssetRows,
  mapDesignerAsset,
  mergeDesignerAsset,
  validateDesignerAsset,
  type DesignerAssetGraph,
} from '@mode-db/core';
import { designerInheritanceRelationId } from '@mode-db/shared';
import { designerFixture } from '../fixtures/security-designer-asset.js';
import {
  compilePublishedQueryExecutionTemplate,
  queryChainGraphInstances,
  type QueryInterface,
  type QueryChainState,
} from '../../apps/model-designer/src/query-designer/index.js';
import { fetchGraphFromDesignerRows } from '../../apps/model-designer/src/sync/designer-row-hydrate.js';

const mapper = (kind: string, id: string) => kind + '_' + id;
async function hydrate(
  designer: DesignerAssetGraph,
  graph: ReturnType<typeof designerFixture>['graph'],
) {
  const client = {
    model(model: string) {
      return {
        query() {
          return {
            group() {
              return this;
            },
            async execute() {
              return designer.rows
                .filter((r) => r.model === model)
                .map((r) => ({
                  getData: () => ({
                    ...r.data,
                    relates:
                      model === 'sys_model'
                        ? {
                            modelOwnsProps: designer.rows
                              .filter(
                                (p) =>
                                  p.model === 'sys_props' &&
                                  p.data.model_engine_name === r.data.engine_name,
                              )
                              .map((p) => p.data),
                          }
                        : {},
                  }),
                }));
            },
          };
        },
      };
    },
  };
  return fetchGraphFromDesignerRows(client as never, 'received', {
    models: graph.models.map((m) => m.definition),
    relations: graph.relations.map((r) => r.definition),
  } as never);
}
it('maps multilevel inherited usage, repeated nodes and reverse branches to a reopenable graph', async () => {
  const { graph, designer } = designerFixture();
  const mapped = mapDesignerAsset(designer, graph, 'received', mapper);
  validateDesignerAsset(mapped, { ...graph, atlas: 'received' });
  const hydrated = await hydrate(mapped, graph);
  const again = await hydrate(mapped, graph);
  assert.deepEqual(
    hydrated.relations.map((r) => r.id),
    again.relations.map((r) => r.id),
  );
  const row = mapped.rows.find((r) => r.model === 'sys_query_interface')!.data;
  const query = JSON.parse(String(row.query_json)) as QueryInterface;
  const chain = JSON.parse(String(row.chain_json)) as QueryChainState;
  assert.equal(chain.relationUsages!['forward:sys_relation_rel_items']!.kind, 'inherited');
  const inherited = query.designGraph.edges[0]!.inherited!;
  assert.equal(
    inherited.inheritRelationId,
    designerInheritanceRelationId('sys_model_meta_Base', 'sys_model_meta_Mid'),
  );
  assert.ok(hydrated.relations.some((r) => r.id === inherited.inheritRelationId));
  const rebuilt = queryChainGraphInstances(chain, hydrated.relations);
  assert.deepEqual(
    query.designGraph.nodes.map((n) => n.id),
    rebuilt.nodes.map((n) => n.id),
  );
  assert.deepEqual(
    query.designGraph.edges.map((e) => [e.id, e.fromNodeId, e.toNodeId]),
    rebuilt.edges.map((e) => ['edge_' + e.id, e.sourceNodeId, e.targetNodeId]),
  );
  const compiled = compilePublishedQueryExecutionTemplate({
    queryInterface: query,
    models: hydrated.models,
    relations: hydrated.relations,
  });
  assert.ok(compiled.template, JSON.stringify(compiled.diagnostics));
  const vault = mergeDesignerAsset(new AtlasSingleVault(), mapped, 'designer', graph);
  const parents = JSON.parse(vault.get('r:sys_model-sys_model-modelBelongsToParent')!);
  assert.deepEqual(parents.fwd.sys_model_meta_Child, ['sys_model_meta_Mid']);
  assert.equal(designerAssetRows(vault, 'sys_query_interface').length, 1);
});
it('preserves constraint design references without claiming unsupported query execution is available', () => {
  const { graph, designer } = designerFixture();
  const row = designer.rows.find((r) => r.model === 'sys_query_interface')!.data;
  const chain = JSON.parse(String(row.chain_json));
  chain.constraintRelationIds = ['reverse:rel_peers::source::qnode_meta_Item_1'];
  row.chain_json = JSON.stringify(chain);
  const mapped = mapDesignerAsset(designer, graph, 'received', mapper);
  const result = JSON.parse(
    String(mapped.rows.find((r) => r.model === 'sys_query_interface')!.data.chain_json),
  );
  assert.deepEqual(result.constraintRelationIds, [
    'reverse:sys_relation_rel_peers::source::qnode_sys_model_meta_Item_1',
  ]);
});
it('rejects forged ancestry, virtual IDs aliasing entities and chain usages outside the selected edges', () => {
  const { graph, designer } = designerFixture();
  for (const change of [
    (q: any) => {
      q.designGraph.edges[0].inherited.ownerModelId = 'meta_Item';
    },
    (q: any) => {
      q.designGraph.edges[0].inherited.inheritRelationId = 'rel_items';
    },
  ]) {
    const bad = structuredClone(designer),
      row = bad.rows.find((r) => r.model === 'sys_query_interface')!.data;
    const q = JSON.parse(String(row.query_json));
    change(q);
    row.query_json = JSON.stringify(q);
    assert.throws(() => validateDesignerAsset(bad, graph));
  }
  const bad = structuredClone(designer),
    row = bad.rows.find((r) => r.model === 'sys_query_interface')!.data;
  const chain = JSON.parse(String(row.chain_json));
  chain.relationUsages['forward:missing'] = { kind: 'direct' };
  row.chain_json = JSON.stringify(chain);
  assert.throws(() => validateDesignerAsset(bad, graph));
});
it('rejects dangling, ambiguous and wrong-model chain source nodes', () => {
  const { graph, designer } = designerFixture();
  const original = designer.rows.find((r) => r.model === 'sys_query_interface')!.data;
  const rootNodeId = JSON.parse(String(original.query_json)).designGraph.rootNodeId;
  for (const suffix of [
    'qnode_missing_1',
    rootNodeId,
    'qnode_meta_Item_1::source::qnode_meta_Item_1',
  ]) {
    const bad = structuredClone(designer),
      row = bad.rows.find((r) => r.model === 'sys_query_interface')!.data;
    const chain = JSON.parse(String(row.chain_json));
    chain.branchRelationIds = ['reverse:rel_items::source::' + suffix];
    row.chain_json = JSON.stringify(chain);
    assert.throws(() => validateDesignerAsset(bad, graph), suffix);
  }
  const bad = structuredClone(designer),
    row = bad.rows.find((r) => r.model === 'sys_query_interface')!.data;
  const query = JSON.parse(String(row.query_json));
  query.designGraph.nodes.push(
    structuredClone(
      query.designGraph.nodes.find((n: { id: string }) => n.id === 'qnode_meta_Item_1'),
    ),
  );
  row.query_json = JSON.stringify(query);
  assert.throws(() => validateDesignerAsset(bad, graph));
  // A source node for inherited traversal represents the child identity, not its owner.
  const valid = structuredClone(designer),
    validRow = valid.rows.find((r) => r.model === 'sys_query_interface')!.data;
  const chain = JSON.parse(String(validRow.chain_json));
  const key = 'forward:rel_items::source::' + rootNodeId;
  chain.primaryRelationIds[0] = key;
  chain.relationUsages[key] = chain.relationUsages['forward:rel_items'];
  delete chain.relationUsages['forward:rel_items'];
  validRow.chain_json = JSON.stringify(chain);
  assert.doesNotThrow(() => validateDesignerAsset(valid, graph));
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TransferPackage } from '@mode-db/data-kit';
import { buildInterfaceTransfer, interfaceTransferIssues } from '../../apps/model-designer/src/data-transfer/interface-transfer.js';
import { readTransferWorkbook, writeTransferWorkbook } from '../../apps/model-designer/src/data-transfer/workbook.js';
import { normalizePivotResult } from '../../apps/model-designer/src/pivot/normalizer.js';
import { customerOrdersQueryFixture } from '../../apps/model-designer/src/query-designer/fixtures.js';
import type { QueryInterfaceRelease } from '../../apps/model-designer/src/query-designer/query-interface-publication.js';
import type { EngineModelNode, EngineRelationEdge } from '../../apps/model-designer/src/types/engine-schema.js';
import zh from '../../apps/model-designer/src/i18n/locales/zh/ui.json';

const prop = (name: string, type = 'String') => ({ id: name, name, type, is_primary: false, encrypt_level: 0, name_i18n: { zh: name === 'name' ? '名称' : name }, metadata: {} });
const models: EngineModelNode[] = [
  { id: 'node-model', model_name: 'Node', parent_id: null, name_i18n: { zh: '节点' }, props_objects_array: [prop('name', 'I18N'), prop('score', 'Int'), prop('secret')] },
  { id: 'group-model', model_name: 'Group', parent_id: null, props_objects_array: [prop('title')] },
];
const relations: EngineRelationEdge[] = [
  { id: 'self', kind: 'relation', source_model_id: 'node-model', target_model_id: 'node-model', forward_name: 'children', reverse_name: 'parent' },
  { id: 'group', kind: 'relation', source_model_id: 'group-model', target_model_id: 'node-model', forward_name: 'nodes', reverse_name: 'group' },
];
function release(): QueryInterfaceRelease {
  const asset = structuredClone(customerOrdersQueryFixture);
  asset.status = 'active';
  asset.query.result.includesRecordRefs = true;
  asset.designGraph = { rootNodeId: 'root', nodes: [
    { id: 'root', modelId: 'node-model', alias: 'root', role: 'root' },
    { id: 'child', modelId: 'node-model', alias: 'child', role: 'joined' },
    { id: 'group', modelId: 'group-model', alias: 'group', role: 'joined' },
  ], edges: [
    { id: 'children', relationId: 'self', fromNodeId: 'root', toNodeId: 'child', alias: 'children', traversal: 'forward', required: false, cardinality: 'many' },
    { id: 'group-edge', relationId: 'group', fromNodeId: 'child', toNodeId: 'group', alias: 'group', traversal: 'reverse', required: false, cardinality: 'one' },
  ] };
  return { version: '1.0.0', callableName: 'fixture', publishedAt: '2026-10-17T00:00:00Z', signature: 'signature', queryInterface: asset, executionTemplate: {
    format: 1, snapshot: { plan: { version: 2, originModel: 'Node', start: { kind: 'all' }, hops: [], trailing: { type: 'group', logic: 'AND', children: [] } }, execute: {}, analysis: { groupBy: null, compute: null } }, parameters: [], pagination: { mode: 'none' },
    resultAdapter: { kind: 'rows', rootNodeId: 'root', fieldsByNode: { root: [{ sourceField: 'name', outputName: 'label' }], child: [{ sourceField: 'name', outputName: 'label' }, { sourceField: 'score', outputName: 'points' }], group: [{ sourceField: 'title', outputName: 'title' }] }, edgesBySource: { root: [{ toNodeId: 'child', relationName: 'children', outputName: 'children' }], child: [{ toNodeId: 'group', relationName: 'group', outputName: 'group' }] } },
  } };
}
const ref = (nodeId: string, model: string, id: string) => ({ nodeId, model, id });
function pack(version = release()): TransferPackage {
  const child = { $recordRef: ref('child', 'Node', 'c'), label: { zh: '子', en: 'Child' }, points: 0, secret: 'must not export', group: [{ $recordRef: ref('group', 'Group', 'g'), title: 'Group' }] };
  const document = normalizePivotResult({ source: { kind: 'interface', callableName: 'fixture', version: '1.0.0' }, rows: [{ $recordRef: ref('root', 'Node', 'p'), label: { zh: '父', en: 'Parent' }, children: [child, child] }, { $recordRef: ref('root', 'Node', 'c'), label: { zh: '子', en: 'Child' }, children: [] }] });
  return buildInterfaceTransfer({ database: 'fixture', release: version, models, relations, locale: 'zh', document });
}

describe('published interface data transfer', () => {
  it('uses current catalog types without widening the published projection', () => {
    const stale = models.map((model) => ({ ...model, props_objects_array: model.props_objects_array.map((field) => ({ ...field, type: 'String' })) }));
    const schema = pack().manifest.models;
    const input = { database: 'fixture', release: release(), models: stale, relations, locale: 'zh', template: true, schema };
    const template = buildInterfaceTransfer(input);
    assert.equal(template.manifest.models[0]?.fields.find((field) => field.name === 'score')?.type, 'Int');
    assert.equal(template.manifest.models[0]?.fields.find((field) => field.name === 'name')?.type, 'I18N');
    assert.ok(!template.manifest.models[0]?.fields.some((field) => field.name === 'secret'));
    assert.throws(() => buildInterfaceTransfer({ ...input, schema: schema.map((model) => ({ ...model, fields: model.fields.filter((field) => field.name !== 'score') })) }), /field/);
  });
  it('uses projected fields, deduplicates model IDs and preserves nested/self/reverse paths', () => {
    const data = pack();
    assert.equal(data.manifest.kind, 'data');
    assert.deepEqual(data.manifest.models.map((model) => model.sheet), ['Node', 'Group']);
    assert.equal(data.rows.length, 3);
    assert.equal(data.paths?.length, 6);
    assert.equal(data.edges.length, 2);
    assert.deepEqual(data.rows.find((row) => row.id === 'c')?.values, { name: { zh: '子', en: 'Child' }, score: 0 });
    assert.ok(!JSON.stringify(data).includes('must not export'));
    assert.ok(!data.manifest.models.some((model) => model.fields.some((field) => field.name === 'secret')));
    assert.ok(data.edges.some((edge) => edge.source === 'Group' && edge.sourceRef === 'id:g' && edge.targetRef === 'id:c'));
    const allowed = buildInterfaceTransfer({ database: 'fixture', release: release(), models, relations, locale: 'zh', template: true });
    assert.deepEqual(interfaceTransferIssues(data, allowed, release(), models), []);
  });
  it('round-trips interface identity, original IDs, relationships, full languages and paths in Excel', async () => {
    const original = pack();
    const bytes = await writeTransferWorkbook(original, (key) => (zh as Record<string, string>)[key] ?? key);
    const parsed = await readTransferWorkbook(bytes.buffer);
    assert.deepEqual(parsed.manifest, original.manifest);
    assert.deepEqual(parsed.paths, original.paths);
    assert.deepEqual(parsed.edges, original.edges.map(({ selfLoopPolicy: _policy, ...edge }) => edge));
    assert.deepEqual(parsed.rows.map((row) => ({ ...row, values: { ...row.values } })), original.rows);
  });
  it('exports missing-ID results as reports and refuses to read those reports for import', async () => {
    const version = release();
    version.queryInterface.query.result.includesRecordRefs = false;
    const data = pack(version);
    assert.equal(data.manifest.kind, 'report');
    const bytes = await writeTransferWorkbook(data, (key) => key);
    await assert.rejects(readTransferWorkbook(bytes.buffer), /reportOnly/);
    const document = normalizePivotResult({ source: { kind: 'interface', callableName: 'fixture', version: '1' }, rows: [{ label: { zh: '无 ID' }, children: [] }] });
    assert.equal(buildInterfaceTransfer({ database: 'fixture', release: release(), models, relations, locale: 'zh', document }).manifest.kind, 'report');
  });
  it('exports aggregated values as reports and rejects aggregate templates', () => {
    const version = release();
    version.executionTemplate = { ...version.executionTemplate, resultAdapter: { kind: 'aggregation', dimensions: [{ sourceField: 'status', outputName: 'status' }], metrics: [{ wireKey: 'count', outputName: 'total' }] } };
    const document = normalizePivotResult({ source: { kind: 'interface', callableName: 'fixture', version: '1' }, rows: [{ status: 'A', total: 0, private: 99 }] });
    const input = { database: 'fixture', release: version, models, relations, locale: 'zh', document };
    assert.deepEqual(buildInterfaceTransfer(input).rows[0]?.values, { status: 'A', total: 0 });
    assert.throws(() => buildInterfaceTransfer({ ...input, template: true }), /reportOnly/);
  });
  it('rejects widened fields, foreign releases, malformed paths and unselected relationships', () => {
    const data = pack();
    const allowed = buildInterfaceTransfer({ database: 'fixture', release: release(), models, relations, locale: 'zh', template: true });
    const bad = { ...data, manifest: { ...data.manifest, interfaceSource: { ...data.manifest.interfaceSource!, version: '2.0.0' }, models: [{ ...data.manifest.models[0]!, fields: [...data.manifest.models[0]!.fields, { name: 'secret', type: 'String', label: 'secret' }] }] }, paths: data.paths!.map((path, index) => index === 0 ? { ...path, model: 'Group' } : path), edges: [{ ...data.edges[0]!, forward: 'unselected' }] };
    const codes = interfaceTransferIssues(bad, allowed, release(), models).map((issue) => issue.code);
    for (const code of ['interfaceSource', 'field', 'interfacePath', 'relation']) assert.ok(codes.includes(code), code);
  });
  it('rejects inconsistent values for the same identity instead of choosing a path silently', () => {
    const document = normalizePivotResult({ source: { kind: 'interface', callableName: 'fixture', version: '1' }, rows: [{ $recordRef: ref('root', 'Node', 'x'), label: 'A' }, { $recordRef: ref('root', 'Node', 'x'), label: 'B' }] });
    assert.throws(() => buildInterfaceTransfer({ database: 'fixture', release: release(), models, relations, locale: 'zh', document }), /interfaceConflict/);
  });
});

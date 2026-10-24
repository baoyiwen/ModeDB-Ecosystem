import assert from 'node:assert/strict';
import { it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { constants, createCipheriv, generateKeyPairSync, publicEncrypt, randomBytes, sign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetGraphVault, AtlasSingleVault, AuthoringEngine, collectDesignerAsset, designerAssetRows, mapDesignerAsset, mergeDesignerAsset, readAtlasVaultKeyReferenceFromBytes, validateDesignerAsset, type AssetGraph, type DesignerAssetGraph } from '@mode-db/core';
import { importDesignerAsset, previewDesignerAssetImport } from '../../packages/server/src/designer-asset-transfer.js';
import { openAnyAssetPackage, openAssetPackage, sealDesignerAssetPackage, type DesignerAssetContent } from '../../packages/server/src/security/asset-package.js';
import { backupRecipientId } from '../../packages/server/src/security/backup-package.js';
import { LocalVaultKeyProvider } from '../../packages/server/src/security/local-vault-key-provider.js';
import { SecurityRegistry } from '../../packages/server/src/security/security-registry.js';
import { executePublishedQueryInterface } from '../../packages/server/src/published-interface-runtime.js';
import { createAssetSigningKey, createMigrationKey } from '../../packages/server/src/security/migration-key.js';
import { WindowsSecretProtector } from '../../packages/server/src/security/windows-secret-protector.js';
import { ensureModelDbLayoutAtRoot } from '../../packages/server/src/modeldb-default-home.js';
import { fetchGraphFromDesignerRows } from '../../apps/model-designer/src/sync/designer-row-hydrate.js';
import { fileDigest, stableStringify } from '@mode-db/common';

const now = '2026-10-23T00:00:00.000Z';
const protector = { id: 'synthetic-designer-asset', ensureDirectory(p: string) { mkdirSync(p, { recursive: true }); }, protect(b: Uint8Array) { return Buffer.from(b).toString('base64'); }, unprotect(s: string) { return Buffer.from(s, 'base64'); } };
const recipient = generateKeyPairSync('rsa', { modulusLength: 3072 });
const publisher = generateKeyPairSync('rsa', { modulusLength: 3072 });
const tsx = fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url));
function graph(): AssetGraph {
  return { version: 1, atlas: 'source', includeData: false, models: ['Item', 'Extra', 'Unselected'].map(name => ({ definition: { name, parentId: null, fields: ['label'], fieldTypes: { label: { type: 'String' } } }, rows: [] })), relations: [] };
}
function row(_id: string, values: Record<string, unknown>) { return { _id, _createdAt: now, ...values }; }
function draft(id: string, kind: 'query' | 'operation', modelId: string) {
  return { id, kind, name: id, status: 'active', version: { current: '1.0.0', compatibility: 'compatible' }, contract: { permissions: { mode: 'key', accessKeyDigest: '1'.repeat(64) }, input: { parameters: [] } }, designGraph: { rootNodeId: 'node', nodes: [{ id: 'node', modelId }], edges: [] }, dependencies: { models: [modelId], fields: [], relations: [], interfaces: [] }, lifecycle: { createdAt: now, updatedAt: now, createdBy: 'synthetic-source-operator' }, ...(kind === 'query' ? { query: { result: { shape: 'flat', schema: [], sample: { secret: 'synthetic-execution-sample' } }, filters: [{ target: { nodeId: 'node', modelId, fieldId: 'label' }, value: { kind: 'literal', value: { modelId, interfaceId: 'query' } } }] } } : { operation: { operationType: 'create', target: { kind: 'model', modelId } } }) };
}
function source() {
  const workspace = new AtlasSingleVault();
  const put = (model: string, rows: Record<string, unknown>[]) => workspace.set(AtlasSingleVault.modelKey(model), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  put('sys_data_asset_map', [row('library', { code: 'source', name: { zh: '合成资产', en: 'Synthetic asset', ja: '合成資産' }, description: {} }), row('otherlibrary', { code: 'other', name: { en: 'UNSELECTED_LIBRARY' } })]);
  put('sys_model', [row('item-metadata', { library_code: 'source', engine_name: 'Item', name: { zh: '条目' }, description: {}, canvas_meta: JSON.stringify({ position: { x: 10, y: 20 }, z_index: 2, position_locked: false, edge_bend_hints: { secret: 'UNSELECTED_BEND' } }) }), row('extra-metadata', { library_code: 'source', engine_name: 'Extra', name: {}, description: {} })]);
  put('sys_props', [row('item-field', { library_code: 'source', engine_name: 'label', model_engine_name: 'Item', name: { zh: '标签' } })]);
  const query = draft('query', 'query', 'item-metadata');
  const template = { format: 1, snapshot: { plan: { version: 2, originModel: 'Item', start: { kind: 'all' }, hops: [], trailing: { type: 'group', logic: 'AND', children: [] } }, execute: {}, analysis: { groupBy: null, compute: null } }, parameters: [], resultAdapter: { kind: 'rows', rootNodeId: 'node', fieldsByNode: {}, edgesBySource: {} }, pagination: { mode: 'none' } };
  const release = (version: string) => ({ version, callableName: 'query', publishedAt: now, signature: 'source-signature', queryInterface: query, executionTemplate: template });
  put('sys_query_interface', [row('query-storage', { library_code: 'source', interface_id: 'query', display_name: 'Query', query_json: JSON.stringify(query), chain_json: JSON.stringify({ rootModelId: 'item-metadata', primaryRelationIds: [], branchRelationIds: [], constraintRelationIds: [], activeModelId: 'item-metadata' }), release_json: JSON.stringify(release('2.0.0')), release_history_json: JSON.stringify([release('1.0.0')]) }), row('other-query', { library_code: 'source', interface_id: 'unselected-query', display_name: 'UNSELECTED_QUERY' })]);
  const operation = draft('operation', 'operation', 'extra-metadata');
  put('sys_operation_interface', [row('operation-storage', { library_code: 'source', interface_id: 'operation', display_name: 'Operation', operation_json: JSON.stringify(operation), release_json: JSON.stringify({ version: '1.0.0', callableName: 'operation', publishedAt: now, signature: 'source-signature', operationInterface: operation, executionTemplate: { format: 1, operation: { op: 'insert', model: 'Extra', data: { label: 'synthetic-literal' } }, parameters: [], result: { returns: 'record' } } }) })]);
  const binding = { id: 'binding', kind: 'binding', name: 'binding', status: 'active', version: { current: '1.0.0' }, query: { interfaceId: 'query', version: '1.0.0', parameterBindings: [] }, writeback: { mode: 'explicit', mutations: [{ id: 'create', operation: { interfaceId: 'operation', version: '1.0.0' } }], refresh: 'manual' }, parameters: [], lifecycle: { createdAt: now, updatedAt: now } };
  put('sys_binding_surface', [row('binding-storage', { library_code: 'source', surface_id: 'binding', display_name: 'Binding', surface_json: JSON.stringify(binding), release_json: JSON.stringify({ version: '1.0.0', signature: 'source-signature', bindingSurface: binding, contract: { format: 1, surfaceId: 'binding', name: 'binding', version: '1.0.0', parameters: [], query: { interfaceId: 'query', callableName: 'query', version: '1.0.0', parameterBindings: [] }, writeback: { mode: 'readonly', mutations: [], refresh: 'manual' } } }) })]);
  put('sys_query_interface_call_log', [row('log', { library_code: 'source', callable_name: 'UNSELECTED_CALL_LOG' })]);
  put('sys_designer_graph', [row('snapshot', { library_code: 'source', graph_b64: 'UNSELECTED_SNAPSHOT' })]);
  return { business: assetGraphVault(graph(), 'source'), workspace };
}
function collected() { const { business, workspace } = source(); return collectDesignerAsset(business, workspace, { models: ['Item'], includeData: false, designer: { queries: [], operations: [], bindings: ['binding'] } }); }
function content(): DesignerAssetContent {
  const { graph, designer } = collected();
  return openAnyAssetPackage(sealDesignerAssetPackage(graph, designer, { assetId: 'designer-test', assetVersion: '1.0.0', sourceInstanceId: 'synthetic-source' }, recipient.publicKey, publisher.privateKey), recipient.privateKey, publisher.publicKey, backupRecipientId(publisher.publicKey)) as DesignerAssetContent;
}
async function temp(run: (root: string) => unknown) { const root = mkdtempSync(join(tmpdir(), 'modedb-designer-asset-')); try { await run(root); } finally { rmSync(root, { recursive: true, force: true }); } }
function input(root: string, asset = content()) {
  const securityDirectory = join(root, 'security'), provider = new LocalVaultKeyProvider(securityDirectory, protector), registry = SecurityRegistry.open(securityDirectory, { protector, resumeAssetPublication: true });
  return { content: asset, storageRoot: join(root, 'vault'), database: 'received', instanceId: registry.status().instanceId, designerWorkspace: 'model_designer_workspace', securityDirectory, provider, registry };
}
it('collects pinned Binding Surface dependencies, model closure and display metadata without logs, samples or source trust', () => {
  const { graph, designer } = collected();
  assert.deepEqual(graph.models.map(m => m.definition.name), ['Item', 'Extra']);
  assert.equal(designer.rows.filter(r => r.model.startsWith('sys_') && r.model.endsWith('interface')).length, 2);
  const raw = JSON.stringify(designer);
  for (const excluded of ['Unselected', 'UNSELECTED_', 'accessKeyDigest', 'synthetic-source-operator', 'synthetic-execution-sample']) assert.equal(raw.includes(excluded), false, excluded);
  assert.ok(raw.includes('disabled')); assert.ok(raw.includes('条目'));
  const query = designer.rows.find(r => r.model === 'sys_query_interface')!.data;
  assert.equal(JSON.parse(String(query.release_history_json))[0].version, '1.0.0');
  const broken = source(); const binding = designerAssetRows(broken.workspace, 'sys_binding_surface')[0]!;
  const doc = JSON.parse(String(binding.surface_json)); doc.query.version = '99.0.0'; binding.surface_json = JSON.stringify(doc);
  broken.workspace.set('m:sys_binding_surface', JSON.stringify(binding));
  assert.throws(() => collectDesignerAsset(broken.business, broken.workspace, { models: ['Item'], includeData: false, designer: { queries: [], operations: [], bindings: ['binding'] } }));
});
it('v2 is explicitly separated from frozen v1 and authenticates the metadata as well as the business graph', () => {
  const { graph, designer } = collected(); const bytes = sealDesignerAssetPackage(graph, designer, { assetId: 'designer-test', assetVersion: '1.0.0', sourceInstanceId: 'synthetic-source' }, recipient.publicKey, publisher.privateKey);
  assert.equal(JSON.parse(bytes.toString()).format, 'modeldb.asset.v2');
  assert.throws(() => openAssetPackage(bytes, recipient.privateKey, publisher.publicKey, backupRecipientId(publisher.publicKey)));
  assert.equal(bytes.includes(Buffer.from('条目')), false);
  const bad = structuredClone(designer); bad.rows[0]!.data.extra = 'forbidden'; assert.throws(() => validateDesignerAsset(bad, graph));
  const ambiguous = structuredClone(designer); const op = ambiguous.rows.find(r => r.model === 'sys_operation_interface')!.data; op.interface_id = 'query'; op.operation_json = String(op.operation_json).replaceAll('"id":"operation"', '"id":"query"'); op.release_json = String(op.release_json).replaceAll('"id":"operation"', '"id":"query"'); assert.throws(() => validateDesignerAsset(ambiguous, graph));
  const unsafe = structuredClone(designer); const q = unsafe.rows.find(r => r.model === 'sys_query_interface')!.data;
  const doc = JSON.parse(String(q.query_json)); doc.contract.permissions = { mode: 'none' }; q.query_json = JSON.stringify(doc);
  assert.throws(() => sealDesignerAssetPackage(graph, unsafe, { assetId: 'bad', assetVersion: '1.0.0', sourceInstanceId: 'synthetic-source' }, recipient.publicKey, publisher.privateKey));
});
it('rejects correctly signed malicious v2 metadata before any target creation', () => temp(root => {
  const valid = content();
  const maliciousPackage = (value: DesignerAssetContent) => {
    const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
    const pek = randomBytes(32), iv = randomBytes(12), publisherId = backupRecipientId(publisher.publicKey);
    const header = b64(Buffer.from(JSON.stringify({ alg: 'RSA-OAEP-256', enc: 'A256GCM', typ: 'modeldb.asset.v2', kid: backupRecipientId(recipient.publicKey) })));
    const cipher = createCipheriv('aes-256-gcm', pek, iv); cipher.setAAD(Buffer.from(header));
    const encrypted = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value))), cipher.final()]);
    const wrapped = publicEncrypt({ key: recipient.publicKey, oaepHash: 'sha256', padding: constants.RSA_PKCS1_OAEP_PADDING }, pek); pek.fill(0);
    const payload = b64(Buffer.from([header, b64(wrapped), b64(iv), b64(encrypted), b64(cipher.getAuthTag())].join('.')));
    const protectedHeader = b64(Buffer.from(JSON.stringify({ alg: 'PS256', typ: 'modeldb.asset.v2', kid: publisherId })));
    return Buffer.from(JSON.stringify({ format: 'modeldb.asset.v2', protected: protectedHeader, payload, signature: b64(sign('sha256', Buffer.from(protectedHeader + '.' + payload), { key: publisher.privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 })) }));
  };
  for (const mutate of [
    (value: DesignerAssetContent) => { value.designer.rows[0]!.data.code = 'other-library'; },
    (value: DesignerAssetContent) => { const q = value.designer.rows.find(r => r.model === 'sys_query_interface')!.data; const doc = JSON.parse(String(q.query_json)); delete doc.contract.permissions; q.query_json = JSON.stringify(doc); },
    (value: DesignerAssetContent) => { const q = value.designer.rows.find(r => r.model === 'sys_query_interface')!.data; const release = JSON.parse(String(q.release_json)); release.executionTemplate.snapshot.plan.originModel = 'OutsideAsset'; q.release_json = JSON.stringify(release); },
    (value: DesignerAssetContent) => { const q = value.designer.rows.find(r => r.model === 'sys_query_interface')!.data; q.chain_json = '{"rootModelId":"item-metadata","primaryRelationIds":["forward:missing"],"branchRelationIds":[],"constraintRelationIds":[]}'; },
    (value: DesignerAssetContent) => { const q = value.designer.rows.find(r => r.model === 'sys_query_interface')!.data; const doc = JSON.parse(String(q.query_json)); doc.designGraph.nodes[0].inherited = { inheritRelationId: 'unmapped-virtual-inheritance' }; q.query_json = JSON.stringify(doc); },
  ]) {
    const malicious = structuredClone(valid); mutate(malicious);
    const body = { ...malicious, contentDigest: fileDigest(Buffer.from(stableStringify({ graph: malicious.graph, designer: malicious.designer }))) };
    assert.throws(() => openAnyAssetPackage(maliciousPackage(body), recipient.privateKey, publisher.publicKey, backupRecipientId(publisher.publicKey)));
    assert.equal(existsSync(join(root, 'vault')), false);
  }
}));
it('maps Designer references by context and keeps literal values, engine names and pinned versions', () => {
  const { graph, designer } = collected(); const mapped = mapDesignerAsset(designer, graph, 'received', (kind, id) => kind + '_' + id);
  const q = mapped.rows.find(r => r.model === 'sys_query_interface')!.data, doc = JSON.parse(String(q.query_json));
  assert.equal(doc.id, 'sys_query_interface_query'); assert.equal(doc.designGraph.nodes[0].modelId, 'sys_model_item-metadata');
  assert.equal(doc.query.filters[0].target.fieldId, 'sys_props_item-field');
  assert.deepEqual(doc.query.filters[0].value.value, { modelId: 'item-metadata', interfaceId: 'query' });
  const binding = JSON.parse(String(mapped.rows.find(r => r.model === 'sys_binding_surface')!.data.surface_json));
  assert.equal(binding.query.interfaceId, 'sys_query_interface_query'); assert.equal(binding.query.version, '1.0.0');
  assert.equal(q.library_code, 'received');
});
it('hydrates mapped display names, positions and endpoint-scoped relations through the existing Designer reader', async () => {
  const businessGraph = graph();
  // Two relationships share a forward label on distinct endpoint pairs.
  const graphWithRelations: AssetGraph = { ...businessGraph, relations: [
    { definition: { source: 'Item', target: 'Extra', forward: 'items', reverse: 'owner', logic: 'one-to-many', matchOn: null }, index: { fwd: {}, rev: {} } },
    { definition: { source: 'Extra', target: 'Unselected', forward: 'items', reverse: 'owner', logic: 'one-to-many', matchOn: null }, index: { fwd: {}, rev: {} } },
  ] };
  const { workspace } = source();
  workspace.set('m:sys_model', workspace.get('m:sys_model')! + JSON.stringify(row('third-metadata', { library_code: 'source', engine_name: 'Unselected', name: { en: 'Third' } })) + '\n');
  workspace.set('m:sys_relation', [
    row('first-relation', { library_code: 'source', engine_name: 'items', name: { zh: '明细' }, canvas_meta: JSON.stringify({ engineForward: 'items', engineReverse: 'owner', source: 'Item', target: 'Extra', sourceId: 'item-metadata', targetId: 'extra-metadata' }) }),
    row('second-relation', { library_code: 'source', engine_name: 'items', name: { en: 'Others' }, canvas_meta: JSON.stringify({ engineForward: 'items', engineReverse: 'owner', source: 'Extra', target: 'Unselected', sourceId: 'extra-metadata', targetId: 'third-metadata' }) }),
  ].map(r => JSON.stringify(r)).join('\n'));
  const assets = collectDesignerAsset(assetGraphVault(graphWithRelations, 'source'), workspace, { models: ['Item', 'Extra'], includeData: false, designer: { queries: [], operations: [], bindings: [] } });
  assert.equal(assets.designer.rows.filter(r => r.model === 'sys_relation').length, 1);
  const mapped = mapDesignerAsset(assets.designer, assets.graph, 'received', (kind, id) => kind + '_' + id);
  const client = { model(model: string) { return { query() { return { group() { return this; }, async execute() { return mapped.rows.filter(r => r.model === model).map(r => ({ getData: () => ({ ...r.data, relates: model === 'sys_model' ? { modelOwnsProps: mapped.rows.filter(p => p.model === 'sys_props' && p.data.model_engine_name === r.data.engine_name).map(p => p.data) } : {} }) })); } }; } }; } };
  const hydrated = await fetchGraphFromDesignerRows(client as never, 'received');
  assert.equal(hydrated.models.find(m => m.model_name === 'Item')!.name_i18n!.zh, '条目');
  assert.equal(hydrated.relations.length, 1); assert.equal(hydrated.relations[0]!.source_model_id, 'sys_model_item-metadata'); assert.equal(hydrated.relations[0]!.target_model_id, 'sys_model_extra-metadata');
  assert.ok(hydrated.layouts.some(layout => layout.position.x === 10 && layout.position.y === 20));
});
it('previews without new target keys, rejects stale confirmation, publishes both stores and leaves interfaces disabled', () => temp(async root => {
  const i = input(root);
  try {
    const before = readdirSync(i.securityDirectory).sort(); const preview = previewDesignerAssetImport(i);
    assert.deepEqual(preview.conflicts, []); assert.deepEqual(readdirSync(i.securityDirectory).sort(), before); assert.equal(existsSync(i.storageRoot), false);
    assert.throws(() => importDesignerAsset({ ...i, confirmationDigest: '0'.repeat(64) }), { code: 'SECURITY_CONFIRMATION_REQUIRED' });
    const result = importDesignerAsset({ ...i, confirmationDigest: preview.confirmationDigest }); assert.equal(result.published, true);
    assert.equal(existsSync(join(i.securityDirectory, 'asset-publication.mld')), false);
    const bridge = new Map<string, AuthoringEngine>();
    const getEngine = async (atlas: string) => { let engine = bridge.get(atlas); if (!engine) { engine = new AuthoringEngine({ atlas, storageRoot: i.storageRoot, keyProvider: i.provider, engineLogger: false }); bridge.set(atlas, engine); } return engine; };
    try {
      const business = await getEngine('received'); assert.deepEqual(business.registry.getModelDefinitions().map(m => m.name), ['Item', 'Extra']);
      const workspace = await getEngine(i.designerWorkspace); const rows = designerAssetRows(workspace.atlasVault!, 'sys_query_interface'); assert.equal(rows.length, 1); assert.equal(rows[0]!.library_code, 'received');
      await assert.rejects(executePublishedQueryInterface({ atlas: 'received', designerWorkspace: i.designerWorkspace, body: { op: 'executeInterface', callableName: 'query', parameters: {} } as never, getEngine }), /DISABLED/);
    } finally { for (const engine of bridge.values()) await engine.close(); }
    // Opening/closing a real engine may normalize the workspace. Idempotency rejects any changed revision.
  } finally { i.registry.close(); }
  const registry = SecurityRegistry.open(join(root, 'security'), { protector }); registry.close();
}));
it('preserves unrelated Designer data and binds confirmation to its current encrypted revision', () => temp(root => {
  const i = input(root);
  try {
    const workspace = new AtlasSingleVault(); workspace.set('unrelated-entry', 'synthetic-unrelated');
    const old: DesignerAssetGraph = { version: 1, rows: [{ model: 'sys_data_asset_map', data: row('old-library', { code: 'other', name: { en: 'Keep' } }) }] };
    const prepared = mergeDesignerAsset(workspace, old, i.designerWorkspace), key = i.provider.resolveKey(i.designerWorkspace);
    mkdirSync(join(i.storageRoot, i.designerWorkspace), { recursive: true }); const path = join(i.storageRoot, i.designerWorkspace, 'atlas.mld');
    try { prepared.saveSync(path, key); const stale = previewDesignerAssetImport(i); prepared.set('changed-entry', 'synthetic-new-revision'); prepared.saveSync(path, key); assert.throws(() => importDesignerAsset({ ...i, confirmationDigest: stale.confirmationDigest }), { code: 'SECURITY_CONFIRMATION_REQUIRED' }); } finally { key.key.fill(0); }
    const preview = previewDesignerAssetImport(i); importDesignerAsset({ ...i, confirmationDigest: preview.confirmationDigest });
    const raw = readFileSync(path), material = i.provider.resolveKey(i.designerWorkspace, readAtlasVaultKeyReferenceFromBytes(raw)), after = new AtlasSingleVault(); try { after.loadBytes(raw, material); } finally { material.key.fill(0); }
    assert.equal(after.get('unrelated-entry'), 'synthetic-unrelated'); assert.equal(after.get('changed-entry'), 'synthetic-new-revision');
    assert.equal(designerAssetRows(after, 'sys_data_asset_map').length, 2);
    const repeated = previewDesignerAssetImport(i); assert.equal(repeated.published, true); assert.equal(importDesignerAsset({ ...i, confirmationDigest: repeated.confirmationDigest }).resumed, true);
  } finally { i.registry.close(); }
}));
it('retains changed candidates, live locks and existing target metadata rather than clearing them to resume', () => temp(root => {
  const i = input(root);
  try {
    assert.throws(() => importDesignerAsset({ ...i, confirmationDigest: previewDesignerAssetImport(i).confirmationDigest, onPoint(point) { if (point === 'prepared') throw new Error('synthetic-interruption'); } }));
    const taskPath = join(i.securityDirectory, 'asset-publication.mld'), task = readFileSync(taskPath);
    writeFileSync(taskPath + '.pending', 'synthetic-invalid-task-candidate'); assert.throws(() => previewDesignerAssetImport(i)); assert.equal(readFileSync(taskPath + '.pending', 'utf8'), 'synthetic-invalid-task-candidate'); rmSync(taskPath + '.pending');
    const targetDirectory = join(i.storageRoot, i.database); mkdirSync(targetDirectory, { recursive: true });
    const pending = join(targetDirectory, 'atlas.mld.pending'); writeFileSync(pending, 'synthetic-invalid-candidate');
    assert.throws(() => previewDesignerAssetImport(i)); assert.equal(readFileSync(pending, 'utf8'), 'synthetic-invalid-candidate'); assert.deepEqual(readFileSync(taskPath), task);
    rmSync(pending); const lock = join(targetDirectory, 'atlas.mld.lock'); writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce: 'synthetic-live-owner' }));
    const preview = previewDesignerAssetImport(i); assert.throws(() => importDesignerAsset({ ...i, confirmationDigest: preview.confirmationDigest })); assert.equal(existsSync(lock), true); assert.equal(existsSync(join(targetDirectory, 'atlas.mld')), false);
    rmSync(lock); const resume = previewDesignerAssetImport(i); importDesignerAsset({ ...i, confirmationDigest: resume.confirmationDigest });
    const separate = { ...i, content: { ...i.content, packageId: 'different-package' } };
    assert.ok(previewDesignerAssetImport(separate).conflicts.includes('existing-designer-library'));
  } finally { i.registry.close(); }
}));
for (const point of ['task.staged', 'task.journaled', 'task.replaced', 'prepared', 'business.staged', 'business.journaled', 'business.replaced', 'business.published', 'designer.staged', 'designer.journaled', 'designer.replaced', 'designer.published']) {
  it(`blocks ordinary startup and resumes both stores after hard exit at ${point}`, () => temp(root => {
    const i = input(root), asset = i.content; i.registry.close();
    writeFileSync(join(root, 'synthetic-content.json'), JSON.stringify(asset));
    const moduleBase = fileURLToPath(new URL('../../packages/server/src/', import.meta.url)).replaceAll('\\', '/');
    const code = `import { mkdirSync,readFileSync } from 'node:fs'; import { join } from 'node:path'; import { SecurityRegistry } from ${JSON.stringify(moduleBase + 'security/security-registry.ts')}; import { LocalVaultKeyProvider } from ${JSON.stringify(moduleBase + 'security/local-vault-key-provider.ts')}; import { previewDesignerAssetImport,importDesignerAsset } from ${JSON.stringify(moduleBase + 'designer-asset-transfer.ts')}; const root=process.argv[1], point=process.argv[2]; const protector={id:'synthetic-designer-asset',ensureDirectory(p){mkdirSync(p,{recursive:true})},protect(b){return Buffer.from(b).toString('base64')},unprotect(s){return Buffer.from(s,'base64')}}; const securityDirectory=join(root,'security'); const registry=SecurityRegistry.open(securityDirectory,{protector,resumeAssetPublication:true}); const input={content:JSON.parse(readFileSync(join(root,'synthetic-content.json'),'utf8')),storageRoot:join(root,'vault'),database:'received',instanceId:registry.status().instanceId,designerWorkspace:'model_designer_workspace',securityDirectory,registry,provider:new LocalVaultKeyProvider(securityDirectory,protector)}; const preview=previewDesignerAssetImport(input); importDesignerAsset({...input,confirmationDigest:preview.confirmationDigest,onPoint(p){if(p===point)process.exit(77)}}); process.exit(1);`;
    const child = spawnSync(process.execPath, [tsx, '-e', code, root, point], { encoding: 'utf8', timeout: 30000, windowsHide: true }); assert.equal(child.status, 77, child.stderr);
    assert.throws(() => SecurityRegistry.open(join(root, 'security'), { protector }), { code: 'SECURITY_MAINTENANCE_FAILED' });
    const resumed = input(root, asset);
    try {
      const saved = readFileSync(existsSync(join(root, 'security', 'asset-publication.mld')) ? join(root, 'security', 'asset-publication.mld') : join(root, 'security', 'asset-publication.mld.pending'));
      assert.throws(() => previewDesignerAssetImport({ ...resumed, database: 'different' }));
      assert.throws(() => previewDesignerAssetImport({ ...resumed, content: { ...asset, assetVersion: '99.0.0' } }));
      const path = existsSync(join(root, 'security', 'asset-publication.mld')) ? join(root, 'security', 'asset-publication.mld') : join(root, 'security', 'asset-publication.mld.pending'); assert.deepEqual(readFileSync(path), saved);
      const preview = previewDesignerAssetImport(resumed); assert.equal(preview.resume, true); importDesignerAsset({ ...resumed, confirmationDigest: preview.confirmationDigest });
      assert.equal(existsSync(join(root, 'vault', 'received', 'atlas.mld')), true); assert.equal(existsSync(join(root, 'vault', 'model_designer_workspace', 'atlas.mld')), true);
    } finally { resumed.registry.close(); }
    const normal = SecurityRegistry.open(join(root, 'security'), { protector }); normal.close();
  }));
}
it('uses protected Windows offline CLI export/preview/import for Designer assets after deleting the synthetic source', { skip: process.platform !== 'win32' }, () => temp(async root => {
  const sourceRoot = join(root, 'source-instance'), targetRoot = join(root, 'target-instance'), delivery = join(root, 'delivery');
  const sourceConfig = ensureModelDbLayoutAtRoot(sourceRoot), targetConfig = ensureModelDbLayoutAtRoot(targetRoot);
  let registry = SecurityRegistry.open(join(sourceRoot, 'security')); const sourceId = registry.status().instanceId; registry.close();
  registry = SecurityRegistry.open(join(targetRoot, 'security')); const targetId = registry.status().instanceId; registry.close();
  const provider = new LocalVaultKeyProvider(join(sourceRoot, 'security')), selected = collected();
  for (const [database, vault] of [['source', assetGraphVault(selected.graph, 'source')], ['model_designer_workspace', mergeDesignerAsset(new AtlasSingleVault(), selected.designer, 'model_designer_workspace')]] as const) {
    mkdirSync(join(sourceRoot, 'vault', database), { recursive: true }); const key = provider.resolveKey(database); try { vault.saveSync(join(sourceRoot, 'vault', database, 'atlas.mld'), key); } finally { key.key.fill(0); }
  }
  new WindowsSecretProtector().ensureDirectory(delivery);
  const phrase = 'synthetic designer asset passphrase', phraseFile = join(delivery, 'phrase.txt'), receiver = createMigrationKey(phrase), signing = createAssetSigningKey(phrase);
  writeFileSync(phraseFile, phrase); writeFileSync(join(delivery, 'receiver.private.json'), receiver.privateKey); writeFileSync(join(delivery, 'receiver.public.pem'), receiver.publicKey); writeFileSync(join(delivery, 'signer.private.json'), signing.privateKey); writeFileSync(join(delivery, 'signer.public.pem'), signing.publicKey);
  const selection = join(delivery, 'selection.json'), pkg = join(delivery, 'asset.v2'); writeFileSync(selection, JSON.stringify({ models: ['Item'], includeData: false, designer: { queries: [], operations: [], bindings: ['binding'] } }));
  const cli = (...args: string[]) => spawnSync(process.execPath, [tsx, fileURLToPath(new URL('../../packages/server/src/cli.ts', import.meta.url)), 'security', ...args], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  const exported = cli('asset-export', '-c', sourceConfig, '--instance', sourceId, '--database', 'source', '--selection', selection, '--asset-id', 'designer-cli', '--asset-version', '1.0.0', '--public-key', join(delivery, 'receiver.public.pem'), '--signing-key', join(delivery, 'signer.private.json'), '--passphrase-file', phraseFile, '--output', pkg, '--yes'); assert.equal(exported.status, 0, exported.stderr);
  assert.equal(JSON.parse(readFileSync(pkg, 'utf8')).format, 'modeldb.asset.v2'); rmSync(sourceRoot, { recursive: true });
  const args = ['-c', targetConfig, '--instance', targetId, '--database', 'received', '--package', pkg, '--private-key', join(delivery, 'receiver.private.json'), '--publisher-key', join(delivery, 'signer.public.pem'), '--publisher-fingerprint', signing.recipientId, '--passphrase-file', phraseFile];
  registry = SecurityRegistry.open(join(targetRoot, 'security')); try { assert.equal(cli('asset-preview', ...args).status, 1); } finally { registry.close(); }
  const preview = cli('asset-preview', ...args); assert.equal(preview.status, 0, preview.stderr); const p = JSON.parse(preview.stdout); assert.equal(p.importedPermissions, 'disabled');
  const imported = cli('asset-import', ...args, '--preview-digest', p.confirmationDigest, '--yes'); assert.equal(imported.status, 0, imported.stderr);
  const workspace = new AuthoringEngine({ atlas: 'model_designer_workspace', storageRoot: join(targetRoot, 'vault'), keyProvider: new LocalVaultKeyProvider(join(targetRoot, 'security')), engineLogger: false });
  try {
    const rows = designerAssetRows(workspace.atlasVault!, 'sys_query_interface'); assert.equal(rows.length, 1); assert.equal(rows[0]!.library_code, 'received'); assert.deepEqual(JSON.parse(String(rows[0]!.query_json)).contract.permissions, { mode: 'disabled' });
  } finally { await workspace.close(); }
  registry = SecurityRegistry.open(join(targetRoot, 'security')); try { assert.equal(registry.status().credentials, 0); assert.ok(registry.auditEvents().some(event => event.action === 'asset.task.completed')); } finally { registry.close(); }
}));

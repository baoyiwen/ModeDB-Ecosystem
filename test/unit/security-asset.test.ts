import assert from 'node:assert/strict';
import { it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { constants, createCipheriv, generateKeyPairSync, publicEncrypt, randomBytes, sign, webcrypto } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetGraphStatistics, assetGraphVault, AuthoringEngine, collectAssetGraph, readAtlasVaultKeyReference, validateAssetGraph, type AssetGraph } from '@mode-db/core';
import { importAssetAsNewDatabase, previewAssetImport } from '../../packages/server/src/asset-transfer.js';
import { openAssetPackage, sealAssetPackage, type AssetContent } from '../../packages/server/src/security/asset-package.js';
import { backupRecipientId } from '../../packages/server/src/security/backup-package.js';
import { createAssetSigningKey, createMigrationKey, openAssetSigningKey, openMigrationKey } from '../../packages/server/src/security/migration-key.js';
import { LocalVaultKeyProvider } from '../../packages/server/src/security/local-vault-key-provider.js';
import { SecurityRegistry } from '../../packages/server/src/security/security-registry.js';
import { WindowsSecretProtector } from '../../packages/server/src/security/windows-secret-protector.js';
import { ensureModelDbLayoutAtRoot } from '../../packages/server/src/modeldb-default-home.js';
import { readBackupBytes } from '../../packages/server/src/backup-manager.js';
import { fileDigest, stableStringify } from '@mode-db/common';

const protector = { id: 'synthetic-asset', ensureDirectory(p: string) { mkdirSync(p, { recursive: true }); }, protect(b: Uint8Array) { return Buffer.from(b).toString('base64'); }, unprotect(s: string) { return Buffer.from(s, 'base64'); } };
const recipient = generateKeyPairSync('rsa', { modulusLength: 3072 });
const publisher = generateKeyPairSync('rsa', { modulusLength: 3072 });
const tsx = fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url));
const metadata = { assetId: 'synthetic-asset', assetVersion: '1.0.0', sourceInstanceId: 'synthetic-source' };
function graph(): AssetGraph {
  return {
    version: 1, atlas: 'graph', includeData: true,
    models: [
      { definition: { name: 'Group', parentId: null, fields: ['label'], fieldTypes: { label: { type: 'I18N' } } }, rows: [{ _id: 'g', _createdAt: '2026-10-23T00:00:00Z', label: { zh: '合成分组', en: 'Synthetic group', ja: '合成グループ' } }] },
      { definition: { name: 'Item', parentId: null, fields: ['label'], fieldTypes: { label: { type: 'String' } } }, rows: [{ _id: 'i', _createdAt: '2026-10-23T00:00:00Z', label: 'synthetic selected data' }] },
    ],
    relations: [{ definition: { source: 'Group', target: 'Item', forward: 'members', reverse: 'group', logic: 'one-to-many', matchOn: null, selfLoopPolicy: 'deny' }, index: { fwd: { g: ['i'] }, rev: { i: ['g'] } } }],
  };
}
function packageContent(): AssetContent {
  return openAssetPackage(sealAssetPackage(graph(), metadata, recipient.publicKey, publisher.privateKey), recipient.privateKey, publisher.publicKey, backupRecipientId(publisher.publicKey));
}
async function temp(run: (root: string) => unknown) {
  const root = mkdtempSync(join(tmpdir(), 'modedb-asset-'));
  try { await run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

it('collects selected business models, parent dependencies, original IDs and bidirectional edges without unrelated entries', () => temp(async root => {
  const provider = new LocalVaultKeyProvider(join(root, 'security'), protector);
  const engine = new AuthoringEngine({ atlas: 'graph', storageRoot: root, keyProvider: provider, engineLogger: false });
  try {
    engine.registerModel('Base', { label: 'String' });
    engine.registerModel('Child', { label: 'String' }, 'Base');
    engine.registerModel('OtherAsset', { secret: 'String' });
    engine.registerRelation('Base', 'Child', 'children', 'parent', 'one-to-many');
    const parent = await engine.insert('Base', { label: 'synthetic parent' }, { sync: true });
    const child = await engine.insert('Child', { label: 'synthetic child' }, { sync: true });
    await engine.insert('OtherAsset', { secret: 'unselected synthetic secret' }, { sync: true });
    await engine.bind('children', 'MANUAL', { pairs: [[parent._id, child._id]] }); await engine.flushAll();
    engine.atlasVault!.set('arbitrary-extra', 'synthetic source runtime material');
    const selected = collectAssetGraph(engine.atlasVault!, { models: ['Child'], includeData: true });
    assert.deepEqual(selected.models.map(m => m.definition.name), ['Base', 'Child']);
    assert.equal(selected.models[0]!.rows[0]!._id, parent._id);
    assert.deepEqual(selected.relations[0]!.index, { fwd: { [parent._id]: [child._id] }, rev: { [child._id]: [parent._id] } });
    const raw = JSON.stringify(selected);
    assert.equal(raw.includes('OtherAsset'), false); assert.equal(raw.includes('runtime material'), false);
    const template = collectAssetGraph(engine.atlasVault!, { models: ['Child'], includeData: false });
    assert.equal(assetGraphStatistics(template).records, 0); assert.equal(assetGraphStatistics(template).edges, 0);
    assert.throws(() => collectAssetGraph(engine.atlasVault!, { models: ['Missing'], includeData: true }));
    assert.throws(() => collectAssetGraph(engine.atlasVault!, { models: ['Base', 'Base'], includeData: true }));
    assert.throws(() => collectAssetGraph(engine.atlasVault!, { models: ['Base'], includeData: false, interfaces: [] } as never));
  } finally { await engine.close(); }
}));

it('interoperates with independent WebCrypto JWS verification and JWE decryption, with no source DEK in content', async () => {
  const bytes = sealAssetPackage(graph(), metadata, recipient.publicKey, publisher.privateKey);
  assert.equal(bytes.includes(Buffer.from('synthetic selected data')), false);
  const outer = JSON.parse(bytes.toString());
  const signingPublic = await webcrypto.subtle.importKey('spki', new Uint8Array(publisher.publicKey.export({ type: 'spki', format: 'der' })), { name: 'RSA-PSS', hash: 'SHA-256' }, false, ['verify']);
  assert.equal(await webcrypto.subtle.verify({ name: 'RSA-PSS', saltLength: 32 }, signingPublic, Buffer.from(outer.signature, 'base64url'), Buffer.from(outer.protected + '.' + outer.payload)), true);
  const parts = Buffer.from(outer.payload, 'base64url').toString().split('.');
  const privateKey = await webcrypto.subtle.importKey('pkcs8', new Uint8Array(recipient.privateKey.export({ type: 'pkcs8', format: 'der' })), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
  const keyBytes = await webcrypto.subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, Buffer.from(parts[1]!, 'base64url'));
  const pek = await webcrypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  const plain = Buffer.from(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(parts[2]!, 'base64url'), additionalData: Buffer.from(parts[0]!), tagLength: 128 }, pek, Buffer.concat([Buffer.from(parts[3]!, 'base64url'), Buffer.from(parts[4]!, 'base64url')])));
  const content = JSON.parse(plain.toString());
  assert.deepEqual(content.graph, graph());
  assert.deepEqual(Object.keys(content).sort(), ['version', 'packageId', 'assetId', 'assetVersion', 'sourceInstanceId', 'publisherId', 'createdAt', 'contentDigest', 'statistics', 'graph'].sort());
  const other = JSON.parse(sealAssetPackage(graph(), metadata, recipient.publicKey, publisher.privateKey).toString());
  const otherParts = Buffer.from(other.payload, 'base64url').toString().split('.');
  assert.notEqual(parts[1], otherParts[1]); assert.notEqual(parts[3], otherParts[3]); plain.fill(0);
});

it('requires explicit publisher trust, the exact recipient and fixed algorithms before exposing content', () => {
  const bytes = sealAssetPackage(graph(), metadata, recipient.publicKey, publisher.privateKey);
  const trust = backupRecipientId(publisher.publicKey);
  assert.throws(() => openAssetPackage(bytes, recipient.privateKey, publisher.publicKey, '0'.repeat(64)), { code: 'SECURITY_FORBIDDEN' });
  assert.throws(() => openAssetPackage(bytes, publisher.privateKey, publisher.publicKey, trust));
  assert.throws(() => openAssetPackage(bytes, recipient.privateKey, recipient.publicKey, trust));
  for (const field of ['protected', 'payload', 'signature']) {
    const value = JSON.parse(bytes.toString()); value[field] = (value[field][0] === 'A' ? 'B' : 'A') + value[field].slice(1);
    assert.throws(() => openAssetPackage(Buffer.from(JSON.stringify(value)), recipient.privateKey, publisher.publicKey, trust));
  }
  for (const header of [{ alg: 'none', typ: 'modeldb.asset.v1', kid: trust }, { alg: 'PS256', typ: 'modeldb.asset.v1', kid: trust, jku: 'https://invalid.example/key' }]) {
    const value = JSON.parse(bytes.toString()); value.protected = Buffer.from(JSON.stringify(header)).toString('base64url');
    value.signature = sign('sha256', Buffer.from(value.protected + '.' + value.payload), { key: publisher.privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }).toString('base64url');
    assert.throws(() => openAssetPackage(Buffer.from(JSON.stringify(value)), recipient.privateKey, publisher.publicKey, trust));
  }
  const extra = JSON.parse(bytes.toString()); extra.files = [{ path: '../evil' }];
  assert.throws(() => openAssetPackage(Buffer.from(JSON.stringify(extra)), recipient.privateKey, publisher.publicKey, trust));
  assert.throws(() => sealAssetPackage(graph(), metadata, publisher.publicKey, publisher.privateKey));
});

it('rejects authenticated hostile publisher content, inconsistent digests/statistics and signed invalid GCM', () => {
  const valid = packageContent();
  const trust = backupRecipientId(publisher.publicKey);
  // Independent malicious publisher constructs standards-compliant envelopes; no implementation sealer.
  const envelope = (content: unknown, corruptTag = false): Buffer => {
    const head = Buffer.from(JSON.stringify({ alg: 'RSA-OAEP-256', enc: 'A256GCM', typ: 'modeldb.asset.v1', kid: backupRecipientId(recipient.publicKey) })).toString('base64url');
    const key = randomBytes(32), iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from(head));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(content)), cipher.final()]);
    const tag = cipher.getAuthTag(); if (corruptTag) tag[0] ^= 1;
    const wrapped = publicEncrypt({ key: recipient.publicKey, oaepHash: 'sha256', padding: constants.RSA_PKCS1_OAEP_PADDING }, key); key.fill(0);
    const payload = Buffer.from([head, wrapped.toString('base64url'), iv.toString('base64url'), encrypted.toString('base64url'), tag.toString('base64url')].join('.')).toString('base64url');
    const protectedHeader = Buffer.from(JSON.stringify({ alg: 'PS256', typ: 'modeldb.asset.v1', kid: trust })).toString('base64url');
    const signature = sign('sha256', Buffer.from(protectedHeader + '.' + payload), { key: publisher.privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }).toString('base64url');
    return Buffer.from(JSON.stringify({ format: 'modeldb.asset.v1', protected: protectedHeader, payload, signature }));
  };
  for (const content of [{ ...valid, version: 0 }, { ...valid, contentDigest: '0'.repeat(64) }, { ...valid, statistics: { ...valid.statistics, records: 999 } }, { ...valid, sourceDEK: 'forbidden extension' }, { ...valid, graph: { ...valid.graph, extension: { constructor: 'forbidden' } } }]) {
    assert.throws(() => openAssetPackage(envelope(content), recipient.privateKey, publisher.publicKey, trust));
  }
  assert.throws(() => openAssetPackage(envelope(valid, true), recipient.privateKey, publisher.publicKey, trust));
});

it('rejects unsafe names, duplicate identities, unselected fields, dangling/asymmetric/duplicate edges and unknown extensions', () => {
  const mutations: ((g: any) => void)[] = [
    g => { g.models[0].definition.name = '../outside'; },
    g => { g.models[0].definition.name = 'bad:stream'; },
    g => { g.models[0].definition.name = 'sys_model'; },
    g => { g.models[0].rows.push(g.models[0].rows[0]); },
    g => { g.models[0].rows[0].hidden = 'extra'; },
    g => { g.relations[0].index.fwd.g = ['missing']; },
    g => { g.relations[0].index.rev.i = []; },
    g => { g.relations[0].index.fwd.g.push('i'); },
    g => { g.models[0].definition.parentId = 'Item'; g.models[1].definition.parentId = 'Group'; },
    g => { g.extension = { executable: 'not allowed' }; },
    g => { g.models[0].rows[0].label = 123; },
  ];
  for (const mutate of mutations) { const value = structuredClone(graph()); mutate(value); assert.throws(() => validateAssetGraph(value)); }
  assert.throws(() => validateAssetGraph({ ...graph(), includeData: false }));
});

it('keeps signing keys separate from recipient keys and rejects hostile KDF parameters', () => {
  const phrase = 'synthetic signing passphrase';
  const signing = createAssetSigningKey(phrase), receiving = createMigrationKey(phrase);
  assert.equal(backupRecipientId(openAssetSigningKey(signing.privateKey, phrase)), signing.recipientId);
  assert.throws(() => openMigrationKey(signing.privateKey, phrase));
  assert.throws(() => openAssetSigningKey(receiving.privateKey, phrase));
  assert.throws(() => openAssetSigningKey(signing.privateKey, 'synthetic incorrect phrase'));
  const hostile = JSON.parse(signing.privateKey.toString()); hostile.N = 1073741824;
  assert.throws(() => openAssetSigningKey(Buffer.from(JSON.stringify(hostile)), phrase));
});

it('previews without target writes, requires confirmation and imports original IDs/i18n/relations under destination protection', () => temp(async root => {
  const provider = new LocalVaultKeyProvider(join(root, 'security'), protector), content = packageContent();
  provider.getIdentity();
  const input = { content, storageRoot: root, database: 'received', instanceId: 'destination', designerWorkspace: 'model_designer_workspace', provider };
  const before = readdirSync(join(root, 'security'));
  const preview = previewAssetImport(input);
  assert.deepEqual(readdirSync(join(root, 'security')), before); assert.equal(existsSync(join(root, 'received')), false);
  assert.deepEqual(preview.statistics, { models: 2, fields: 2, records: 2, relations: 1, edges: 1 });
  assert.throws(() => importAssetAsNewDatabase({ ...input, confirmationDigest: '0'.repeat(64) }), { code: 'SECURITY_CONFIRMATION_REQUIRED' });
  const replaced = structuredClone(content);
  replaced.graph.models[0]!.rows[0]!.label = { en: 'different signed content with the same package ID' };
  Object.assign(replaced, { contentDigest: fileDigest(Buffer.from(stableStringify(replaced.graph))) });
  assert.notEqual(previewAssetImport({ ...input, content: replaced }).confirmationDigest, preview.confirmationDigest);
  assert.throws(() => importAssetAsNewDatabase({ ...input, content: replaced, confirmationDigest: preview.confirmationDigest }), { code: 'SECURITY_CONFIRMATION_REQUIRED' });
  assert.equal(existsSync(join(root, 'received')), false);
  const result = importAssetAsNewDatabase({ ...input, confirmationDigest: preview.confirmationDigest });
  assert.notEqual(result.localAssetInstanceId, content.assetId);
  const engine = new AuthoringEngine({ atlas: 'received', storageRoot: root, keyProvider: provider, engineLogger: false });
  try {
    assert.deepEqual(await engine.persistence.getMergedReader().getAll('Group'), content.graph.models[0]!.rows);
    const relation = engine.registry.getRelations()[0]!;
    assert.deepEqual(await engine.indexer.getForward(relation, 'g'), ['i']);
    assert.deepEqual(await engine.indexer.getReverse(relation, 'i'), ['g']);
    await engine.insert('Item', { label: 'local change' }, { sync: true });
  } finally { await engine.close(); }
  const bytes = readFileSync(join(root, 'received', 'atlas.mld'));
  const changed = previewAssetImport(input); assert.ok(changed.conflicts.includes('existing-database'));
  assert.throws(() => importAssetAsNewDatabase({ ...input, confirmationDigest: preview.confirmationDigest }), { code: 'SECURITY_POLICY_CONFLICT' });
  assert.deepEqual(readFileSync(join(root, 'received', 'atlas.mld')), bytes);
  assert.ok(previewAssetImport({ ...input, database: 'model_designer_workspace' }).conflicts.includes('reserved-database'));
  assert.ok(previewAssetImport({ ...input, database: 'MODEL_DESIGNER_WORKSPACE' }).conflicts.includes('reserved-database'));
  mkdirSync(join(root, 'unrelated')); writeFileSync(join(root, 'unrelated', 'keep.txt'), 'keep');
  assert.ok(previewAssetImport({ ...input, database: 'unrelated' }).conflicts.includes('existing-directory'));
  assert.equal(readFileSync(join(root, 'unrelated', 'keep.txt'), 'utf8'), 'keep');
}));

it('preserves a different interrupted candidate and rejects oversized or aliased disk inputs', () => temp(root => {
  const provider = new LocalVaultKeyProvider(join(root, 'security'), protector), content = packageContent();
  const input = { content, storageRoot: root, database: 'received', instanceId: 'destination', designerWorkspace: 'workspace', provider };
  const preview = previewAssetImport(input);
  assert.throws(() => importAssetAsNewDatabase({ ...input, confirmationDigest: preview.confirmationDigest, onPoint(point) { if (point === 'staged') throw new Error('synthetic failure'); } }));
  const pending = join(root, 'received', 'atlas.mld.pending'), before = readFileSync(pending);
  const different = packageContent();
  const next = previewAssetImport({ ...input, content: different }); assert.ok(next.conflicts.includes('existing-database'));
  assert.throws(() => importAssetAsNewDatabase({ ...input, content: different, confirmationDigest: next.confirmationDigest }));
  assert.deepEqual(readFileSync(pending), before); assert.equal(existsSync(join(root, 'received', 'atlas.mld')), false);
  const oversized = join(root, 'oversized'); writeFileSync(oversized, ''); truncateSync(oversized, 128 * 1024 * 1024 + 1);
  assert.throws(() => readBackupBytes(oversized));
  if (process.platform === 'win32') {
    const alias = join(root, 'alias'); symlinkSync(join(root, 'received'), alias, 'junction');
    assert.throws(() => previewAssetImport({ ...input, database: 'alias' }));
    for (const database of ['bad:stream', 'CON', 'name.']) assert.throws(() => previewAssetImport({ ...input, database }));
  }
}));

for (const point of ['staged', 'journaled', 'replaced']) it(`resumes a matching asset import after process termination at ${point}`, () => temp(async root => {
  const content = packageContent(), file = join(root, 'synthetic-content.json'); writeFileSync(file, JSON.stringify(content));
  const script = `import {mkdirSync,readFileSync} from 'node:fs'; import {LocalVaultKeyProvider} from './packages/server/src/security/local-vault-key-provider.ts'; import {previewAssetImport,importAssetAsNewDatabase} from './packages/server/src/asset-transfer.ts'; const [root,file,point]=process.argv.slice(1); const protector={id:'synthetic-asset',ensureDirectory(p){mkdirSync(p,{recursive:true})},protect(b){return Buffer.from(b).toString('base64')},unprotect(s){return Buffer.from(s,'base64')}}; const input={content:JSON.parse(readFileSync(file,'utf8')),storageRoot:root,database:'received',instanceId:'destination',designerWorkspace:'workspace',provider:new LocalVaultKeyProvider(root+'/security',protector)}; const preview=previewAssetImport(input); importAssetAsNewDatabase({...input,confirmationDigest:preview.confirmationDigest,onPoint(p){if(p===point)process.exit(95)}});`;
  const child = spawnSync(process.execPath, [tsx, '-e', script, root, file, point], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(child.status, 95, child.stderr);
  const provider = new LocalVaultKeyProvider(join(root, 'security'), protector);
  const input = { content, storageRoot: root, database: 'received', instanceId: 'destination', designerWorkspace: 'workspace', provider };
  const preview = previewAssetImport(input); assert.deepEqual(preview.conflicts, []); assert.equal(preview.resume, true);
  importAssetAsNewDatabase({ ...input, confirmationDigest: preview.confirmationDigest });
  assert.equal(existsSync(join(root, 'received', 'atlas.mld.pending')), false);
  assert.equal(existsSync(join(root, 'received', 'atlas.mld.commit')), false);
  const engine = new AuthoringEngine({ atlas: 'received', storageRoot: root, keyProvider: provider, engineLogger: false });
  try { assert.equal((await engine.persistence.getMergedReader().getAll('Item'))[0]!._id, 'i'); } finally { await engine.close(); }
}));

it('runs Windows offline CLI export/preview/import after removing the synthetic source and refuses live-instance access', { skip: process.platform !== 'win32', timeout: 180000 }, () => temp(async root => {
  const source = join(root, 'source'), target = join(root, 'target'), delivery = join(root, 'delivery');
  const sourceConfig = ensureModelDbLayoutAtRoot(source), targetConfig = ensureModelDbLayoutAtRoot(target);
  let registry = SecurityRegistry.open(join(source, 'security')); const sourceId = registry.status().instanceId; registry.close();
  registry = SecurityRegistry.open(join(target, 'security')); const targetId = registry.status().instanceId; registry.close();
  const provider = new LocalVaultKeyProvider(join(source, 'security'));
  const material = provider.resolveKey('graph');
  mkdirSync(join(source, 'vault', 'graph')); assetGraphVault(graph(), 'graph').saveSync(join(source, 'vault', 'graph', 'atlas.mld'), material); material.key.fill(0);
  new WindowsSecretProtector().ensureDirectory(delivery);
  const passfile = join(delivery, 'phrase.txt'); writeFileSync(passfile, 'synthetic offline asset passphrase');
  const cliPath = fileURLToPath(new URL('../../packages/server/src/cli.ts', import.meta.url));
  const cli = (...args: string[]) => spawnSync(process.execPath, [tsx, cliPath, 'security', ...args], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  const receivePrefix = join(delivery, 'receiver'), signPrefix = join(delivery, 'publisher'), pkg = join(delivery, 'selected.asset');
  const receiver = cli('backup-key-create', '--output', receivePrefix, '--passphrase-file', passfile); assert.equal(receiver.status, 0, receiver.stderr);
  const signing = cli('asset-signing-key-create', '--output', signPrefix, '--passphrase-file', passfile); assert.equal(signing.status, 0, signing.stderr);
  const fingerprint = JSON.parse(signing.stdout).publisherId;
  const selection = join(delivery, 'selection.json'); writeFileSync(selection, JSON.stringify({ models: ['Group', 'Item'], includeData: true }));
  const exported = cli('asset-export', '-c', sourceConfig, '--instance', sourceId, '--database', 'graph', '--selection', selection, '--asset-id', 'asset-cli', '--asset-version', '1.0.0', '--public-key', receivePrefix + '.public.pem', '--signing-key', signPrefix + '.private.json', '--passphrase-file', passfile, '--output', pkg, '--yes');
  assert.equal(exported.status, 0, exported.stderr);
  const beforeSource = readFileSync(join(source, 'vault', 'graph', 'atlas.mld'));
  assert.equal(cli('asset-export', '-c', sourceConfig, '--instance', sourceId, '--database', 'graph', '--selection', selection, '--asset-id', 'asset-cli', '--asset-version', '1.0.0', '--public-key', receivePrefix + '.public.pem', '--signing-key', signPrefix + '.private.json', '--passphrase-file', passfile, '--output', pkg, '--yes').status, 1);
  assert.deepEqual(readFileSync(join(source, 'vault', 'graph', 'atlas.mld')), beforeSource);
  const exportFor = (database: string, output: string) => cli('asset-export', '-c', sourceConfig, '--instance', sourceId, '--database', database, '--selection', selection, '--asset-id', 'asset-cli', '--asset-version', '1.0.0', '--public-key', receivePrefix + '.public.pem', '--signing-key', signPrefix + '.private.json', '--passphrase-file', passfile, '--output', output, '--yes');
  symlinkSync(join(source, 'vault', 'graph'), join(source, 'vault', 'alias'), 'junction');
  const rejectedOutput = join(delivery, 'rejected.asset');
  assert.equal(exportFor('alias', rejectedOutput).status, 1); assert.equal(existsSync(rejectedOutput), false);
  mkdirSync(join(source, 'vault', 'empty'));
  assert.equal(exportFor('empty', rejectedOutput).status, 1); assert.equal(existsSync(join(source, 'vault', 'empty', 'atlas.mld')), false);
  assert.equal(exportFor('graph', join(source, 'vault', 'rejected.asset')).status, 1); assert.equal(existsSync(join(source, 'vault', 'rejected.asset')), false);
  assert.deepEqual(readFileSync(join(source, 'vault', 'graph', 'atlas.mld')), beforeSource);
  rmSync(source, { recursive: true });
  const args = ['-c', targetConfig, '--instance', targetId, '--database', 'received', '--package', pkg, '--private-key', receivePrefix + '.private.json', '--passphrase-file', passfile, '--publisher-key', signPrefix + '.public.pem', '--publisher-fingerprint', fingerprint];
  registry = SecurityRegistry.open(join(target, 'security'));
  try { const busy = cli('asset-preview', ...args); assert.equal(busy.status, 1); assert.match(busy.stderr, /SECURITY_INSTANCE_BUSY/); } finally { registry.close(); }
  const preview = cli('asset-preview', ...args); assert.equal(preview.status, 0, preview.stderr);
  assert.equal(existsSync(join(target, 'vault', 'received')), false);
  const confirm = JSON.parse(preview.stdout).confirmationDigest;
  const bad = cli('asset-import', ...args, '--preview-digest', '0'.repeat(64), '--yes'); assert.equal(bad.status, 1); assert.equal(existsSync(join(target, 'vault', 'received')), false);
  const imported = cli('asset-import', ...args, '--preview-digest', confirm, '--yes'); assert.equal(imported.status, 0, imported.stderr);
  const engine = new AuthoringEngine({ atlas: 'received', storageRoot: join(target, 'vault'), keyProvider: new LocalVaultKeyProvider(join(target, 'security')), engineLogger: false });
  try { assert.deepEqual(await engine.persistence.getMergedReader().getAll('Group'), graph().models[0]!.rows); assert.deepEqual(await engine.indexer.getReverse(engine.registry.getRelations()[0]!, 'i'), ['g']); } finally { await engine.close(); }
  assert.notEqual(readAtlasVaultKeyReference(join(target, 'vault', 'received', 'atlas.mld'))!.instanceId, sourceId);
  registry = SecurityRegistry.open(join(target, 'security'));
  try { assert.equal(registry.status().credentials, 0); assert.ok(registry.auditEvents().some(event => event.action === 'asset.task.completed')); } finally { registry.close(); }
}));

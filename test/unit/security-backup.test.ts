import assert from 'node:assert/strict';
import { it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, webcrypto } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AtlasSingleVault, readAtlasVaultKeyReference } from '@mode-db/core';
import { createDatabaseBackup, importDatabaseBackup, importMigrationBackup, listDatabaseBackups, readDatabaseBackupFile, restoreDatabaseBackup } from '../../packages/server/src/backup-manager.js';
import { LocalVaultKeyProvider } from '../../packages/server/src/security/local-vault-key-provider.js';
import { SecurityRegistry } from '../../packages/server/src/security/security-registry.js';
import { createMigrationKey, openMigrationKey } from '../../packages/server/src/security/migration-key.js';
import { backupRecipientId } from '../../packages/server/src/security/backup-package.js';
import { createRecoveryPackageFile, restoreRecoveryPackageFile } from '../../packages/server/src/security/recovery-material.js';
import { readBackupBytes } from '../../packages/server/src/backup-manager.js';
import { ensureModelDbLayoutAtRoot } from '../../packages/server/src/modeldb-default-home.js';
import { WindowsSecretProtector } from '../../packages/server/src/security/windows-secret-protector.js';
import { AuthoringEngine } from '@mode-db/core';
import { AuthoringBridge } from '../../packages/server/src/authoring-bridge.js';
import { WriteSerializationGate } from '../../packages/server/src/write-serialization-gate.js';
import { startAutoBackupScheduler } from '../../packages/server/src/auto-backup-scheduler.js';

const protector = { id: 'synthetic-backup', ensureDirectory(path: string) { mkdirSync(path, { recursive: true }); }, protect(bytes: Uint8Array) { return Buffer.from(bytes).toString('base64'); }, unprotect(value: string) { return Buffer.from(value, 'base64'); } };
const tsx = fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url));
function source(root: string) {
  const provider = new LocalVaultKeyProvider(join(root, 'security'), protector);
  const key = provider.resolveKey('graph'), path = join(root, 'graph', 'atlas.mld');
  mkdirSync(join(root, 'graph'), { recursive: true });
  const vault = new AtlasSingleVault(); vault.set('m:Item', 'synthetic secret business contents');
  vault.set('r:Item-Item-next', 'synthetic relation'); vault.saveSync(path, key); key.key.fill(0);
  return { provider, path };
}
function temp(run: (root: string) => void) { const root = mkdtempSync(join(tmpdir(), 'modedb-secure-backup-')); try { run(root); } finally { rmSync(root, { recursive: true, force: true }); } }
it('encrypts the entire package and restores data without replacing unrelated files or access state', () => temp(root => {
  const src = source(root), registry = SecurityRegistry.open(join(root, 'security'), { protector });
  const principal = registry.createPrincipal('synthetic'); const token = registry.createCredential(principal.id, 'synthetic');
  registry.revokeCredential(token.credential.id); registry.close();
  const ledger = readFileSync(join(root, 'security', 'registry.mds'));
  writeFileSync(join(root, 'graph', 'keep.txt'), 'unrelated file');
  const backup = createDatabaseBackup(root, 'graph', 'manual', '合成备份', src.provider);
  const file = readDatabaseBackupFile(root, backup.fileName, src.provider);
  const pkg = JSON.parse(file.content.toString());
  assert.equal(pkg.format, 'modeldb.backup.v2'); assert.equal(pkg.files, undefined);
  assert.equal(file.content.includes(Buffer.from('secret business')), false);
  assert.equal(file.content.includes(Buffer.from('keep.txt')), false);
  const key = src.provider.resolveKey('graph', readAtlasVaultKeyReference(src.path)!);
  const changed = new AtlasSingleVault(); changed.loadSync(src.path, key); changed.set('m:Item', 'changed'); changed.saveSync(src.path, key); key.key.fill(0);
  restoreDatabaseBackup(root, 'graph', backup.fileName, src.provider);
  const restoredKey = src.provider.resolveKey('graph', readAtlasVaultKeyReference(src.path)!);
  const restored = new AtlasSingleVault(); restored.loadSync(src.path, restoredKey); restoredKey.key.fill(0);
  assert.equal(restored.get('m:Item'), 'synthetic secret business contents');
  assert.equal(readFileSync(join(root, 'graph', 'keep.txt'), 'utf8'), 'unrelated file');
  assert.deepEqual(readFileSync(join(root, 'security', 'registry.mds')), ledger);
  assert.equal(backup.statistics.models, 1); assert.equal(backup.statistics.relations, 1);
}));

it('protects migration private keys and rejects wrong phrases, recipient identities and hostile KDF parameters', () => {
  const key = createMigrationKey('synthetic migration key phrase');
  assert.equal(backupRecipientId(openMigrationKey(key.privateKey, 'synthetic migration key phrase')), key.recipientId);
  assert.throws(() => openMigrationKey(key.privateKey, 'synthetic incorrect phrase'));
  for (const patch of [{ N: 1073741824 }, { recipientId: '0'.repeat(64) }, { extra: true }]) {
    assert.throws(() => openMigrationKey(Buffer.from(JSON.stringify({ ...JSON.parse(key.privateKey.toString()), ...patch })), 'synthetic migration key phrase'));
  }
  assert.equal(key.privateKey.includes(Buffer.from('PRIVATE KEY')), false);
});

for (const point of ['staged', 'journaled', 'replaced'] as const) it(`resumes a first restore into a new database after a hard exit at ${point}`, () => temp(root => {
  const src = source(root), backup = createDatabaseBackup(root, 'graph', 'manual', undefined, src.provider);
  const script = `import { mkdirSync } from 'node:fs'; import { LocalVaultKeyProvider } from './packages/server/src/security/local-vault-key-provider.ts'; import { restoreDatabaseBackup } from './packages/server/src/backup-manager.ts'; const [root,file,point]=process.argv.slice(1); const p={id:'synthetic-backup',ensureDirectory(p){mkdirSync(p,{recursive:true})},protect(b){return Buffer.from(b).toString('base64')},unprotect(s){return Buffer.from(s,'base64')}}; restoreDatabaseBackup(root,'copy',file,new LocalVaultKeyProvider(root+'/security',p),p=>{if(p===point)process.exit(94)});`;
  const child = spawnSync(process.execPath, [tsx, '-e', script, root, backup.fileName, point], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(child.status, 94, child.stderr);
  restoreDatabaseBackup(root, 'copy', backup.fileName, src.provider);
  const path = join(root, 'copy', 'atlas.mld'), material = src.provider.resolveKey('copy', readAtlasVaultKeyReference(path)!);
  const vault = new AtlasSingleVault(); vault.loadSync(path, material); material.key.fill(0);
  assert.equal(vault.get('m:Item'), 'synthetic secret business contents');
  assert.equal(existsSync(path + '.commit'), false); assert.equal(existsSync(path + '.pending'), false);
}));

it('preserves an unmatched initial restore stage instead of publishing different backup content', () => temp(root => {
  const src = source(root), first = createDatabaseBackup(root, 'graph', 'manual', undefined, src.provider);
  assert.throws(() => restoreDatabaseBackup(root, 'copy', first.fileName, src.provider, point => { if (point === 'staged') throw new Error('synthetic interruption'); }));
  const pending = join(root, 'copy', 'atlas.mld.pending'), before = readFileSync(pending);
  const material = src.provider.resolveKey('graph', readAtlasVaultKeyReference(src.path)!);
  const vault = new AtlasSingleVault(); vault.loadSync(src.path, material); vault.set('m:Item', 'different'); vault.saveSync(src.path, material); material.key.fill(0);
  const second = createDatabaseBackup(root, 'graph', 'manual', undefined, src.provider);
  assert.throws(() => restoreDatabaseBackup(root, 'copy', second.fileName, src.provider));
  assert.deepEqual(readFileSync(pending), before); assert.equal(existsSync(join(root, 'copy', 'atlas.mld')), false);
  restoreDatabaseBackup(root, 'copy', first.fileName, src.provider);
}));

it('opens a local encrypted backup after independent recovery without the source key store', () => temp(root => {
  const srcRoot = join(root, 'source'), src = source(srcRoot);
  const backup = createDatabaseBackup(srcRoot, 'graph', 'manual', undefined, src.provider);
  const content = readDatabaseBackupFile(srcRoot, backup.fileName, src.provider).content;
  const recovery = join(root, 'material.mdrecovery');
  createRecoveryPackageFile(src.provider, recovery, 'synthetic recovery backup phrase', join(srcRoot, 'security'));
  rmSync(srcRoot, { recursive: true });
  const target = join(root, 'target'), security = join(target, 'security'); mkdirSync(target);
  restoreRecoveryPackageFile(recovery, 'synthetic recovery backup phrase', security, protector);
  const provider = new LocalVaultKeyProvider(security, protector);
  const imported = importDatabaseBackup(target, backup.fileName, content, provider);
  restoreDatabaseBackup(target, 'graph', imported.fileName, provider);
  const path = join(target, 'graph', 'atlas.mld'), material = provider.resolveKey('graph', readAtlasVaultKeyReference(path)!);
  const vault = new AtlasSingleVault(); vault.loadSync(path, material); material.key.fill(0);
  assert.equal(vault.get('m:Item'), 'synthetic secret business contents');
  const registry = SecurityRegistry.open(security, { protector });
  assert.equal(registry.status().credentials, 0); registry.close();
}));

it('rejects oversized disk inputs before reading or changing a source Vault', () => temp(root => {
  const src = source(root), before = readFileSync(src.path), oversized = join(root, 'oversized');
  writeFileSync(oversized, ''); truncateSync(oversized, 128 * 1024 * 1024 + 1);
  assert.throws(() => readBackupBytes(oversized));
  assert.deepEqual(readFileSync(src.path), before);
  const backup = createDatabaseBackup(root, 'graph', 'manual', undefined, src.provider);
  const target = join(root, 'oversized-target'); mkdirSync(target);
  const pending = join(target, 'atlas.mld.pending'); writeFileSync(pending, ''); truncateSync(pending, 48 * 1024 * 1024 + 1);
  assert.throws(() => restoreDatabaseBackup(root, 'oversized-target', backup.fileName, src.provider));
  assert.equal(existsSync(pending), true); assert.equal(existsSync(join(target, 'atlas.mld')), false);
}));

it('automatic backups wait for the write gate, flush buffered rows and refuse a failed flush or audit intent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'modedb-auto-secure-backup-'));
  const provider = new LocalVaultKeyProvider(join(root, 'security'), protector);
  const registry = SecurityRegistry.open(join(root, 'security'), { protector });
  const bridge = new AuthoringBridge(root, provider), gate = new WriteSerializationGate();
  const cfg = { enabled: true, intervalMs: 60000, reason: 'automatic', runOnStart: true, databases: ['graph'] };
  let scheduler: ReturnType<typeof startAutoBackupScheduler>;
  try {
    mkdirSync(join(root, 'graph'));
    const engine = await bridge.getEngine('graph'); engine.registerModel('Item', { label: 'String' });
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const writing = gate.runExclusive('graph', async () => { await engine.insert('Item', { label: 'buffered before snapshot' }, { sync: false }); await barrier; });
    scheduler = startAutoBackupScheduler(root, cfg, bridge, provider, gate, registry);
    assert.equal(listDatabaseBackups(root, 'graph', provider).length, 0);
    release(); await writing; await gate.runExclusive('graph', async () => undefined); scheduler!.stop();
    const backups = listDatabaseBackups(root, 'graph', provider); assert.equal(backups.length, 1);
    restoreDatabaseBackup(root, 'copy', backups[0]!.fileName, provider);
    const copied = new AuthoringEngine({ atlas: 'copy', storageRoot: root, keyProvider: provider, engineLogger: false });
    assert.equal((await copied.persistence.getMergedReader().getAll('Item'))[0]!.label, 'buffered before snapshot'); await copied.close();
    const flush = engine.flushAll.bind(engine);
    engine.flushAll = async () => { throw new Error('synthetic secret must not be logged'); };
    scheduler = startAutoBackupScheduler(root, cfg, bridge, provider, gate, registry);
    await gate.runExclusive('graph', async () => undefined); await new Promise<void>(resolve => setImmediate(resolve)); scheduler!.stop();
    assert.equal(listDatabaseBackups(root, 'graph', provider).length, 1);
    assert.ok(registry.auditEvents().some(event => event.action === 'backup.task.failed'));
    engine.flushAll = flush;
    const audit = registry.recordMaintenance.bind(registry);
    registry.recordMaintenance = () => { throw new Error('synthetic audit full'); };
    scheduler = startAutoBackupScheduler(root, cfg, bridge, provider, gate, registry);
    await gate.runExclusive('graph', async () => undefined); await new Promise<void>(resolve => setImmediate(resolve)); scheduler!.stop();
    assert.equal(listDatabaseBackups(root, 'graph', provider).length, 1); registry.recordMaintenance = audit;
  } finally { scheduler?.stop(); await bridge.close(); registry.close(); rmSync(root, { recursive: true, force: true }); }
});

it('runs the offline recipient CLI between isolated Windows instances with fresh destination protection', { skip: process.platform !== 'win32', timeout: 180000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'modedb-migration-cli-'));
  let registry: SecurityRegistry | undefined;
  try {
    const sourceRoot = join(root, 'source'), targetRoot = join(root, 'target');
    const config = ensureModelDbLayoutAtRoot(sourceRoot), targetConfig = ensureModelDbLayoutAtRoot(targetRoot);
    registry = SecurityRegistry.open(join(sourceRoot, 'security'));
    const sourceInstance = registry.status().instanceId; registry.close(); registry = undefined;
    registry = SecurityRegistry.open(join(targetRoot, 'security'));
    const targetInstance = registry.status().instanceId; registry.close(); registry = undefined;
    const provider = new LocalVaultKeyProvider(join(sourceRoot, 'security'));
    const engine = new AuthoringEngine({ atlas: 'graph', storageRoot: join(sourceRoot, 'vault'), keyProvider: provider, engineLogger: false });
    engine.registerModel('Item', { label: 'String' }); engine.registerModel('Group', { label: 'String' });
    engine.registerRelation('Group', 'Item', 'members', 'group', 'one-to-many');
    const item = await engine.insert('Item', { label: 'synthetic CLI migration data' }, { sync: true });
    const group = await engine.insert('Group', { label: 'synthetic group' }, { sync: true });
    await engine.bind('members', 'MANUAL', { pairs: [[group._id, item._id]] }); await engine.close();
    const external = join(root, 'delivery'); new WindowsSecretProtector().ensureDirectory(external);
    const passfile = join(external, 'phrase.txt'); writeFileSync(passfile, 'synthetic isolated migration phrase');
    const prefix = join(external, 'recipient'), packagePath = join(external, 'graph.package');
    const cliPath = fileURLToPath(new URL('../../packages/server/src/cli.ts', import.meta.url));
    const cli = (...args: string[]) => spawnSync(process.execPath, [tsx, cliPath, ...args], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    const generated = cli('security', 'backup-key-create', '--output', prefix, '--passphrase-file', passfile);
    assert.equal(generated.status, 0, generated.stderr);
    const args = ['security', 'backup-export', '-c', config, '--database', 'graph', '--public-key', prefix + '.public.pem', '--output', packagePath, '--instance', sourceInstance, '--yes'];
    registry = SecurityRegistry.open(join(sourceRoot, 'security'));
    const busy = cli(...args); assert.equal(busy.status, 1); assert.match(busy.stderr, /SECURITY_INSTANCE_BUSY/); assert.equal(existsSync(packagePath), false);
    registry.close(); registry = undefined;
    const sourceFile = join(sourceRoot, 'vault', 'graph', 'atlas.mld'), before = readFileSync(sourceFile);
    const forbidden = [...args]; forbidden[forbidden.indexOf('--output') + 1] = join(sourceRoot, 'vault', 'bad.package');
    assert.equal(cli(...forbidden).status, 1); assert.deepEqual(readFileSync(sourceFile), before);
    const exported = cli(...args); assert.equal(exported.status, 0, exported.stderr);
    assert.equal(JSON.parse(exported.stdout).recipientId, JSON.parse(generated.stdout).recipientId);
    rmSync(sourceRoot, { recursive: true });
    const imported = cli('security', 'backup-import', '-c', targetConfig, '--database', 'received', '--private-key', prefix + '.private.json', '--package', packagePath, '--passphrase-file', passfile, '--instance', targetInstance, '--yes');
    assert.equal(imported.status, 0, imported.stderr);
    const receipt = JSON.parse(imported.stdout); assert.equal(receipt.restored, false);
    const restored = cli('restore', 'received', receipt.imported.fileName, '-c', targetConfig, '--yes');
    assert.equal(restored.status, 0, restored.stderr);
    const received = new AuthoringEngine({ atlas: 'received', storageRoot: join(targetRoot, 'vault'), keyProvider: new LocalVaultKeyProvider(join(targetRoot, 'security')), engineLogger: false });
    const rows = await received.persistence.getMergedReader().getAll('Item'); assert.equal(rows.length, 1); assert.equal(rows[0]!.label, 'synthetic CLI migration data');
    const relation = received.registry.getRelations()[0]!;
    assert.deepEqual(await received.indexer.getForward(relation, group._id), [item._id]);
    assert.deepEqual(await received.indexer.getReverse(relation, item._id), [group._id]); await received.close();
    registry = SecurityRegistry.open(join(targetRoot, 'security'));
    assert.equal(registry.status().credentials, 0);
    assert.ok(registry.auditEvents().some(event => event.action === 'backup.task.completed'));
    assert.notEqual(readAtlasVaultKeyReference(join(targetRoot, 'vault', 'received', 'atlas.mld'))!.instanceId, sourceInstance);
  } finally { registry?.close(); rmSync(root, { recursive: true, force: true }); }
});
it('copies into a new key domain and keeps backups unique on repeated upload', () => temp(root => {
  const src = source(root), backup = createDatabaseBackup(root, 'graph', 'manual', undefined, src.provider);
  const file = readDatabaseBackupFile(root, backup.fileName, src.provider);
  const first = importDatabaseBackup(root, '../../other', file.content, src.provider);
  const second = importDatabaseBackup(root, first.fileName, file.content, src.provider);
  assert.notEqual(first.fileName, second.fileName); assert.equal(listDatabaseBackups(root, 'graph', src.provider).length, 3);
  restoreDatabaseBackup(root, 'copy', first.fileName, src.provider);
  const ref = readAtlasVaultKeyReference(join(root, 'copy', 'atlas.mld'))!;
  assert.notEqual(ref.databaseId, readAtlasVaultKeyReference(src.path)!.databaseId);
}));
it('independent WebCrypto unwraps standard A256KW and authenticates JWE content', async () => {
  const root = mkdtempSync(join(tmpdir(), 'modedb-backup-jwe-'));
  try {
    const src = source(root), backup = createDatabaseBackup(root, 'graph', 'manual', undefined, src.provider);
    const pkg = JSON.parse(readDatabaseBackupFile(root, backup.fileName, src.provider).content.toString());
    const header = JSON.parse(Buffer.from(pkg.protected, 'base64url').toString());
    const key = src.provider.resolveKey('graph', header.manifest.sourceReference);
    const kek = await webcrypto.subtle.importKey('raw', new Uint8Array(key.key), 'AES-KW', false, ['unwrapKey']);
    const pek = await webcrypto.subtle.unwrapKey('raw', Buffer.from(pkg.recipients[0].encrypted_key, 'base64url'), kek, 'AES-KW', 'AES-GCM', false, ['decrypt']);
    const bytes = Buffer.from(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(pkg.iv, 'base64url'), additionalData: Buffer.from(pkg.protected), tagLength: 128 }, pek, Buffer.concat([Buffer.from(pkg.ciphertext, 'base64url'), Buffer.from(pkg.tag, 'base64url')])));
    assert.equal(JSON.parse(bytes.toString()).version, 2); bytes.fill(0); key.key.fill(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it('full migration needs the exact recipient and re-protects data with destination keys', () => temp(root => {
  const src = source(join(root, 'source')), target = join(root, 'target'); mkdirSync(target);
  const pair = generateKeyPairSync('rsa', { modulusLength: 3072 }), wrong = generateKeyPairSync('rsa', { modulusLength: 3072 });
  const backup = createDatabaseBackup(join(root, 'source'), 'graph', 'manual', '迁移', src.provider, pair.publicKey);
  const content = readDatabaseBackupFile(join(root, 'source'), backup.fileName, src.provider).content;
  const provider = new LocalVaultKeyProvider(join(target, 'security'), protector);
  assert.throws(() => importMigrationBackup(target, 'received', content, wrong.privateKey, provider));
  assert.equal(existsSync(join(target, 'security')), false);
  const imported = importMigrationBackup(target, 'received', content, pair.privateKey, provider);
  rmSync(join(root, 'source'), { recursive: true });
  restoreDatabaseBackup(target, 'received', imported.fileName, provider);
  const path = join(target, 'received', 'atlas.mld'), ref = readAtlasVaultKeyReference(path)!;
  const key = provider.resolveKey('received', ref), vault = new AtlasSingleVault(); vault.loadSync(path, key); key.key.fill(0);
  assert.equal(vault.get('m:Item'), 'synthetic secret business contents');
  assert.equal(existsSync(join(target, 'security', 'registry.mds')), false);
  assert.throws(() => importMigrationBackup(target, 'received', content, pair.privateKey, provider));
}));
it('rejects tampered metadata, recipient bindings, payloads and legacy packages before any target change', () => temp(root => {
  const src = source(root), backup = createDatabaseBackup(root, 'graph', 'manual', undefined, src.provider);
  const file = readDatabaseBackupFile(root, backup.fileName, src.provider), before = readFileSync(src.path);
  const original = JSON.parse(file.content.toString());
  for (const part of ['protected', 'iv', 'tag', 'ciphertext']) {
    const pkg = structuredClone(original); pkg[part] = (pkg[part][0] === 'A' ? 'B' : 'A') + pkg[part].slice(1);
    assert.throws(() => importDatabaseBackup(root, 'bad', Buffer.from(JSON.stringify(pkg)), src.provider));
  }
  const pkg = structuredClone(original); pkg.recipients[0].header.kid = 'other';
  assert.throws(() => importDatabaseBackup(root, 'bad', Buffer.from(JSON.stringify(pkg)), src.provider));
  assert.throws(() => importDatabaseBackup(root, 'old', Buffer.from(JSON.stringify({ format: 'modeldb.backup.v1', files: [] })), src.provider), { code: 'SECURITY_PROTOCOL_UNSUPPORTED' });
  writeFileSync(file.info.path, JSON.stringify(pkg));
  assert.throws(() => restoreDatabaseBackup(root, 'graph', backup.fileName, src.provider));
  assert.deepEqual(readFileSync(src.path), before);
  assert.equal(listDatabaseBackups(root, 'graph', src.provider).length, 0);
}));
for (const point of ['staged', 'journaled', 'replaced'] as const) it(`recovers a restore after a process exits at ${point}`, () => temp(root => {
  const src = source(root), backup = createDatabaseBackup(root, 'graph', 'manual', undefined, src.provider);
  const key = src.provider.resolveKey('graph', readAtlasVaultKeyReference(src.path)!);
  const vault = new AtlasSingleVault(); vault.loadSync(src.path, key); vault.set('m:Item', 'after'); vault.saveSync(src.path, key); key.key.fill(0);
  const script = `import { mkdirSync } from 'node:fs'; import { LocalVaultKeyProvider } from './packages/server/src/security/local-vault-key-provider.ts'; import { restoreDatabaseBackup } from './packages/server/src/backup-manager.ts'; const [root,file,point]=process.argv.slice(1); const p={id:'synthetic-backup',ensureDirectory(p){mkdirSync(p,{recursive:true})},protect(b){return Buffer.from(b).toString('base64')},unprotect(s){return Buffer.from(s,'base64')}}; restoreDatabaseBackup(root,'graph',file,new LocalVaultKeyProvider(root+'/security',p),p=>{if(p===point)process.exit(94)});`;
  const child = spawnSync(process.execPath, [tsx, '-e', script, root, backup.fileName, point], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(child.status, 94, child.stderr);
  restoreDatabaseBackup(root, 'graph', backup.fileName, src.provider);
  const restoredKey = src.provider.resolveKey('graph', readAtlasVaultKeyReference(src.path)!);
  const restored = new AtlasSingleVault(); restored.loadSync(src.path, restoredKey); restoredKey.key.fill(0);
  assert.equal(restored.get('m:Item'), 'synthetic secret business contents');
  assert.equal(existsSync(src.path + '.commit'), false);
}));
it('rejects linked sources, linked backup stores, Windows ADS and extra package fields', { skip: process.platform !== 'win32' }, () => temp(root => {
  const src = source(root), backup = createDatabaseBackup(root, 'graph', 'manual', undefined, src.provider);
  const content = readDatabaseBackupFile(root, backup.fileName, src.provider).content;
  const alias = join(root, 'alias'); symlinkSync(join(root, 'graph'), alias, 'junction');
  assert.throws(() => createDatabaseBackup(root, 'alias', 'manual', undefined, src.provider));
  assert.throws(() => readDatabaseBackupFile(root, 'bad:stream.modeldb-backup.json', src.provider));
  const bad = JSON.parse(content.toString()); bad.files = [{ path: '../evil', data: 'bad' }];
  assert.throws(() => importDatabaseBackup(root, 'bad', Buffer.from(JSON.stringify(bad)), src.provider));
  assert.equal(readdirSync(join(root, 'modeldb', 'backups')).length, 1);
}));

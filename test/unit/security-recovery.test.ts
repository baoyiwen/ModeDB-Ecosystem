import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createDecipheriv, scryptSync, webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { acquireFileLeaseSync } from '@mode-db/common';
import { SecurityRegistry } from '../../packages/server/src/security/security-registry.js';
import { ensureModelDbLayoutAtRoot } from '../../packages/server/src/modeldb-default-home.js';
import { prepareRecoveryDrill, verifyRecoveryDrill } from '../../scripts/security-recovery-drill.js';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { AtlasSingleVault, readAtlasVaultKeyReference } from '@mode-db/core';
import { LocalVaultKeyProvider } from '../../packages/server/src/security/local-vault-key-provider.js';
import { WindowsSecretProtector } from '../../packages/server/src/security/windows-secret-protector.js';
import {
  createRecoveryPackageFile,
  restoreRecoveryPackageFile,
  rotateDatabaseVaultKey,
  verifyRecoveryPackageFile,
  checkRecoveryPackageDependencies,
  readRecoveryPassphraseFile,
} from '../../packages/server/src/security/recovery-material.js';

const protector = {
  id: 'synthetic-recovery-protector',
  ensureDirectory(path: string) {
    mkdirSync(path, { recursive: true });
  },
  protect(bytes: Uint8Array) {
    return Buffer.from(bytes).toString('base64');
  },
  unprotect(value: string) {
    return Buffer.from(value, 'base64');
  },
};
const tsx = fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url));
const cliPath = fileURLToPath(new URL('../../packages/server/src/cli.ts', import.meta.url));

function createVault(root: string) {
  mkdirSync(root, { recursive: true });
  const security = join(root, 'security');
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const provider = new LocalVaultKeyProvider(security, protector);
  const material = provider.resolveKey('graph');
  const vaultPath = join(workspace, 'atlas.mld');
  const vault = new AtlasSingleVault();
  vault.set('value', 'portable recovery data');
  vault.saveSync(vaultPath, material);
  return { security, workspace, provider, material, vaultPath };
}

it('creates and verifies a passphrase-protected portable recovery package', () => {
  const root = mkdtempSync(join(tmpdir(), 'modedb-recovery-package-'));
  try {
    const source = createVault(root);
    source.provider.rotateMaster();
    const packagePath = join(root, 'external', 'recovery.mdrecovery');
    mkdirSync(join(root, 'external'));
    const passphrase = 'synthetic recovery passphrase';
    const created = createRecoveryPackageFile(
      source.provider,
      packagePath,
      passphrase,
      source.security,
    );
    assert.equal(created.databases, 1);
    assert.equal(created.historicalKeys, 2);
    const raw = readFileSync(packagePath, 'utf8');
    assert.equal(raw.includes('portable recovery data'), false);
    assert.equal(raw.includes(Buffer.from(source.material.key).toString('base64')), false);
    assert.deepEqual(verifyRecoveryPackageFile(packagePath, passphrase), {
      recoveryKeyId: created.recoveryKeyId,
      sourceInstanceId: source.provider.getIdentity(true).instanceId,
      databases: 1,
      historicalKeys: 2,
    });
    assert.throws(() => verifyRecoveryPackageFile(packagePath, 'wrong recovery passphrase'), {
      code: 'SECURITY_MAINTENANCE_FAILED',
    });
    writeFileSync(packagePath, raw.replace('modeldb.recovery.v1', 'modeldb.recovery.tampered'));
    assert.throws(() => verifyRecoveryPackageFile(packagePath, passphrase), {
      code: 'SECURITY_INVALID_REQUEST',
    });
    source.material.key.fill(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('restores a package into a fresh security directory without source protection material', () => {
  const root = mkdtempSync(join(tmpdir(), 'modedb-recovery-restore-'));
  try {
    const source = createVault(join(root, 'source'));
    const packagePath = join(root, 'recovery.mdrecovery');
    createRecoveryPackageFile(source.provider, packagePath, 'another recovery passphrase', source.security);
    const targetSecurity = join(root, 'target', 'security');
    const targetWorkspace = join(root, 'target', 'workspace');
    mkdirSync(targetWorkspace, { recursive: true });
    const restored = restoreRecoveryPackageFile(
      packagePath,
      'another recovery passphrase',
      targetSecurity,
      protector,
    );
    const target = new LocalVaultKeyProvider(targetSecurity, protector);
    assert.equal(restored.instanceId, source.provider.getIdentity(true).instanceId);
    assert.notEqual(restored.masterKeyId, source.provider.getIdentity(true).masterKeyId);
    copyFileSync(source.vaultPath, join(targetWorkspace, 'atlas.mld'));
    const restoredReference = readAtlasVaultKeyReference(join(targetWorkspace, 'atlas.mld'))!;
    const restoredKey = target.resolveKey('graph', restoredReference);
    const vault = new AtlasSingleVault();
    assert.equal(vault.loadSync(join(targetWorkspace, 'atlas.mld'), restoredKey), true);
    assert.equal(vault.get('value'), 'portable recovery data');
    restoredKey.key.fill(0);
    source.material.key.fill(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('rotates one database DEK with a resumable task state', () => {
  const root = mkdtempSync(join(tmpdir(), 'modedb-dek-rotation-'));
  try {
    const source = createVault(root);
    const statePath = join(source.security, 'database-key-rotation.json');
    const oldReference = source.material.reference;
    assert.throws(
      () =>
        rotateDatabaseVaultKey(
          source.vaultPath,
          'graph',
          source.provider,
          statePath,
          (point) => {
            if (point === 'rewrapped') throw new Error('synthetic interruption');
          },
        ),
      { code: 'SECURITY_MAINTENANCE_FAILED' },
    );
    assert.equal(existsSync(statePath), true);
    const pendingReference = readAtlasVaultKeyReference(source.vaultPath)!;
    assert.notDeepEqual(pendingReference, oldReference);
    const resumed = rotateDatabaseVaultKey(
      source.vaultPath,
      'graph',
      source.provider,
      statePath,
    );
    assert.deepEqual(resumed.oldReference, oldReference);
    assert.equal(resumed.newReference.keyVersion, oldReference.keyVersion + 1);
    assert.equal(existsSync(statePath), false);
    assert.equal(existsSync(join(source.security, `${oldReference.keyId}.dek`)), true);
    const current = source.provider.resolveKey('graph', resumed.newReference);
    const vault = new AtlasSingleVault();
    assert.equal(vault.loadSync(source.vaultPath, current), true);
    assert.equal(vault.get('value'), 'portable recovery data');
    current.key.fill(0);
    source.material.key.fill(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('refuses to place a recovery package inside the source security directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'modedb-recovery-path-'));
  try {
    const source = createVault(root);
    assert.throws(
      () =>
        createRecoveryPackageFile(
          source.provider,
          join(source.security, 'recovery.mdrecovery'),
          'valid recovery passphrase',
          source.security,
        ),
      { code: 'SECURITY_INVALID_REQUEST' },
    );
    source.material.key.fill(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it(
  'restores a portable package with a fresh Windows DPAPI target protector',
  { skip: process.platform !== 'win32' },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'modedb-recovery-dpapi-'));
    try {
      const protector = new WindowsSecretProtector();
      const sourceSecurity = join(root, 'source-security');
      const sourceWorkspace = join(root, 'source-workspace');
      mkdirSync(sourceWorkspace);
      const source = new LocalVaultKeyProvider(sourceSecurity, protector);
      const material = source.resolveKey('graph');
      const vaultPath = join(sourceWorkspace, 'atlas.mld');
      const vault = new AtlasSingleVault();
      vault.set('value', 'dpapi-independent recovery');
      vault.saveSync(vaultPath, material);
      // Only a dedicated protected directory may contain exported recovery material.
      const external = join(root, 'external');
      protector.ensureDirectory(external);
      const protectedPackagePath = join(external, 'recovery.mdrecovery');
      createRecoveryPackageFile(source, protectedPackagePath, 'Windows recovery passphrase', sourceSecurity);
      const targetHome = join(root, 'target-home');
      protector.ensureDirectory(targetHome);
      const targetSecurity = join(targetHome, 'security');
      const copyPath = join(targetHome, 'restored.mld');
      copyFileSync(vaultPath, copyPath);
      material.key.fill(0);
      assert.equal(sourceSecurity, join(root, 'source-security'));
      rmSync(sourceSecurity, { recursive: true });
      const target = new LocalVaultKeyProvider(targetSecurity, protector);
      restoreRecoveryPackageFile(
        protectedPackagePath,
        'Windows recovery passphrase',
        targetSecurity,
        protector,
      );
      const restoredReference = readAtlasVaultKeyReference(copyPath)!;
      const restoredKey = target.resolveKey('graph', restoredReference);
      const reopened = new AtlasSingleVault();
      assert.equal(reopened.loadSync(copyPath, restoredKey), true);
      assert.equal(reopened.get('value'), 'dpapi-independent recovery');
      material.key.fill(0);
      restoredKey.key.fill(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it('authenticates metadata and rejects malformed or expensive recovery inputs without changing source files', () => {
  const root = mkdtempSync(join(tmpdir(), 'modedb-recovery-validation-'));
  try {
    const source = createVault(root);
    const packagePath = join(root, 'recovery.mdrecovery');
    const passphrase = 'validation recovery passphrase';
    createRecoveryPackageFile(source.provider, packagePath, passphrase, source.security);
    const raw = readFileSync(packagePath, 'utf8');
    const vaultBefore = readFileSync(source.vaultPath);
    const masterBefore = readFileSync(join(source.security, 'instance.key'));
    const mutations = [
      (pkg: any) => { pkg.createdAt = '2020-01-01T00:00:00.000Z'; },
      (pkg: any) => { pkg.sourceInstanceId = 'other-instance'; },
      (pkg: any) => { pkg.dependencies.keyIds[0] = 'other-key'; },
      (pkg: any) => { pkg.privateKey.N = 2 ** 30; },
      (pkg: any) => { pkg.privateKey.salt = 'AA=='; },
      (pkg: any) => { pkg.extra = true; },
      (pkg: any) => { const parts = pkg.jwe.split('.'); parts[3] = (parts[3][0] === 'A' ? 'B' : 'A') + parts[3].slice(1); pkg.jwe = parts.join('.'); },
      (pkg: any) => { pkg.privateKey.encryptedPkcs8 = null; },
    ];
    for (const mutate of mutations) {
      const pkg = JSON.parse(raw); mutate(pkg); writeFileSync(packagePath, JSON.stringify(pkg));
      assert.throws(() => restoreRecoveryPackageFile(packagePath, passphrase, join(root, 'new-security'), protector));
      assert.equal(existsSync(join(root, 'new-security')), false);
      assert.deepEqual(readFileSync(source.vaultPath), vaultBefore);
      assert.deepEqual(readFileSync(join(source.security, 'instance.key')), masterBefore);
    }
    writeFileSync(packagePath, raw);
    assert.throws(() => restoreRecoveryPackageFile(packagePath, 'incorrect recovery phrase', join(root, 'new-security'), protector));
    assert.equal(existsSync(join(root, 'new-security')), false);
    assert.throws(() => restoreRecoveryPackageFile(packagePath, passphrase, source.security, protector));
    assert.deepEqual(readFileSync(join(source.security, 'instance.key')), masterBefore);
    const target = join(root, 'failure-security');
    assert.throws(() => restoreRecoveryPackageFile(packagePath, passphrase, target, protector, () => {
      assert.throws(() => SecurityRegistry.open(target, { protector }), { code: 'SECURITY_INSTANCE_BUSY' });
      assert.equal(existsSync(target), false);
      throw new Error('synthetic disk interruption');
    }));
    assert.equal(existsSync(target), false);
    restoreRecoveryPackageFile(packagePath, passphrase, target, protector);
    assert.equal(existsSync(join(target, 'instance.key')), true);
    source.material.key.fill(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const point of ['prepared', 'staged', 'journaled', 'replaced', 'rewrapped', 'completed'] as const) {
  it(`resumes a DEK rotation after process termination at ${point}, retaining old backup keys`, () => {
    const root = mkdtempSync(join(tmpdir(), 'modedb-rekey-crash-'));
    try {
      const source = createVault(root);
      const backup = join(root, 'old-backup.mld'); copyFileSync(source.vaultPath, backup);
      const state = join(source.security, 'database-key-rotation.json');
      const script = `
        import { mkdirSync } from 'node:fs';
        import { LocalVaultKeyProvider } from './packages/server/src/security/local-vault-key-provider.ts';
        import { rotateDatabaseVaultKey } from './packages/server/src/security/recovery-material.ts';
        const protector = { id: 'synthetic-recovery-protector', ensureDirectory(p) { mkdirSync(p,{recursive:true}); }, protect(b) { return Buffer.from(b).toString('base64'); }, unprotect(v) { return Buffer.from(v,'base64'); } };
        const [security,vault,state,point] = process.argv.slice(1);
        rotateDatabaseVaultKey(vault,'graph',new LocalVaultKeyProvider(security,protector),state,p=>{if(p===point) process.exit(91);});
      `;
      const child = spawnSync(process.execPath, [tsx, '-e', script, source.security, source.vaultPath, state, point], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
      assert.equal(child.status, 91, child.stderr);
      assert.equal(existsSync(state), true);
      assert.throws(() => SecurityRegistry.open(source.security, { protector }), { code: 'SECURITY_MAINTENANCE_FAILED' });
      const result = rotateDatabaseVaultKey(source.vaultPath, 'graph', source.provider, state);
      assert.equal(result.newReference.keyVersion, 2);
      assert.equal(existsSync(state), false);
      const old = source.provider.resolveKey('graph', result.oldReference);
      const oldVault = new AtlasSingleVault(); assert.equal(oldVault.loadSync(backup, old), true);
      assert.equal(oldVault.get('value'), 'portable recovery data'); old.key.fill(0);
      const next = source.provider.resolveKey('graph', result.newReference);
      const newVault = new AtlasSingleVault(); assert.equal(newVault.loadSync(source.vaultPath, next), true);
      assert.equal(newVault.get('value'), 'portable recovery data'); next.key.fill(0);
      source.material.key.fill(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

it('checks historical dependency coverage, restores all DEK versions and initializes no old access state', () => {
  const root = mkdtempSync(join(tmpdir(), 'modedb-recovery-history-'));
  try {
    const source = createVault(root);
    const registry = SecurityRegistry.open(source.security, { protector });
    const principal = registry.createPrincipal('source-only principal');
    const credential = registry.createCredential(principal.id, 'source-only token');
    registry.close();
    writeFileSync(join(source.security, 'network-policy.json'), JSON.stringify({ marker: 'source-only-policy' }));
    const before = join(root, 'before.mdrecovery'), after = join(root, 'after.mdrecovery');
    const phrase = 'historical recovery passphrase';
    createRecoveryPackageFile(source.provider, before, phrase, source.security);
    const backup = join(root, 'old-backup.mld'); copyFileSync(source.vaultPath, backup);
    rotateDatabaseVaultKey(source.vaultPath, 'graph', source.provider, join(source.security, 'database-key-rotation.json'));
    const coverage = checkRecoveryPackageDependencies(before, phrase, [source.vaultPath, backup]);
    assert.equal(coverage.covered, false); assert.equal(coverage.missing.length, 1);
    source.provider.rotateMaster();
    createRecoveryPackageFile(source.provider, after, phrase, source.security);
    assert.deepEqual(checkRecoveryPackageDependencies(after, phrase, [source.vaultPath, backup]), { checked: 2, covered: true, missing: [] });
    const targetSecurity = join(root, 'target-security');
    restoreRecoveryPackageFile(after, phrase, targetSecurity, protector);
    assert.equal(existsSync(join(targetSecurity, 'network-policy.json')), false);
    const targetRegistry = SecurityRegistry.open(targetSecurity, { protector });
    assert.equal(targetRegistry.status().credentials, 0);
    assert.throws(() => targetRegistry.authenticate(credential.token));
    targetRegistry.close();
    const target = new LocalVaultKeyProvider(targetSecurity, protector);
    for (const path of [source.vaultPath, backup]) {
      const key = target.resolveKey('graph', readAtlasVaultKeyReference(path)!);
      assert.equal(new AtlasSingleVault().loadSync(path, key), true); key.key.fill(0);
    }
    source.material.key.fill(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('refuses maintenance concurrent with a live instance or key writer', () => {
  const root = mkdtempSync(join(tmpdir(), 'modedb-recovery-lock-'));
  try {
    const source = createVault(root); const before = readFileSync(source.vaultPath);
    for (const name of ['instance-owner', 'key-maintenance']) {
      const release = acquireFileLeaseSync(join(source.security, name));
      try {
        assert.throws(() => createRecoveryPackageFile(source.provider, join(root, 'recovery'), 'concurrency passphrase', source.security), { code: 'SECURITY_INSTANCE_BUSY' });
        assert.throws(() => rotateDatabaseVaultKey(source.vaultPath, 'graph', source.provider, join(source.security, 'database-key-rotation.json')), { code: 'SECURITY_INSTANCE_BUSY' });
        assert.deepEqual(readFileSync(source.vaultPath), before);
      } finally { release(); }
    }
    source.material.key.fill(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('keeps the current Vault and corrupt commit artifacts unchanged on failed resume', () => {
  const root = mkdtempSync(join(tmpdir(), 'modedb-recovery-corrupt-'));
  try {
    const source = createVault(root), state = join(source.security, 'database-key-rotation.json');
    assert.throws(() => rotateDatabaseVaultKey(source.vaultPath, 'graph', source.provider, state, p => { if (p === 'journaled') throw new Error('interrupt'); }));
    const pending = readFileSync(source.vaultPath + '.pending'); pending[pending.length - 1] ^= 1;
    writeFileSync(source.vaultPath + '.pending', pending);
    const before = readFileSync(source.vaultPath), task = readFileSync(state);
    assert.throws(() => rotateDatabaseVaultKey(source.vaultPath, 'graph', source.provider, state));
    assert.deepEqual(readFileSync(source.vaultPath), before);
    assert.deepEqual(readFileSync(source.vaultPath + '.pending'), pending);
    assert.deepEqual(readFileSync(state), task);
    source.material.key.fill(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('Windows CLI enforces offline ownership, exact paths, confirmations and recovery audit records', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'modedb-recovery-cli-'));
  let registry: SecurityRegistry | undefined;
  try {
    const config = ensureModelDbLayoutAtRoot(root), originalConfig = readFileSync(config);
    const security = join(root, 'security');
    registry = SecurityRegistry.open(security);
    const instance = registry.status().instanceId;
    const provider = new LocalVaultKeyProvider(security);
    const key = provider.resolveKey('synthetic');
    const vault = join(root, 'vault', 'synthetic.mld');
    const data = new AtlasSingleVault(); data.set('data', 'isolated CLI data'); data.saveSync(vault, key); key.key.fill(0);
    const vaultBefore = readFileSync(vault);
    const external = join(root, 'external'); new WindowsSecretProtector().ensureDirectory(external);
    const passfile = join(external, 'passphrase.txt'); writeFileSync(passfile, 'isolated CLI recovery phrase');
    const output = join(external, 'material.mdrecovery');
    const cli = (...args: string[]) => spawnSync(process.execPath, [tsx, cliPath, 'security', ...args], { windowsHide: true, encoding: 'utf8', timeout: 60000 });
    const exportArgs = ['recovery-create', '-c', config, '--instance', instance, '--yes', '--output', output, '--passphrase-file', passfile];
    const busy = cli(...exportArgs); assert.equal(busy.status, 1); assert.match(busy.stderr, /SECURITY_INSTANCE_BUSY/);
    registry.close(); registry = undefined;
    const missingConfirmation = cli('database-key-rotate', '-c', config, '--database', 'synthetic', '--vault', vault);
    assert.equal(missingConfirmation.status, 1); assert.match(missingConfirmation.stderr, /SECURITY_CONFIRMATION_REQUIRED/);
    const exported = cli(...exportArgs); assert.equal(exported.status, 0, exported.stderr);
    const noConfig = cli('recovery-verify', '--package', output, '--passphrase-file', passfile);
    assert.equal(noConfig.status, 0, noConfig.stderr);
    const wrongVault = join(root, 'other.mld'); copyFileSync(vault, wrongVault);
    const refused = cli('database-key-rotate', '-c', config, '--instance', instance, '--yes', '--database', 'synthetic', '--vault', wrongVault);
    assert.equal(refused.status, 1); assert.match(refused.stderr, /SECURITY_INVALID_REQUEST/);
    assert.deepEqual(readFileSync(vault), vaultBefore);
    const rotated = cli('database-key-rotate', '-c', config, '--instance', instance, '--yes', '--database', 'synthetic', '--vault', vault);
    assert.equal(rotated.status, 0, rotated.stderr);
    const missing = cli('recovery-check', '--package', output, '--vault', vault, '--passphrase-file', passfile);
    assert.equal(missing.status, 1); assert.equal(JSON.parse(missing.stdout).covered, false);
    registry = SecurityRegistry.open(security);
    const actions = registry.auditPage({ limit: 50 }).events.map(event => event.action);
    for (const action of ['recovery.export.started', 'recovery.export.completed', 'database.rotate.started', 'database.rotate.completed', 'database.rotate.failed']) assert.equal(actions.includes(action), true, action);
    registry.close(); registry = undefined;
    assert.deepEqual(readFileSync(config), originalConfig);
  } finally { registry?.close(); rmSync(root, { recursive: true, force: true }); }
});

it('restores in a fresh process after a synthetic source key store is removed, with no source protector available', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'modedb-recovery-independent-'));
  try {
    const source = createVault(root);
    const external = join(root, 'external'), targetHome = join(root, 'target-home');
    const windows = new WindowsSecretProtector(); windows.ensureDirectory(external); windows.ensureDirectory(targetHome);
    const packagePath = join(external, 'material.mdrecovery');
    const passfile = join(external, 'passphrase.txt'); writeFileSync(passfile, 'independent process passphrase');
    createRecoveryPackageFile(source.provider, packagePath, 'independent process passphrase', source.security);
    const copy = join(targetHome, 'restored.mld'); copyFileSync(source.vaultPath, copy);
    source.material.key.fill(0);
    assert.equal(source.security, join(root, 'security'));
    rmSync(source.security, { recursive: true });
    const target = join(targetHome, 'security');
    const child = spawnSync(process.execPath, [tsx, cliPath, 'security', 'recovery-restore', '--yes', '--package', packagePath, '--target-security', target, '--passphrase-file', passfile], { windowsHide: true, encoding: 'utf8', timeout: 60000 });
    assert.equal(child.status, 0, child.stderr);
    const provider = new LocalVaultKeyProvider(target);
    const recovered = provider.resolveKey('graph', readAtlasVaultKeyReference(copy)!);
    const vault = new AtlasSingleVault(); assert.equal(vault.loadSync(copy, recovered), true);
    assert.equal(vault.get('value'), 'portable recovery data'); recovered.key.fill(0);
    const registry = SecurityRegistry.open(target);
    assert.equal(registry.status().credentials, 0); registry.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('rejects junction aliases for exports, targets, passphrase files and rotation paths', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'modedb-recovery-junction-'));
  try {
    const source = createVault(root), alias = join(root, 'alias');
    symlinkSync(source.security, alias, 'junction');
    const before = readFileSync(source.vaultPath);
    assert.throws(() => createRecoveryPackageFile(source.provider, join(alias, 'material'), 'junction passphrase', source.security), { code: 'SECURITY_INVALID_REQUEST' });
    assert.throws(() => rotateDatabaseVaultKey(source.vaultPath, 'graph', source.provider, join(alias, 'database-key-rotation.json')), { code: 'SECURITY_INVALID_REQUEST' });
    assert.throws(() => readRecoveryPassphraseFile(join(alias, 'instance.key'), () => {}), { code: 'SECURITY_INVALID_REQUEST' });
    assert.deepEqual(readFileSync(source.vaultPath), before); source.material.key.fill(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('produces a standard Compact JWE decryptable by the independent WebCrypto API', async () => {
  const root = mkdtempSync(join(tmpdir(), 'modedb-recovery-jwe-'));
  const buffers: Buffer[] = [];
  try {
    const source = createVault(root), path = join(root, 'recovery.mdrecovery');
    const phrase = 'standard JWE verification phrase';
    createRecoveryPackageFile(source.provider, path, phrase, source.security);
    const pkg = JSON.parse(readFileSync(path, 'utf8'));
    const parts = pkg.jwe.split('.');
    const protectedHeader = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    assert.equal(protectedHeader.alg, 'RSA-OAEP-256'); assert.equal(protectedHeader.enc, 'A256GCM');
    const derived = scryptSync(phrase, Buffer.from(pkg.privateKey.salt, 'base64url'), 32, { N: 16384, r: 8, p: 1 }); buffers.push(derived);
    const block = pkg.privateKey.encryptedPkcs8;
    const cipher = createDecipheriv('aes-256-gcm', derived, Buffer.from(block.iv, 'base64url'));
    cipher.setAAD(Buffer.from(JSON.stringify(protectedHeader.metadata)));
    cipher.setAuthTag(Buffer.from(block.tag, 'base64url'));
    const privateBytes = Buffer.concat([cipher.update(Buffer.from(block.ciphertext, 'base64url')), cipher.final()]); buffers.push(privateBytes);
    const privateKey = await webcrypto.subtle.importKey('pkcs8', privateBytes, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
    const cek = Buffer.from(await webcrypto.subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, Buffer.from(parts[1], 'base64url'))); buffers.push(cek);
    const aes = await webcrypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
    const decrypted = Buffer.from(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(parts[2], 'base64url'), additionalData: Buffer.from(parts[0]), tagLength: 128 }, aes, Buffer.concat([Buffer.from(parts[3], 'base64url'), Buffer.from(parts[4], 'base64url')]))); buffers.push(decrypted);
    const payload = JSON.parse(decrypted.toString('utf8'));
    assert.equal(payload.databases[0].key, Buffer.from(source.material.key).toString('base64url'));
    source.material.key.fill(0);
  } finally { buffers.forEach(buffer => buffer.fill(0)); rmSync(root, { recursive: true, force: true }); }
});

it('refuses to resume a prepared task after an unrelated writer changed the old Vault', () => {
  const root = mkdtempSync(join(tmpdir(), 'modedb-recovery-cas-'));
  try {
    const source = createVault(root), state = join(source.security, 'database-key-rotation.json');
    assert.throws(() => rotateDatabaseVaultKey(source.vaultPath, 'graph', source.provider, state, p => { if (p === 'prepared') throw new Error('interrupt'); }));
    const writer = new AtlasSingleVault(); writer.loadSync(source.vaultPath, source.material); writer.set('value', 'concurrent change'); writer.saveSync(source.vaultPath, source.material);
    const before = readFileSync(source.vaultPath);
    assert.throws(() => rotateDatabaseVaultKey(source.vaultPath, 'graph', source.provider, state));
    assert.deepEqual(readFileSync(source.vaultPath), before); assert.equal(existsSync(state), true);
    source.material.key.fill(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('exports every retained key after a crash between DEK provisioning and task publication', () => {
  const root = mkdtempSync(join(tmpdir(), 'modedb-recovery-orphan-'));
  try {
    const source = createVault(root);
    const orphan = source.provider.prepareDatabaseKeyRotation(source.material.reference);
    orphan.key.fill(0);
    const result = rotateDatabaseVaultKey(source.vaultPath, 'graph', source.provider, join(source.security, 'database-key-rotation.json'));
    assert.equal(result.newReference.keyVersion, orphan.reference.keyVersion);
    assert.notEqual(result.newReference.keyId, orphan.reference.keyId);
    const path = join(root, 'recovery.mdrecovery');
    const created = createRecoveryPackageFile(source.provider, path, 'all retained key versions', source.security);
    assert.equal(created.databases, 3);
    assert.equal(verifyRecoveryPackageFile(path, 'all retained key versions').databases, 3);
    source.material.key.fill(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('rejects Windows ADS and ambiguous device output paths', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'modedb-recovery-device-path-'));
  try {
    const source = createVault(root);
    for (const name of ['material:stream', 'NUL', 'COM1.txt', 'material.', 'material ']) {
      assert.throws(() => createRecoveryPackageFile(source.provider, join(root, name), 'safe output passphrase', source.security), { code: 'SECURITY_INVALID_REQUEST' });
    }
    source.material.key.fill(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const point of ['staged', 'published'] as const) {
  it(`safely retries portable restore after process termination at ${point}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'modedb-restore-crash-'));
    try {
      const source = createVault(root);
      const path = join(root, 'recovery.mdrecovery'), passfile = join(root, 'phrase.txt');
      const phrase = 'crash recovery test passphrase';
      writeFileSync(passfile, phrase);
      createRecoveryPackageFile(source.provider, path, phrase, source.security);
      const target = join(root, 'restored-security');
      const script = `
        import { mkdirSync,readFileSync } from 'node:fs';
        import { restoreRecoveryPackageFile } from './packages/server/src/security/recovery-material.ts';
        const protector = { id: 'synthetic-recovery-protector', ensureDirectory(p) { mkdirSync(p,{recursive:true}); }, protect(b) { return Buffer.from(b).toString('base64'); }, unprotect(v) { return Buffer.from(v,'base64'); } };
        const [pkg,passfile,target,point] = process.argv.slice(1);
        restoreRecoveryPackageFile(pkg,readFileSync(passfile,'utf8'),target,protector,p=>{if(p===point) process.exit(92);});
      `;
      const child = spawnSync(process.execPath, [tsx, '-e', script, path, passfile, target, point], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
      assert.equal(child.status, 92, child.stderr);
      assert.equal(existsSync(target), point === 'published');
      assert.throws(() => SecurityRegistry.open(target, { protector }), { code: 'SECURITY_INSTANCE_BUSY' });
      const result = restoreRecoveryPackageFile(path, phrase, target, protector);
      assert.equal(result.alreadyRestored, point === 'published' ? true : undefined);
      assert.equal(existsSync(target + '.restore.lock'), false);
      const provider = new LocalVaultKeyProvider(target, protector);
      const key = provider.resolveKey('graph', source.material.reference);
      assert.equal(new AtlasSingleVault().loadSync(source.vaultPath, key), true); key.key.fill(0);
      const registry = SecurityRegistry.open(target, { protector });
      assert.equal(registry.status().credentials, 0); registry.close();
      const ledgerBefore = readFileSync(join(target, 'registry.mds'));
      assert.throws(() => restoreRecoveryPackageFile(path, phrase, target, protector), { code: 'SECURITY_INVALID_REQUEST' });
      assert.deepEqual(readFileSync(join(target, 'registry.mds')), ledgerBefore);
      source.material.key.fill(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

it('refuses recovery at the IMK capacity before publishing an unexportable target', () => {
  const root = mkdtempSync(join(tmpdir(), 'modedb-recovery-master-capacity-'));
  try {
    const source = createVault(root), masterPath = join(source.security, 'instance.key');
    const record = JSON.parse(readFileSync(masterPath, 'utf8'));
    record.history = Array.from({ length: 999 }, (_, index) => ({ masterKeyId: `historical-${index}`, protectedKey: Buffer.alloc(32, index % 256).toString('base64'), retainedAt: '2026-10-21T00:00:00.000Z' }));
    writeFileSync(masterPath, JSON.stringify(record));
    const before = readFileSync(masterPath), path = join(root, 'at-capacity.mdrecovery');
    createRecoveryPackageFile(source.provider, path, 'capacity check passphrase', source.security);
    const target = join(root, 'target');
    assert.throws(() => restoreRecoveryPackageFile(path, 'capacity check passphrase', target, protector), { code: 'SECURITY_RESPONSE_LIMIT' });
    assert.equal(existsSync(target), false); assert.deepEqual(readFileSync(masterPath), before);
    source.material.key.fill(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('refuses new and rotated DEKs at the portable key limit while preserving existing keys', () => {
  const root = mkdtempSync(join(tmpdir(), 'modedb-recovery-dek-capacity-'));
  try {
    const source = createVault(root);
    for (let index = 0; index < 9999; index++) writeFileSync(join(source.security, `capacity-${index}.dek`), 'synthetic capacity placeholder');
    const before = readFileSync(source.vaultPath);
    assert.throws(() => source.provider.resolveKey('new-database'), { code: 'VAULT_KEY_UNAVAILABLE' });
    assert.throws(() => source.provider.prepareDatabaseKeyRotation(source.material.reference), { code: 'VAULT_KEY_UNAVAILABLE' });
    const stillAvailable = source.provider.resolveKey('graph', source.material.reference);
    assert.deepEqual(stillAvailable.key, source.material.key); stillAvailable.key.fill(0);
    assert.deepEqual(readFileSync(source.vaultPath), before); source.material.key.fill(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('creates a portable synthetic drill and prevents same-environment or edited-manifest acceptance', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'modedb-cross-machine-harness-'));
  try {
    const fixture = join(root, 'fixture'), secret = join(root, 'secret', 'phrase.txt');
    const prepared = prepareRecoveryDrill(fixture, secret);
    assert.equal(prepared.prepared, true);
    assert.deepEqual(readdirSync(fixture).sort(), ['manifest.json', 'material.mdrecovery', 'synthetic.mld']);
    assert.equal(verifyRecoveryPackageFile(join(fixture, 'material.mdrecovery'), readFileSync(secret, 'utf8')).databases, 1);
    assert.throws(() => verifyRecoveryDrill(fixture, secret), /RECOVERY_DRILL_REQUIRES_INDEPENDENT_WINDOWS_ENVIRONMENT/);
    const manifest = JSON.parse(readFileSync(join(fixture, 'manifest.json'), 'utf8'));
    manifest.sourceEnvironmentDigest = '0'.repeat(64);
    writeFileSync(join(fixture, 'manifest.json'), JSON.stringify(manifest));
    assert.throws(() => verifyRecoveryDrill(fixture, secret), /RECOVERY_DRILL_DATA_MISMATCH/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

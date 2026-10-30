import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { SecurityRegistry } from '../../packages/server/src/security/security-registry.js';
import { LocalVaultKeyProvider } from '../../packages/server/src/security/local-vault-key-provider.js';
import { WindowsSecretProtector, type SecretProtector } from '../../packages/server/src/security/windows-secret-protector.js';
import { type AtomicCommitPoint } from '../../packages/common/src/atomic-file.js';
import { type RegistrationApplication, type RegistrationLedger, assertRegistrationLedger } from '../../packages/server/src/security/registration-ledger.js';

const nowStart = Date.UTC(2026, 9, 27, 0, 0, 0);
const utc = (value: number) => new Date(value).toISOString();
const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const fixtureRoot = fileURLToPath(new URL('../fixtures/security-registration-legacy/', import.meta.url));
const sourceRoot = fileURLToPath(new URL('../../packages/server/src/security/', import.meta.url));

function encryptedFixture() {
  const root = mkdtempSync(join(tmpdir(), 'ModeDB-Registration-Storage-'));
  const dir = join(root, 'security');
  const key = randomBytes(32);
  let failure = false;
  const protector: SecretProtector = {
    id: 'test-only-aes-gcm',
    ensureDirectory(path) { mkdirSync(path, { recursive: true }); },
    protect(bytes, purpose) {
      if (failure) { throw new Error('injected ENOSPC'); }
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(purpose));
      const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
    },
    unprotect(value, purpose) {
      const bytes = Buffer.from(value, 'base64'), decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28)); decipher.setAAD(Buffer.from(purpose));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
    },
  };
  let now = nowStart;
  const options = { protector, now: () => now };
  let registry = SecurityRegistry.open(dir, options);
  const read = () => JSON.parse(protector.unprotect(readFileSync(join(dir, 'registry.mds'), 'utf8'), 'modeldb-registry-v1:' + registry.status().instanceId).toString());
  return { root, dir, protector, options, read,
    get registry() { return registry; }, set registry(value) { registry = value; },
    setTime(value: number) { now = value; }, setFailure(value: boolean) { failure = value; },
    reopen(extra: { onCommitPoint?: (point: AtomicCommitPoint) => void } = {}) { registry.close(); registry = SecurityRegistry.open(dir, { ...options, ...extra }); return registry; },
    close() { registry.close(); },
  };
}
function migrate(f: ReturnType<typeof encryptedFixture>) { f.registry.migrateRegistrationStorage(f.registry.status().revision); }
function save(f: ReturnType<typeof encryptedFixture>, next: RegistrationLedger) { f.registry.commitRegistrationStorage(f.registry.status().revision, next); }
function application(instanceId: string): RegistrationApplication {
  return { id: randomUUID(), instanceId, serverOrigin: 'https://modeldb-a.example.test', rpId: 'modeldb-a.example.test',
    deploymentDescriptorSha256: 'a'.repeat(64), displayName: 'Synthetic B', userHandle: randomBytes(32).toString('base64url'),
    continuationSecretHash: digest(randomBytes(32)), createdAtUtc: utc(nowStart), expiresAtUtc: utc(nowStart + 86400000), state: 'pending' };
}
function begin(f: ReturnType<typeof encryptedFixture>) {
  const next = f.registry.readRegistrationStorage(), app = application(f.registry.status().instanceId);
  next.applications.push(app);
  next.challenges.push({ id: randomUUID(), applicationId: app.id, purpose: 'registration', challengeHash: digest(randomBytes(32)),
    state: 'issued', createdAtUtc: utc(nowStart), expiresAtUtc: utc(nowStart + 60000) });
  save(f, next); return app.id;
}
/** Synthesize trusted storage input only; this does not simulate a valid WebAuthn proof. */
function approveStorage(f: ReturnType<typeof encryptedFixture>) {
  const principal = f.registry.createPrincipal('Synthetic human', 'operator');
  const id = begin(f), next = f.registry.readRegistrationStorage();
  const app = next.applications.find(value => value.id === id)!;
  app.candidate = { rawId: randomBytes(32).toString('base64url'), publicKeyCose: randomBytes(77).toString('base64url'),
    algorithm: -7, counter: 0, deviceType: 'multiDevice', backedUp: true };
  app.verifiedAtUtc = utc(nowStart); app.state = 'approved'; app.decidedAtUtc = utc(nowStart);
  app.userId = randomUUID(); app.credentialId = randomUUID();
  next.challenges.find(value => value.applicationId === id)!.state = 'consumed';
  next.challenges.find(value => value.applicationId === id)!.finishedAtUtc = utc(nowStart);
  next.users.push({ id: app.userId, principalId: principal.id, displayName: 'Synthetic human', enabled: true, createdAtUtc: utc(nowStart), updatedAtUtc: utc(nowStart) });
  next.credentials.push({ ...app.candidate, id: app.credentialId, applicationId: app.id, userId: app.userId,
    state: 'active', createdAtUtc: utc(nowStart), updatedAtUtc: utc(nowStart) });
  save(f, next); return { appId: id, credentialId: app.credentialId, principalId: principal.id };
}
function bytesIn(dir: string) {
  return Object.fromEntries(readdirSync(dir).filter(name => !name.endsWith('.lock')).sort().map(name => [name, digest(readFileSync(join(dir, name)))]));
}
let legacyPromise: Promise<typeof import('../../packages/server/src/security/security-registry.js')> | undefined;
async function legacyReader() {
  if (legacyPromise) { return legacyPromise; }
  const root = mkdtempSync(join(tmpdir(), 'ModeDB-Legacy-Registry-'));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  symlinkSync(realpathSync(resolve('node_modules')), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const fixture = readFileSync(join(fixtureRoot, 'security-registry-v1.original.ts.txt'));
  assert.equal(digest(fixture), 'ca5c64f8b3c5559cefffc0e11dfa2aa3240f96775b90f4f2a4e6f532fb3bdf0c');
  writeFileSync(join(root, 'security-registry.ts'), fixture);
  for (const name of ['local-vault-key-provider.ts', 'windows-secret-protector.ts', 'security-errors.ts', 'network-policy.ts']) {
    copyFileSync(join(sourceRoot, name), join(root, name));
  }
  legacyPromise = import(pathToFileURL(join(root, 'security-registry.ts')).href);
  return legacyPromise!;
}

test('new/opened V1 instances stay unmigrated and disabled until an explicit CAS migration', () => {
  const f = encryptedFixture();
  try {
    assert.equal(f.registry.registrationStorageStatus().ledgerVersion, 1);
    const original = bytesIn(f.dir), revision = f.registry.status().revision;
    f.reopen(); assert.deepEqual(bytesIn(f.dir), original);
    assert.throws(() => f.registry.readRegistrationStorage(), { code: 'SECURITY_PROTOCOL_UNSUPPORTED' });
    assert.throws(() => f.registry.migrateRegistrationStorage(revision - 1), { code: 'SECURITY_POLICY_CONFLICT' });
    assert.deepEqual(bytesIn(f.dir), original);
    migrate(f);
    assert.equal(f.registry.registrationStorageStatus().ledgerVersion, 2);
    assert.equal(f.registry.registrationStorageStatus().mode, 'disabled');
    assert.equal(f.registry.readRegistrationStorage().credentials.length, 0);
    const after = bytesIn(f.dir); migrate(f); assert.deepEqual(bytesIn(f.dir), after);
    f.reopen(); assert.equal(f.registry.registrationStorageStatus().ledgerVersion, 2);
  } finally { f.close(); }
});

test('migration preserves instance, grants, revocations, sessions, pairings, key bytes and old audit prefix', () => {
  const f = encryptedFixture();
  try {
    const principal = f.registry.createPrincipal('Synthetic application');
    const grant = [{ database: 'graph', resource: '*', actions: ['model.read' as const] }];
    const token = f.registry.createCredential(principal.id, 'Synthetic active', grant);
    const revoked = f.registry.createCredential(principal.id, 'Synthetic revoked', grant);
    f.registry.revokeCredential(revoked.credential.id);
    const session = f.registry.createSession(token.token);
    const pairing = f.registry.createPairingForCredential(token.credential.id, 10, 'https://modeldb-a.example.test');
    const keys = new LocalVaultKeyProvider(f.dir, f.protector), material = keys.resolveKey('graph');
    f.registry.registerKeyReference(material.reference); material.key.fill(0);
    const keyFiles = Object.fromEntries(readdirSync(f.dir).filter(name => name === 'instance.key' || name.endsWith('.dek')).map(name => [name, digest(readFileSync(join(f.dir, name)))]));
    const prior = f.read(); migrate(f); const after = f.read();
    for (const key of ['instanceId', 'policyVersion', 'accessEpoch', 'principals', 'credentials', 'sessions', 'pairings', 'keyReferences']) {
      assert.equal(digest(JSON.stringify(after[key])), digest(JSON.stringify(prior[key])), key + ' preserved');
    }
    assert.equal(digest(JSON.stringify(after.events.slice(0, prior.events.length))), digest(JSON.stringify(prior.events)));
    assert.equal(after.events.at(-1).action, 'registration.storage.migrate');
    assert.equal(after.revision, prior.revision + 1);
    for (const [name, expected] of Object.entries(keyFiles)) { assert.equal(digest(readFileSync(join(f.dir, name))), expected); }
    f.reopen();
    assert.equal(f.registry.authenticate(token.token).actor.principalId, principal.id);
    assert.equal(f.registry.verifySession(session.session).actor.principalId, principal.id);
    assert.throws(() => f.registry.authenticate(revoked.token), { code: 'SECURITY_CREDENTIAL_REVOKED' });
    assert.ok(pairing.id);
  } finally { f.close(); }
});

test('persists linked applications/public keys/users, clones snapshots and hides storage from public snapshots/audit', () => {
  const f = encryptedFixture();
  try {
    migrate(f); const ids = approveStorage(f);
    const store = f.registry.readRegistrationStorage(), rawKey = store.credentials[0]!.publicKeyCose;
    const secretHash = store.applications[0]!.continuationSecretHash;
    store.credentials[0]!.rawId = 'changed';
    assert.notEqual(f.registry.readRegistrationStorage().credentials[0]!.rawId, 'changed');
    const publicOutput = JSON.stringify([f.registry.securityCenterSnapshot(), f.registry.registrationStorageStatus(), f.registry.auditEvents()]);
    assert.equal(publicOutput.includes(rawKey), false); assert.equal(publicOutput.includes(secretHash), false);
    assert.equal(readFileSync(join(f.dir, 'registry.mds')).includes(Buffer.from(rawKey)), false);
    f.reopen();
    assert.equal(f.registry.readRegistrationStorage().credentials[0]!.id, ids.credentialId);
    assert.equal(f.registry.readRegistrationStorage().users[0]!.principalId, ids.principalId);
    assert.equal(f.registry.listCredentials().length, 0);
    assert.throws(() => f.registry.authenticate(ids.credentialId), { code: 'SECURITY_CREDENTIAL_INVALID' });
  } finally { f.close(); }
});

test('rejects untrusted fields, unknown mode, foreign binding, duplicate IDs, missing links and unsupported storage versions', () => {
  const f = encryptedFixture();
  try {
    migrate(f); approveStorage(f);
    for (const mutate of [
      (s: RegistrationLedger) => { (s as unknown as Record<string, unknown>).token = 'synthetic-secret'; },
      (s: RegistrationLedger) => { (s as unknown as Record<string, unknown>).mode = 'unknown'; },
      (s: RegistrationLedger) => { s.applications[0]!.instanceId = randomUUID(); },
      (s: RegistrationLedger) => { s.credentials[0]!.userId = randomUUID(); },
      (s: RegistrationLedger) => { s.users[0]!.principalId = randomUUID(); },
      (s: RegistrationLedger) => { s.credentials.push(structuredClone(s.credentials[0]!)); },
      (s: RegistrationLedger) => { s.applications[0]!.continuationSecretHash += '\n'; },
      (s: RegistrationLedger) => { s.credentials[0]!.publicKeyCose = 'AB'; },
      (s: RegistrationLedger) => { (s as unknown as Record<string, unknown>).version = 2; },
    ]) {
      const next = f.registry.readRegistrationStorage(), prior = bytesIn(f.dir); mutate(next);
      assert.throws(() => save(f, next)); assert.deepEqual(bytesIn(f.dir), prior);
    }
  } finally { f.close(); }
});

test('CAS, monotone counters, immutable links and terminal credential states reject stale/rollback writes', () => {
  const f = encryptedFixture();
  try {
    migrate(f); approveStorage(f);
    const staleRevision = f.registry.status().revision, stale = f.registry.readRegistrationStorage();
    let next = f.registry.readRegistrationStorage(); next.credentials[0]!.counter = 1; save(f, next);
    assert.throws(() => f.registry.commitRegistrationStorage(staleRevision, stale), { code: 'SECURITY_POLICY_CONFLICT' });
    assert.throws(() => save(f, stale));
    next = f.registry.readRegistrationStorage(); next.credentials[0]!.state = 'disabled'; next.credentials[0]!.disabledAtUtc = utc(nowStart); save(f, next);
    next = f.registry.readRegistrationStorage(); next.credentials[0]!.state = 'active'; delete next.credentials[0]!.disabledAtUtc; save(f, next);
    next = f.registry.readRegistrationStorage(); next.credentials[0]!.state = 'revoked'; next.credentials[0]!.revokedAtUtc = utc(nowStart); save(f, next);
    next = f.registry.readRegistrationStorage(); next.credentials[0]!.state = 'active'; delete next.credentials[0]!.revokedAtUtc;
    assert.throws(() => save(f, next), { code: 'SECURITY_REGISTRATION_CONFLICT' });
    f.reopen(); assert.equal(f.registry.readRegistrationStorage().credentials[0]!.state, 'revoked');
  } finally { f.close(); }
});

test('expired challenges can be reclaimed but issued or consumed challenges cannot be resurrected', () => {
  const f = encryptedFixture();
  try {
    migrate(f); begin(f);
    let next = f.registry.readRegistrationStorage(); next.challenges[0]!.state = 'consumed'; next.challenges[0]!.finishedAtUtc = utc(nowStart); save(f, next);
    next = f.registry.readRegistrationStorage(); next.challenges[0]!.state = 'issued'; delete next.challenges[0]!.finishedAtUtc;
    assert.throws(() => save(f, next), { code: 'SECURITY_REGISTRATION_CONFLICT' });
    next = f.registry.readRegistrationStorage(); next.challenges = []; assert.throws(() => save(f, next));
    f.setTime(nowStart + 60001); save(f, next); f.reopen(); assert.equal(f.registry.readRegistrationStorage().challenges.length, 0);
  } finally { f.close(); }
});

test('access reset atomically revokes public-key records and rejects pending applications/challenges', () => {
  const f = encryptedFixture();
  try {
    migrate(f); approveStorage(f); begin(f);
    f.registry.resetAccess();
    f.reopen(); const store = f.registry.readRegistrationStorage();
    assert.equal(store.credentials[0]!.state, 'revoked');
    assert.equal(store.applications.filter(a => a.state === 'pending').length, 0);
    assert.equal(store.challenges.filter(c => c.state === 'issued').length, 0);
    assert.equal(f.registry.auditEvents().at(-1)!.action, 'access.reset');
  } finally { f.close(); }
});

test('the frozen V1 reader refuses an upgraded store and leaves all protected materials unchanged', async () => {
  const f = encryptedFixture();
  try {
    const old = await legacyReader();
    f.close(); old.SecurityRegistry.open(f.dir, f.options).close();
    f.registry = SecurityRegistry.open(f.dir, f.options); migrate(f); f.close();
    const before = bytesIn(f.dir);
    assert.throws(() => old.SecurityRegistry.open(f.dir, f.options), { code: 'SECURITY_STORE_INVALID' });
    assert.deepEqual(bytesIn(f.dir), before);
    f.registry = SecurityRegistry.open(f.dir, f.options); assert.equal(f.registry.registrationStorageStatus().ledgerVersion, 2);
    f.registry.migrateSessionStorage(f.registry.status().revision); f.close();
    const v3 = bytesIn(f.dir);
    assert.throws(() => old.SecurityRegistry.open(f.dir, f.options), { code: 'SECURITY_STORE_INVALID' });
    assert.deepEqual(bytesIn(f.dir), v3);
    f.registry = SecurityRegistry.open(f.dir, f.options); assert.equal(f.registry.registrationStorageStatus().ledgerVersion, 3);
  } finally { f.close(); }
});

for (const point of ['staged', 'journaled', 'replaced'] as const) {
  test('migration recovers without identity/audit loss after interruption at ' + point, async () => {
    const f = encryptedFixture();
    try {
      const before = f.registry.status(), keysBefore = digest(readFileSync(join(f.dir, 'instance.key')));
      f.reopen({ onCommitPoint(p) { if (p === point) { throw new Error('injected interrupted migration'); } } });
      assert.throws(() => migrate(f), { code: 'SECURITY_STORE_WRITE_FAILED' });
      assert.throws(() => f.registry.status(), { code: 'SECURITY_CLOSED' });
      assert.equal(existsSync(join(f.dir, 'registry.mds.commit')), point !== 'staged');
      if (point !== 'staged') {
        const old = await legacyReader(), material = bytesIn(f.dir);
        assert.throws(() => old.SecurityRegistry.open(f.dir, f.options), { code: 'SECURITY_STORE_INVALID' });
        assert.deepEqual(bytesIn(f.dir), material);
      }
      f.reopen();
      assert.equal(f.registry.status().instanceId, before.instanceId);
      assert.equal(digest(readFileSync(join(f.dir, 'instance.key'))), keysBefore);
      assert.equal(f.registry.registrationStorageStatus().ledgerVersion, point === 'staged' ? 1 : 2);
      assert.equal(f.registry.auditEvents().filter(e => e.action === 'registration.storage.migrate').length, point === 'staged' ? 0 : 1);
    } finally { f.close(); }
  });
}

test('write/protection or audit-capacity failures preserve old state and never report migration success', () => {
  const f = encryptedFixture();
  try {
    const before = bytesIn(f.dir); f.setFailure(true);
    assert.throws(() => migrate(f), { code: 'SECURITY_STORE_WRITE_FAILED' });
    assert.deepEqual(bytesIn(f.dir), before); f.setFailure(false); f.reopen();
    assert.equal(f.registry.registrationStorageStatus().ledgerVersion, 1);
    f.close(); f.registry = SecurityRegistry.open(f.dir, { ...f.options, auditLimit: 1 });
    assert.throws(() => migrate(f), { code: 'SECURITY_AUDIT_CAPACITY' });
    assert.deepEqual(bytesIn(f.dir), before);
  } finally { f.close(); }
});

test('unknown/corrupt formats and orphan registration fields fail closed without replacing the store', () => {
  for (const kind of ['future', 'invalid-link', 'v1-extension']) {
    const f = encryptedFixture();
    try {
      migrate(f); const raw = f.read(); f.close();
      if (kind === 'future') { raw.version = 5; }
      else if (kind === 'invalid-link') { raw.registration.applications = [application(randomUUID())]; }
      else { raw.version = 1; }
      writeFileSync(join(f.dir, 'registry.mds'), f.protector.protect(Buffer.from(JSON.stringify(raw)), 'modeldb-registry-v1:' + raw.instanceId));
      const original = bytesIn(f.dir);
      assert.throws(() => SecurityRegistry.open(f.dir, f.options), { code: 'SECURITY_STORE_INVALID' });
      assert.deepEqual(bytesIn(f.dir), original);
    } finally { f.close(); }
  }
});

test('bounded pending records reject overflow without allocating or writing new protected state', () => {
  const f = encryptedFixture();
  try {
    migrate(f); const next = f.registry.readRegistrationStorage();
    for (let i = 0; i < 1001; i++) { next.applications.push(application(f.registry.status().instanceId)); }
    const before = bytesIn(f.dir);
    assert.throws(() => save(f, next), { code: 'SECURITY_REGISTRATION_CAPACITY' });
    assert.deepEqual(bytesIn(f.dir), before);
    assert.equal(f.registry.readRegistrationStorage().applications.length, 0);
  } finally { f.close(); }
});

test('storage schema rejects cyclic input, malformed origins and application principals with stable errors', () => {
  const f = encryptedFixture();
  try {
    migrate(f); const appId = begin(f), principal = f.registry.createPrincipal('Not a human');
    const baseline = f.registry.readRegistrationStorage();
    for (const [index, mutate] of [
      (s: RegistrationLedger) => { s.applications[0]!.serverOrigin = 'https://a:b:c'; },
      (s: RegistrationLedger) => { s.applications[0]!.serverOrigin = 'https://bad-.example.test'; s.applications[0]!.rpId = 'bad-.example.test'; },
      (s: RegistrationLedger) => { s.users.push({ id: randomUUID(), principalId: principal.id, displayName: 'Synthetic', enabled: true, createdAtUtc: utc(nowStart), updatedAtUtc: utc(nowStart) }); },
      (s: RegistrationLedger) => { (s.applications as unknown[]).push(s); },
    ].entries()) {
      const next = structuredClone(baseline); mutate(next);
      assert.throws(() => assertRegistrationLedger(next, f.registry.status().instanceId, [{ id: principal.id, kind: 'application' }]), { code: index < 2 ? 'SECURITY_REGISTRATION_ORIGIN_MISMATCH' : 'SECURITY_REGISTRATION_SCHEMA_INVALID' });
    }
    assert.equal(f.registry.readRegistrationStorage().applications[0]!.id, appId);
  } finally { f.close(); }
});

test('pending proof storage requires a consumed unexpired challenge and no future timestamps', () => {
  const f = encryptedFixture();
  try {
    migrate(f); begin(f);
    const next = f.registry.readRegistrationStorage();
    next.applications[0]!.candidate = { rawId: randomBytes(32).toString('base64url'), publicKeyCose: randomBytes(77).toString('base64url'), algorithm: -7, counter: 0, deviceType: 'singleDevice', backedUp: false };
    next.applications[0]!.verifiedAtUtc = utc(nowStart);
    assert.throws(() => save(f, next));
    next.challenges[0]!.state = 'consumed'; next.challenges[0]!.finishedAtUtc = utc(nowStart);
    f.setTime(nowStart + 60000); assert.throws(() => save(f, next));
    f.setTime(nowStart); next.applications[0]!.verifiedAtUtc = utc(nowStart + 1); assert.throws(() => save(f, next));
    next.applications[0]!.verifiedAtUtc = utc(nowStart); save(f, next);
    next.applications[0]!.displayName = 'Mutated after commit';
    assert.equal(f.registry.readRegistrationStorage().applications[0]!.displayName, 'Synthetic B');
  } finally { f.close(); }
});

test('per-user credential storage and challenge collections enforce their exact capacity bounds', () => {
  const f = encryptedFixture();
  try {
    migrate(f); const identity = approveStorage(f), baseline = f.registry.readRegistrationStorage();
    const next = structuredClone(baseline);
    next.challenges = [];
    for (let count = 1; count < 20; count++) {
      const app = structuredClone(baseline.applications[0]!), key = structuredClone(baseline.credentials[0]!);
      app.id = randomUUID(); app.userHandle = randomBytes(32).toString('base64url'); app.credentialId = randomUUID();
      app.candidate!.rawId = randomBytes(32).toString('base64url');
      key.id = app.credentialId; key.applicationId = app.id; key.rawId = app.candidate!.rawId;
      next.applications.push(app); next.credentials.push(key);
    }
    const principals = [{ id: identity.principalId, kind: 'operator' }];
    assert.doesNotThrow(() => assertRegistrationLedger(next, f.registry.status().instanceId, principals));
    const app = structuredClone(baseline.applications[0]!), key = structuredClone(baseline.credentials[0]!);
    app.id = randomUUID(); app.userHandle = randomBytes(32).toString('base64url'); app.credentialId = randomUUID(); app.candidate!.rawId = randomBytes(32).toString('base64url');
    key.id = app.credentialId; key.applicationId = app.id; key.rawId = app.candidate!.rawId;
    next.applications.push(app); next.credentials.push(key);
    assert.throws(() => assertRegistrationLedger(next, f.registry.status().instanceId, principals), { code: 'SECURITY_REGISTRATION_CAPACITY' });
    const overChallenges = structuredClone(baseline);
    overChallenges.challenges = Array.from({ length: 1001 }, () => ({ ...baseline.challenges[0]!, id: randomUUID() }));
    assert.throws(() => assertRegistrationLedger(overChallenges, f.registry.status().instanceId, principals), { code: 'SECURITY_REGISTRATION_CAPACITY' });
  } finally { f.close(); }
});

for (const point of ['staged', 'journaled', 'replaced'] as const) {
  test('registration record and audit recover as one commit at ' + point, () => {
    const f = encryptedFixture();
    try {
      migrate(f);
      f.reopen({ onCommitPoint(p) { if (p === point) { throw new Error('injected storage interruption'); } } });
      assert.throws(() => begin(f), { code: 'SECURITY_STORE_WRITE_FAILED' });
      f.reopen();
      const count = point === 'staged' ? 0 : 1;
      assert.equal(f.registry.readRegistrationStorage().applications.length, count);
      assert.equal(f.registry.readRegistrationStorage().challenges.length, count);
      assert.equal(f.registry.auditEvents().filter(event => event.action === 'registration.storage.update').length, count);
    } finally { f.close(); }
  });
}

test('corrupt migration intent stays available for diagnosis and does not fall back to an empty registry', () => {
  const f = encryptedFixture();
  try {
    f.reopen({ onCommitPoint(point) { if (point === 'journaled') { throw new Error('injected interruption'); } } });
    assert.throws(() => migrate(f), { code: 'SECURITY_STORE_WRITE_FAILED' });
    const path = join(f.dir, 'registry.mds.pending');
    writeFileSync(path, 'synthetic corrupt pending bytes');
    const before = bytesIn(f.dir);
    assert.throws(() => SecurityRegistry.open(f.dir, f.options), { code: 'SECURITY_STORE_INVALID' });
    assert.deepEqual(bytesIn(f.dir), before);
  } finally { f.close(); }
});

test('a real child exit after the migration intent is durable recovers through the dead-owner lease', { timeout: 120000 }, () => {
  assert.equal(process.platform, 'win32');
  const root = mkdtempSync(join(tmpdir(), 'ModeDB-Registration-Process-')), dir = join(root, 'security');
  let registry = SecurityRegistry.open(dir);
  try {
    const instance = registry.status().instanceId; registry.close();
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval',
      'import {SecurityRegistry} from "./packages/server/src/security/security-registry.ts"; const r=SecurityRegistry.open(process.env.MODEDB_P13_TEST_DIR,{onCommitPoint(p){if(p==="journaled")process.exit(73);}}); r.migrateRegistrationStorage(r.status().revision);'],
      { cwd: resolve('.'), env: { ...process.env, MODEDB_P13_TEST_DIR: dir }, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    assert.equal(child.status, 73, 'Child must exit at the specified durable point');
    assert.equal(existsSync(join(dir, 'registry.mds.commit')), true);
    registry = SecurityRegistry.open(dir);
    assert.equal(registry.status().instanceId, instance);
    assert.equal(registry.registrationStorageStatus().ledgerVersion, 2);
    assert.equal(registry.auditEvents().filter(event => event.action === 'registration.storage.migrate').length, 1);
  } finally { registry.close(); }
});

test('Windows DPAPI protects an isolated migrated registry and preserves its instance key', { timeout: 120000 }, () => {
  assert.equal(process.platform, 'win32', 'This required acceptance case needs Windows; do not mark it skipped.');
  const root = mkdtempSync(join(tmpdir(), 'ModeDB-Registration-DPAPI-')), dir = join(root, 'security');
  let registry = SecurityRegistry.open(dir);
  try {
    const before = digest(readFileSync(join(dir, 'instance.key'))), instance = registry.status().instanceId;
    registry.migrateRegistrationStorage(registry.status().revision); registry.close();
    registry = SecurityRegistry.open(dir);
    assert.equal(registry.status().instanceId, instance);
    assert.equal(registry.registrationStorageStatus().ledgerVersion, 2);
    assert.equal(digest(readFileSync(join(dir, 'instance.key'))), before);
    const plaintext = new WindowsSecretProtector().unprotect(readFileSync(join(dir, 'registry.mds'), 'utf8'), 'modeldb-registry-v1:' + instance);
    try { assert.equal(JSON.parse(plaintext.toString()).version, 2); } finally { plaintext.fill(0); }
  } finally { registry.close(); }
});

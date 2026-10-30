import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SecurityRegistry } from '../../packages/server/src/security/security-registry.js';
import { AuthorizationService } from '../../packages/server/src/security/authorization-service.js';
import { RegistrationService } from '../../packages/server/src/security/registration-service.js';
import type { SecretProtector } from '../../packages/server/src/security/windows-secret-protector.js';
import type { AtomicCommitPoint } from '../../packages/common/src/atomic-file.js';

const start = Date.parse('2026-10-27T12:00:00Z');
const utc = (ms: number) => new Date(ms).toISOString();
const digest = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const origin = 'http://127.0.0.1:5175';
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ModeDB-Session-Parent-')), key = randomBytes(32);
  let now = start, failure = false;
  const protector: SecretProtector = {
    id: 'synthetic-session-parent-aes-gcm',
    ensureDirectory(path) { mkdirSync(path, { recursive: true }); },
    protect(bytes, purpose) {
      if (failure) { throw new Error('synthetic protection failure'); }
      const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv);
      c.setAAD(Buffer.from(purpose));
      const encrypted = Buffer.concat([c.update(bytes), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), encrypted]).toString('base64');
    },
    unprotect(value, purpose) {
      const b = Buffer.from(value, 'base64'), c = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
      c.setAuthTag(b.subarray(12, 28)); c.setAAD(Buffer.from(purpose));
      return Buffer.concat([c.update(b.subarray(28)), c.final()]);
    },
  };
  const options = { protector, now: () => now };
  let registry = SecurityRegistry.open(dir, options);
  const instance = registry.status().instanceId, purpose = 'modeldb-registry-v1:' + instance;
  return {
    dir, options, instance,
    get registry() { return registry; },
    setTime(value: number) { now = value; },
    setFailure(value: boolean) { failure = value; },
    read() { return JSON.parse(protector.unprotect(readFileSync(join(dir, 'registry.mds'), 'utf8'), purpose).toString()); },
    // Only trusted synthetic test material is edited. This is not a session issuance API.
    write(value: unknown) { registry.close(); writeFileSync(join(dir, 'registry.mds'), protector.protect(Buffer.from(JSON.stringify(value)), purpose)); },
    reopen(extra: { onCommitPoint?: (point: AtomicCommitPoint) => void; auditLimit?: number } = {}) {
      registry.close(); registry = SecurityRegistry.open(dir, { ...options, ...extra }); return registry;
    },
    close() { registry.close(); },
  };
}
type Fixture = ReturnType<typeof fixture>;
function migrate(f: Fixture) { f.registry.migrateSessionStorage(f.registry.status().revision); }
function api(f: Fixture, principalId?: string) {
  const principal = principalId ?? f.registry.createPrincipal('Synthetic operator', 'operator').id;
  return f.registry.createCredential(principal, 'Synthetic API', [{ database: 'api_graph', resource: '*', actions: ['model.read'] }]);
}
/** Trusted synthetic public-key ledger input, no WebAuthn authentication claim. */
function publicSession(f: Fixture, principalId?: string) {
  migrate(f);
  const principal = principalId ?? f.registry.createPrincipal('Synthetic key owner', 'operator').id;
  const next = f.registry.readRegistrationStorage(), applicationId = randomUUID(), credentialId = randomUUID(), userId = randomUUID();
  const candidate = { rawId: randomBytes(32).toString('base64url'), publicKeyCose: randomBytes(77).toString('base64url'), algorithm: -7 as const, counter: 0, deviceType: 'multiDevice' as const, backedUp: true };
  next.applications.push({ id: applicationId, instanceId: f.instance, serverOrigin: 'https://modeldb-a.example.test', rpId: 'modeldb-a.example.test', deploymentDescriptorSha256: 'a'.repeat(64), displayName: 'Synthetic key', userHandle: randomBytes(32).toString('base64url'), continuationSecretHash: digest(randomBytes(32)), createdAtUtc: utc(start), expiresAtUtc: utc(start + 86400000), state: 'approved', verifiedAtUtc: utc(start), candidate, decidedAtUtc: utc(start), userId, credentialId });
  next.users.push({ id: userId, principalId: principal, displayName: 'Synthetic owner', enabled: true, createdAtUtc: utc(start), updatedAtUtc: utc(start) });
  next.credentials.push({ ...candidate, id: credentialId, applicationId, userId, state: 'active', createdAtUtc: utc(start), updatedAtUtc: utc(start), grants: [{ database: 'key_graph', resource: '*', actions: ['model.read'] }] });
  const id = randomUUID(), session = `mdbs_v1_${id}_${randomBytes(32).toString('base64url')}`;
  const state = f.read();
  state.registration = next;
  state.sessions.push({ id, principalId: principal, credentialId, parent: { kind: 'registered-public-key', credentialId, userId }, secretHash: digest(session), accessEpoch: state.accessEpoch, createdAt: utc(start), expiresAt: utc(start + 30 * 60000), absoluteExpiresAt: utc(start + 8 * 3600000), origin: 'https://modeldb-a.example.test' });
  f.write(state); f.reopen();
  return { session, id, credentialId, userId, principalId: principal };
}

for (const version of [1, 2]) {
  test(`V${version} open is read-only; explicit CAS migration preserves tokens, pairings, sessions and keys`, () => {
    const f = fixture();
    try {
      if (version === 2) { f.registry.migrateRegistrationStorage(f.registry.status().revision); }
      const token = api(f), session = f.registry.createSession(token.token);
      const pairing = f.registry.createPairingForCredential(token.credential.id, 5, origin);
      const adminPair = f.registry.createLocalBrowserPairing(origin, [], true), admin = f.registry.consumePairing(adminPair.code, origin);
      const adminId = f.registry.verifyBrowserSession(admin.session, origin).credential.id;
      assert.throws(() => f.registry.rotateCredential(adminId), { code: 'SECURITY_INVALID_REQUEST' });
      assert.throws(() => f.registry.createPairingForCredential(adminId, 5, origin), { code: 'SECURITY_INVALID_REQUEST' });
      const before = f.read(), raw = readFileSync(join(f.dir, 'registry.mds')), key = readFileSync(join(f.dir, 'instance.key'));
      f.reopen(); assert.deepEqual(readFileSync(join(f.dir, 'registry.mds')), raw);
      assert.throws(() => f.registry.migrateSessionStorage(before.revision - 1), { code: 'SECURITY_POLICY_CONFLICT' });
      migrate(f); const after = f.read();
      assert.equal(after.version, 3); assert.equal(after.revision, before.revision + 1);
      for (const field of ['instanceId', 'policyVersion', 'accessEpoch', 'principals', 'keyReferences']) { assert.deepEqual(after[field], before[field]); }
      assert.deepEqual(after.events.slice(0, before.events.length), before.events);
      assert.deepEqual(readFileSync(join(f.dir, 'instance.key')), key);
      f.reopen(); assert.equal(f.registry.authenticate(token.token).credential.id, token.credential.id);
      assert.equal(f.registry.verifySession(session.session).sessionParent?.kind, 'api-credential');
      assert.equal(f.registry.verifyBrowserSession(admin.session, origin).sessionParent?.kind, 'local-management');
      assert.equal(f.registry.verifyBrowserSession(admin.session, origin).securityAdmin, true);
      f.registry.consumePairing(pairing.code, origin);
      const migrated = readFileSync(join(f.dir, 'registry.mds')); migrate(f);
      assert.deepEqual(readFileSync(join(f.dir, 'registry.mds')), migrated);
      f.registry.migrateRegistrationStorage(f.registry.status().revision);
      assert.equal(f.registry.registrationStorageStatus().ledgerVersion, 3);
    } finally { f.close(); }
  });
}

test('V3 API issuance, invitation, rotation and revocation preserve the API namespace', () => {
  const f = fixture();
  try {
    migrate(f); const token = api(f), pairing = f.registry.createPairingForCredential(token.credential.id, 5, origin);
    const session = f.registry.consumePairing(pairing.code, origin), rotated = f.registry.rotateSession(session.session);
    assert.deepEqual(f.registry.verifySession(rotated.session).sessionParent, { kind: 'api-credential', credentialId: token.credential.id });
    assert.notEqual(f.registry.verifyBrowserSession(rotated.session, origin).securityAdmin, true);
    const next = f.registry.rotateCredential(token.credential.id, 0);
    assert.throws(() => f.registry.verifySession(rotated.session), { code: 'SECURITY_CREDENTIAL_REVOKED' });
    f.registry.authenticate(next.token); f.registry.revokeCredential(next.credential.id);
    f.reopen(); assert.throws(() => f.registry.authenticate(next.token), { code: 'SECURITY_CREDENTIAL_REVOKED' });
  } finally { f.close(); }
});

test('local management remains empty-scope and cannot be rotated or paired into a reusable API identity', () => {
  const f = fixture();
  try {
    migrate(f); const code = f.registry.createLocalBrowserPairing(origin, ['ignored_graph'], true);
    const session = f.registry.consumePairing(code.code, origin), verified = f.registry.verifyBrowserSession(session.session, origin);
    assert.deepEqual(verified.credential.grants, []);
    assert.throws(() => new AuthorizationService(() => verified, 'designer').require('ignored_graph', 'model.read'), { code: 'SECURITY_FORBIDDEN' });
    assert.throws(() => f.registry.rotateCredential(verified.credential.id), { code: 'SECURITY_INVALID_REQUEST' });
    assert.throws(() => f.registry.createPairingForCredential(verified.credential.id, 5, origin), { code: 'SECURITY_INVALID_REQUEST' });
    const forgedToken = `mdbt_v1_${verified.credential.id}_${randomBytes(32).toString('base64url')}`, state = f.read();
    state.credentials.find((c: { id: string }) => c.id === verified.credential.id).secretHash = digest(forgedToken);
    f.write(state); f.reopen();
    assert.throws(() => f.registry.authenticate(forgedToken), { code: 'SECURITY_CREDENTIAL_INVALID' });
    const rotated = f.registry.rotateSession(session.session); f.reopen();
    assert.equal(f.registry.verifyBrowserSession(rotated.session, origin).securityAdmin, true);
    f.registry.revokeSession(rotated.session);
    assert.throws(() => f.registry.verifySession(rotated.session), { code: 'SECURITY_CREDENTIAL_REVOKED' });
  } finally { f.close(); }
});

test('registered parent resolves only its own live grants and never mints or inherits API credentials', () => {
  const f = fixture();
  try {
    const token = api(f), key = publicSession(f, token.credential.principalId), before = f.registry.listCredentials();
    const verified = f.registry.verifySession(key.session);
    assert.equal(verified.sessionParent?.kind, 'registered-public-key');
    assert.deepEqual(verified.credential.grants.map(g => g.database), ['key_graph']);
    assert.throws(() => new AuthorizationService(() => verified, 'designer').require('api_graph', 'model.read'), { code: 'SECURITY_FORBIDDEN' });
    assert.throws(() => f.registry.authenticate(key.credentialId), { code: 'SECURITY_CREDENTIAL_INVALID' });
    assert.throws(() => f.registry.createPairingForCredential(key.credentialId, 5, origin), { code: 'SECURITY_NOT_FOUND' });
    f.registry.revokeCredential(token.credential.id); f.registry.verifySession(key.session);
    const browser = f.registry.verifyBrowserSession(key.session, 'https://modeldb-a.example.test');
    assert.notEqual(browser.securityAdmin, true);
    assert.throws(() => f.registry.verifyBrowserSession(key.session, origin), { code: 'SECURITY_ORIGIN_DENIED' });
    assert.throws(() => f.registry.rotateSession(key.session, 31), { code: 'SECURITY_INVALID_REQUEST' });
    const rotated = f.registry.rotateSession(key.session);
    assert.equal(f.registry.verifySession(rotated.session).sessionParent?.kind, 'registered-public-key');
    f.registry.revokeSession(rotated.session); assert.deepEqual(f.registry.listCredentials().map(c => c.id), before.map(c => c.id));
    assert.equal(f.registry.readRegistrationStorage().credentials[0]!.state, 'active');
    assert.equal(f.registry.allowsBrowserOrigin('https://modeldb-a.example.test'), false);
  } finally { f.close(); }
});

for (const condition of ['disabled-key', 'revoked-key', 'disabled-user', 'disabled-principal', 'expired', 'reset'] as const) {
  test('registered parent fails closed after ' + condition, () => {
    const f = fixture();
    try {
      const key = publicSession(f), state = f.read();
      if (condition === 'disabled-key') { state.registration.credentials[0].state = 'disabled'; state.registration.credentials[0].disabledAtUtc = utc(start); }
      if (condition === 'revoked-key') { state.registration.credentials[0].state = 'revoked'; state.registration.credentials[0].revokedAtUtc = utc(start); }
      if (condition === 'disabled-user') { state.registration.users[0].enabled = false; }
      if (condition === 'disabled-principal') { state.principals[0].enabled = false; }
      if (condition === 'reset') { f.registry.resetAccess(); } else { f.write(state); }
      f.reopen(); if (condition === 'expired') { f.setTime(start + 30 * 60000); }
      assert.throws(() => f.registry.verifySession(key.session), { code: condition === 'expired' ? 'SECURITY_CREDENTIAL_EXPIRED' : 'SECURITY_CREDENTIAL_REVOKED' });
      assert.equal(f.registry.securityCenterSnapshot().sessions[0]!.active, false);
      assert.equal(f.registry.allowsBrowserOrigin('https://modeldb-a.example.test'), false);
    } finally { f.close(); }
  });
}

const invalidCases: [string, (s: any) => void][] = [
  ['missing parent', s => { delete s.sessions[0].parent; }],
  ['null parent', s => { s.sessions[0].parent = null; }],
  ['unknown kind', s => { s.sessions[0].parent.kind = 'api'; }],
  ['foreign credential', s => { s.sessions[0].parent.credentialId = randomUUID(); }],
  ['foreign user', s => { s.sessions[0].parent.userId = randomUUID(); }],
  ['foreign principal', s => { s.sessions[0].principalId = randomUUID(); }],
  ['API namespace confusion', s => { s.sessions[0].parent = { kind: 'api-credential', credentialId: s.sessions[0].credentialId }; }],
  ['management namespace confusion', s => { s.sessions[0].parent = { kind: 'local-management', credentialId: s.sessions[0].credentialId }; s.sessions[0].securityAdmin = true; }],
  ['public key with admin flag', s => { s.sessions[0].securityAdmin = true; }],
  ['public key with wrong Origin', s => { s.sessions[0].origin = origin; }],
  ['public key with no absolute expiry', s => { delete s.sessions[0].absoluteExpiresAt; }],
  ['public key with long lifetime', s => { s.sessions[0].expiresAt = utc(start + 31 * 60000); }],
  ['public key with long absolute expiry', s => { s.sessions[0].absoluteExpiresAt = utc(start + 9 * 3600000); }],
  ['secret on parent', s => { s.sessions[0].parent.privateKey = 'synthetic-forbidden'; }],
  ['secret on session', s => { s.sessions[0].privateKey = 'synthetic-forbidden'; }],
  ['overlapping credential namespace', s => { s.credentials.push({ id: s.sessions[0].credentialId, principalId: s.sessions[0].principalId, kind: 'api-credential', name: 'Synthetic collision', secretHash: 'a'.repeat(64), createdAt: utc(start), expiresAt: utc(start + 86400000), grants: [] }); }],
  ['public key pairing', s => { s.pairings.push({ ...s.sessions[0], id: randomUUID() }); }],
  ['downgraded root with new parent', s => { s.version = 2; }],
];
for (const [name, mutate] of invalidCases) {
  test('rejects malformed persisted parent: ' + name, () => {
    const f = fixture();
    try { publicSession(f); const state = f.read(); mutate(state); f.write(state);
      const bytes = readFileSync(join(f.dir, 'registry.mds'));
      assert.throws(() => f.reopen(), { code: 'SECURITY_STORE_INVALID' });
      assert.deepEqual(readFileSync(join(f.dir, 'registry.mds')), bytes);
    } finally { f.close(); }
  });
}

for (const point of ['staged', 'journaled', 'replaced'] as const) {
  test('session migration and audit recover atomically at ' + point, () => {
    const f = fixture();
    try {
      const token = api(f), session = f.registry.createSession(token.token), key = readFileSync(join(f.dir, 'instance.key'));
      f.reopen({ onCommitPoint(p) { if (p === point) { throw new Error('synthetic interruption'); } } });
      assert.throws(() => migrate(f), { code: 'SECURITY_STORE_WRITE_FAILED' });
      assert.throws(() => f.registry.status(), { code: 'SECURITY_CLOSED' }); f.reopen();
      assert.equal(f.registry.registrationStorageStatus().ledgerVersion, point === 'staged' ? 1 : 3);
      assert.equal(f.registry.auditEvents().filter(e => e.action === 'session.storage.migrate').length, point === 'staged' ? 0 : 1);
      f.registry.authenticate(token.token); f.registry.verifySession(session.session);
      assert.deepEqual(readFileSync(join(f.dir, 'instance.key')), key);
    } finally { f.close(); }
  });
}

test('protection and audit failures never report a successful migration', () => {
  const f = fixture();
  try {
    const before = readFileSync(join(f.dir, 'registry.mds')); f.setFailure(true);
    assert.throws(() => migrate(f), { code: 'SECURITY_STORE_WRITE_FAILED' });
    assert.deepEqual(readFileSync(join(f.dir, 'registry.mds')), before);
    f.setFailure(false); f.reopen({ auditLimit: 1 });
    assert.throws(() => migrate(f), { code: 'SECURITY_AUDIT_CAPACITY' });
    assert.deepEqual(readFileSync(join(f.dir, 'registry.mds')), before);
  } finally { f.close(); }
});

test('V3 registration runtime still opens/closes its window, admits pending requests and expires them', async () => {
  const f = fixture();
  let service: RegistrationService | undefined;
  try {
    migrate(f);
    service = new RegistrationService(f.registry, { descriptor: {
      format: 'modeldb.device-registration-connection.v1', version: 1, instanceId: f.instance,
      serverOrigin: 'https://modeldb-a.example.test', rpId: 'modeldb-a.example.test', registrationMode: 'enabled',
      issuedAtUtc: utc(start), expiresAtUtc: utc(start + 86400000), deploymentDescriptorSha256: 'a'.repeat(64), tls: { mode: 'public-ca', minVersion: 'TLS1.2' },
    } }, { publicBaseUrl: 'https://modeldb-a.example.test', mode: 'proxy' }, () => start);
    const context = { source: { peerIp: '127.0.0.1', clientIp: '127.0.0.1', clientIpBasis: 'socket' as const, secure: true }, requestId: randomUUID(), recheck() {} };
    const begin = await service.begin({ format: 'modeldb.device-registration.v1', version: 1, instanceId: f.instance, deploymentDescriptorSha256: 'a'.repeat(64), displayName: 'Synthetic V3', userVerification: 'required' }, context);
    const status = { format: 'modeldb.device-registration.v1', version: 1, instanceId: f.instance, registrationId: begin.registrationId, continuationSecret: begin.continuationSecret };
    assert.equal(service.status(status, context).state, 'pending'); service.close();
    f.setTime(start + 86400001); f.reopen(); service = new RegistrationService(f.registry, undefined, undefined, () => start + 86400001);
    assert.equal(f.registry.registrationStorageStatus().ledgerVersion, 3);
    assert.equal(f.registry.registrationStorageStatus().mode, 'disabled');
    assert.equal(f.registry.readRegistrationStorage().applications[0]!.state, 'expired');
    assert.throws(() => service!.status(status, context), { code: 'SECURITY_REGISTRATION_NOT_FOUND' });
    assert.equal(f.registry.readRegistrationStorage().applications.length, 0);
    assert.equal(f.registry.listCredentials().length, 0); assert.equal(f.registry.status().sessions, 0);
  } finally { service?.close(); f.close(); }
});

test('native Windows protection preserves API and management sessions through V3 migration and reset', () => {
  assert.equal(process.platform, 'win32');
  const dir = join(mkdtempSync(join(tmpdir(), 'ModeDB-Native-Session-Parent-')), 'security');
  let registry = SecurityRegistry.open(dir);
  try {
    const principal = registry.createPrincipal('Synthetic native application');
    const token = registry.createCredential(principal.id, 'Synthetic native API', []);
    const session = registry.createSession(token.token);
    const admin = registry.consumePairing(registry.createLocalBrowserPairing(origin, [], true).code, origin);
    const key = readFileSync(join(dir, 'instance.key'));
    registry.migrateSessionStorage(registry.status().revision); registry.close(); registry = SecurityRegistry.open(dir);
    assert.equal(registry.verifySession(session.session).sessionParent?.kind, 'api-credential');
    assert.equal(registry.verifyBrowserSession(admin.session, origin).securityAdmin, true);
    registry.resetAccess(); registry.close(); registry = SecurityRegistry.open(dir);
    assert.throws(() => registry.verifySession(admin.session), { code: 'SECURITY_CREDENTIAL_REVOKED' });
    assert.throws(() => registry.authenticate(token.token), { code: 'SECURITY_CREDENTIAL_REVOKED' });
    assert.deepEqual(readFileSync(join(dir, 'instance.key')), key);
  } finally { registry.close(); }
});

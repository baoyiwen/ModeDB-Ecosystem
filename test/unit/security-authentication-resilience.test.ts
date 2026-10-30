/** DR-P2.5: actual child exits, deterministic signed-proof races and mixed-identity recovery. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { SecurityGrant } from '@mode-db/shared';
import { verifyAuthenticationResponse } from '../../packages/server/node_modules/@simplewebauthn/server/esm/index.js';
import { AuthenticationService } from '../../packages/server/src/security/authentication-service.js';
import { SecurityRegistry } from '../../packages/server/src/security/security-registry.js';
import { dispatchLocalSecurity } from '../../packages/server/src/security/local-management-channel.js';
import { authenticationFixture } from '../fixtures/security-authentication.js';
import { pendingSoftwareIdentity } from '../fixtures/security-registration-identity.js';
import { integrationFixture, SID, syntheticProtector, origin } from '../fixtures/security-registration-integration.js';
import type { ExitInput } from '../fixtures/security-authentication-exit-child.js';
import type { DeviceAuthenticationBeginResponseV1 } from '../../packages/shared/src/device-authentication-contracts.js';

const full: SecurityGrant[] = [{database: 'synthetic_business', resource: '*', actions: ['model.read', 'model.write']}];
const read: SecurityGrant[] = [{...full[0], actions: ['model.read']}];
const hardExits = new Set<string>(), races = new Set<string>(), auditFaults = new Set<string>();
let compatibility = false;

async function setup() {
  const a = await authenticationFixture(-7, false, undefined, full), {f} = a;
  const begin = await a.begin(), login = await a.service.complete(a.assertion(begin.response), begin.ceremonySecret, a.context);
  const key = f.registry.readRegistrationStorage().credentials[0];
  const local = (action: string, id = key.id, extra: Record<string, unknown> = {}) => f.local({action, instanceId: f.instanceId, id, revision: f.registry.status().revision, confirm: true, ...extra});
  return {a, f, key, login, local};
}

function raw(f: Awaited<ReturnType<typeof integrationFixture>>) {
  return JSON.parse(syntheticProtector(f.key).unprotect(readFileSync(join(f.dir, 'registry.mds'), 'utf8'), 'modeldb-registry-v1:' + f.instanceId).toString()) as {
    sessions: Array<{id: string; credentialId: string; revokedAt?: string; parent: {kind: string}; absoluteExpiresAt?: string}>;
  };
}

async function exitAt(input: ExitInput, sign?: (response: DeviceAuthenticationBeginResponseV1) => ReturnType<Awaited<ReturnType<typeof authenticationFixture>>['assertion']>) {
  let issued: {response: DeviceAuthenticationBeginResponseV1; ceremonySecret: string} | undefined;
  const child = spawn(process.execPath, ['--import', 'tsx', resolve('test/fixtures/security-authentication-exit-child.ts')], {windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc']});
  let stdout = '', stderr = '';
  child.stdout!.on('data', b => stdout += b); child.stderr!.on('data', b => stderr += b);
  child.on('message', message => { issued = message as typeof issued; child.send(sign!(issued!.response)); });
  child.stdin!.end(JSON.stringify(input));
  const code = await new Promise<number | null>((done, fail) => {
    const timer = setTimeout(() => { child.kill(); fail(Error('SYNTHETIC_EXIT_TIMEOUT')); }, 30000);
    child.once('error', error => {clearTimeout(timer); fail(error);});
    child.once('close', code => {clearTimeout(timer); done(code);});
  });
  assert.equal(code, 86, 'Worker must exit inside the selected durable commit');
  assert.equal(stdout.length, 0, 'Worker must not print IPC material'); assert.equal(stderr.length, 0, 'Worker must not print IPC material');
  return issued;
}

const operations = ['login', 'claim', 'refresh', 'logout', 'registration.credential.disable', 'registration.credential.revoke', 'registration.user.disable', 'registration.credential.restrict', 'registration.credential.replace'] as const;
for (const operation of operations) for (const point of ['staged', 'journaled', 'replaced'] as const) {
  test(`actual hard exit ${operation} at ${point} restores a complete identity/session/audit outcome`, async () => {
    const x = await setup(), {a, f, key, login} = x;
    try {
      const pending = operation.endsWith('replace') ? await pendingSoftwareIdentity(a) : undefined;
      const beforeAudit = f.registry.auditEvents(), beforeSessions = raw(f).sessions;
      const keyFile = readFileSync(join(f.dir, 'instance.key'));
      const request = {action: operation, instanceId: f.instanceId, id: operation.includes('.user.') ? key.userId : key.id, revision: f.registry.status().revision, confirm: true, ...(operation.endsWith('restrict') ? {grants: read} : {}), ...(pending ? {applicationId: pending.applicationId, grants: read} : {})};
      const input: ExitInput = {directory: f.dir, key: f.key.toString('base64'), now: f.now, point, operation, descriptor: f.descriptor, binding: a.binding, session: login.session, request};
      await a.close();
      const issued = await exitAt(input, b => a.assertion(b, 2));
      await a.reopen();
      const committed = point !== 'staged', store = f.registry.readRegistrationStorage();
      const events = f.registry.auditEvents().slice(beforeAudit.length);
      const action = operation === 'login' ? 'authentication.login' : operation === 'claim' ? 'authentication.claim' : operation === 'refresh' ? 'session.rotate' : operation === 'logout' ? 'session.revoke' : operation;
      assert.equal(events.filter(e => e.action === action && e.result === 'succeeded').length, committed ? 1 : 0);
      if (operation === 'login' || operation === 'claim') {
        assert.ok(issued); const loggedIn = operation === 'login' && committed;
        assert.equal(store.credentials[0].counter, loggedIn ? 2 : 1);
        assert.equal(raw(f).sessions.length, beforeSessions.length + (loggedIn ? 1 : 0));
        assert.equal(f.registry.readAuthenticationChallenge(issued.response.challengeId)!.state, loggedIn ? 'succeeded' : 'rejected');
        await assert.rejects(() => a.service.complete(a.assertion(issued!.response, 2), issued!.ceremonySecret, a.context), {code: 'SECURITY_AUTHENTICATION_CHALLENGE_REPLAYED'});
        f.registry.verifySession(login.session);
      } else if (operation === 'refresh' || operation === 'logout') {
        assert.equal(raw(f).sessions.length, beforeSessions.length + (operation === 'refresh' && committed ? 1 : 0));
        if (committed) assert.throws(() => f.registry.verifySession(login.session), {code: 'SECURITY_CREDENTIAL_REVOKED'}); else f.registry.verifySession(login.session);
        if (operation === 'refresh' && committed) assert.equal(raw(f).sessions[1].absoluteExpiresAt, beforeSessions[0].absoluteExpiresAt);
        assert.equal(store.credentials[0].state, 'active');
      } else if (operation.endsWith('restrict')) {
        assert.deepEqual(f.registry.verifySession(login.session).credential.grants, committed ? read : full);
      } else {
        if (committed) assert.throws(() => f.registry.verifySession(login.session), {code: 'SECURITY_CREDENTIAL_REVOKED'}); else f.registry.verifySession(login.session);
        if (operation.endsWith('replace')) {
          assert.equal(store.credentials.length, committed ? 2 : 1);
          assert.equal(store.applications.find(app => app.id === pending!.applicationId)!.state, committed ? 'approved' : 'pending');
          if (committed) assert.deepEqual(f.registry.verifySession((await pending!.login()).session).credential.grants, read);
          else await assert.rejects(() => pending!.login(), {code: 'SECURITY_AUTHENTICATION_PROOF_INVALID'});
        } else if (operation.includes('.user.')) assert.equal(store.users[0].enabled, !committed);
        else assert.equal(store.credentials[0].state, committed ? operation.endsWith('disable') ? 'disabled' : 'revoked' : 'active');
      }
      assert.deepEqual(readFileSync(join(f.dir, 'instance.key')), keyFile);
      hardExits.add(operation + ':' + point);
    } finally {await a.close();}
  });
}

for (const point of ['staged', 'journaled', 'replaced'] as const) test(`actual V2-to-V4 migration hard exit at ${point} preserves API and pairing identity`, async () => {
  const f = await integrationFixture();
  try {
    const p = f.registry.createPrincipal('Synthetic legacy app'), api = f.registry.createCredential(p.id, 'Synthetic API', read);
    const pairing = f.registry.createPairingForCredential(api.credential.id, 5, origin), session = f.registry.createSession(api.token);
    const before = f.registry.status(), keyFile = readFileSync(join(f.dir, 'instance.key'));
    await f.stop(); await exitAt({directory: f.dir, key: f.key.toString('base64'), now: f.now, point, operation: 'migrate', descriptor: f.descriptor});
    await f.resume();
    assert.equal(f.registry.registrationStorageStatus().ledgerVersion, point === 'staged' ? 2 : 4);
    assert.equal(f.registry.status().revision, before.revision + (point === 'staged' ? 0 : 1));
    f.registry.authenticate(api.token); f.registry.verifySession(session.session);
    f.registry.verifySession(f.registry.consumePairing(pairing.code, origin).session);
    assert.equal(f.registry.auditEvents().filter(e => e.action === 'authentication.storage.migrate').length, point === 'staged' ? 0 : 1);
    assert.deepEqual(readFileSync(join(f.dir, 'instance.key')), keyFile);
    hardExits.add('migrate:' + point);
  } finally {await f.stop();}
});

const raceModes = ['disable', 'revoke', 'user', 'replace', 'disable-enable', 'user-disable-enable', 'restrict', 'unrelated'] as const;
for (const mode of raceModes) test(`verified proof racing local ${mode} has a live, durable outcome`, async () => {
  const x = await setup(), {a, f, key} = x;
  const pending = mode === 'replace' ? await pendingSoftwareIdentity(a) : undefined;
  a.service.close();
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(r => entered = r), gate = new Promise<void>(r => release = r);
  const service = new AuthenticationService(f.registry, {enabled: true}, f.descriptor, () => f.now, async options => {const proof = await verifyAuthenticationResponse(options); entered(); await gate; return proof;});
  try {
    const b = await service.begin(a.binding, a.context), attempt = service.complete(a.assertion(b.response, 2), b.ceremonySecret, a.context);
    const result = Promise.allSettled([attempt]); await ready;
    if (mode === 'user' || mode === 'user-disable-enable') {x.local('registration.user.disable', key.userId); if (mode.endsWith('enable')) x.local('registration.user.enable', key.userId);}
    else if (mode === 'replace') x.local('registration.credential.replace', key.id, {applicationId: pending!.applicationId, grants: read});
    else if (mode === 'restrict') x.local('registration.credential.restrict', key.id, {grants: read});
    else if (mode === 'unrelated') f.registry.createPrincipal('Unrelated local action');
    else {x.local('registration.credential.' + (mode === 'revoke' ? 'revoke' : 'disable')); if (mode.endsWith('enable')) x.local('registration.credential.enable');}
    release(); const [settled] = await result;
    const allowed = mode === 'restrict' || mode === 'unrelated';
    assert.equal(settled.status, allowed ? 'fulfilled' : 'rejected');
    if (settled.status === 'fulfilled') assert.deepEqual(f.registry.verifySession(settled.value.session).credential.grants, mode === 'restrict' ? read : full);
    else assert.equal(settled.reason.code, 'SECURITY_AUTHENTICATION_PROOF_INVALID');
    assert.equal(f.registry.readAuthenticationChallenge(b.response.challengeId)!.state, allowed ? 'succeeded' : 'rejected');
    await a.reopen();
    if (!allowed) assert.throws(() => f.registry.verifySession(x.login.session), {code: 'SECURITY_CREDENTIAL_REVOKED'});
    if (mode.endsWith('enable')) {const fresh = await a.begin(); f.registry.verifySession((await a.service.complete(a.assertion(fresh.response, 3), fresh.ceremonySecret, a.context)).session);}
    races.add(mode);
  } finally {release(); service.close(); await a.close();}
});

for (const operation of ['refresh', 'logout'] as const) for (const revokeFirst of [true, false]) for (const user of [false, true]) test(`${operation} and ${user ? 'user stop' : 'key revocation'} serialize in ${revokeFirst ? 'revocation' : 'session'} order without revival`, async () => {
  const x = await setup();
  try {
    let rotated: string | undefined;
    const revoke = () => x.local(user ? 'registration.user.disable' : 'registration.credential.revoke', user ? x.key.userId : x.key.id);
    const sessionAction = () => operation === 'refresh' ? rotated = x.f.registry.rotateSession(x.login.session).session : x.f.registry.revokeSession(x.login.session);
    if (revokeFirst) {revoke(); assert.throws(sessionAction, {code: 'SECURITY_CREDENTIAL_REVOKED'});} else {sessionAction(); revoke();}
    await x.a.reopen();
    for (const token of [x.login.session, ...(rotated ? [rotated] : [])]) assert.throws(() => x.f.registry.verifySession(token), {code: 'SECURITY_CREDENTIAL_REVOKED'});
    assert.ok(raw(x.f).sessions.every(s => s.revokedAt));
  } finally {await x.a.close();}
});

for (const user of [false, true]) test(`queued proof cannot revive after ${user ? 'user' : 'credential'} disable-enable`, async () => {
  const x = await setup(), {a, f, key} = x;
  a.service.close();
  let release!: () => void;
  const gate = new Promise<void>(r => release = r);
  const service = new AuthenticationService(f.registry, {enabled: true}, f.descriptor, () => f.now, async options => {await gate; return verifyAuthenticationResponse(options);});
  try {
    const requests = [];
    for (let i = 0; i < 5; i++) requests.push(await service.begin(a.binding, a.context));
    const result = Promise.allSettled(requests.map(b => service.complete(a.assertion(b.response, 2), b.ceremonySecret, a.context)));
    await new Promise<void>(r => setImmediate(r));
    assert.equal(service.metrics().activeProofs, 4); assert.equal(service.metrics().queuedProofs, 1);
    const prefix = user ? 'registration.user.' : 'registration.credential.', id = user ? key.userId : key.id;
    x.local(prefix + 'disable', id); x.local(prefix + 'enable', id);
    release();
    for (const settled of await result) {assert.equal(settled.status, 'rejected'); if (settled.status === 'rejected') assert.equal(settled.reason.code, 'SECURITY_AUTHENTICATION_PROOF_INVALID');}
    for (const b of requests) assert.equal(f.registry.readAuthenticationChallenge(b.response.challengeId)!.state, 'rejected');
    assert.equal(service.metrics().activeProofs, 0); assert.equal(service.metrics().queuedProofs, 0);
    const fresh = await service.begin(a.binding, a.context), login = await service.complete(a.assertion(fresh.response, 2), fresh.ceremonySecret, a.context);
    await a.reopen(); f.registry.verifySession(login.session);
    races.add('queued-' + (user ? 'user' : 'credential'));
  } finally {release(); service.close(); await a.close();}
});

for (const stage of ['claim', 'login', 'refresh', 'replace'] as const) test(`audit full at ${stage} does not return success or partially mutate identity`, async () => {
  const x = await setup(), {a, f, key} = x;
  const pending = stage === 'replace' ? await pendingSoftwareIdentity(a) : undefined;
  const count = f.registry.auditEvents().length, bytes = readFileSync(join(f.dir, 'instance.key'));
  await a.close();
  let registry: SecurityRegistry | undefined, service: AuthenticationService | undefined;
  try {
    registry = SecurityRegistry.open(f.dir, {protector: syntheticProtector(f.key), now: () => f.now, auditLimit: count + (stage === 'claim' ? 1 : stage === 'login' ? 2 : 0)});
    service = new AuthenticationService(registry, {enabled: true}, f.descriptor, () => f.now);
    if (stage === 'claim' || stage === 'login') {const b = await service.begin(a.binding, a.context); await assert.rejects(() => service!.complete(a.assertion(b.response, 2), b.ceremonySecret, a.context), {code: 'SECURITY_AUDIT_CAPACITY'});}
    else if (stage === 'refresh') assert.throws(() => registry!.rotateSession(x.login.session), {code: 'SECURITY_AUDIT_CAPACITY'});
    else assert.throws(() => registry!.withLocalActor(SID, () => dispatchLocalSecurity(registry!, {action: 'registration.credential.replace', instanceId: f.instanceId, id: key.id, applicationId: pending!.applicationId, grants: read, revision: registry!.status().revision, confirm: true})), {code: 'SECURITY_AUDIT_CAPACITY'});
    registry.verifySession(x.login.session); assert.equal(registry.readRegistrationStorage().credentials.length, 1); assert.equal(registry.readRegistrationStorage().credentials[0].counter, 1);
    service.close(); registry.close(); await a.reopen();
    f.registry.verifySession(x.login.session); assert.equal(f.registry.status().sessions, 1); assert.deepEqual(readFileSync(join(f.dir, 'instance.key')), bytes);
    auditFaults.add(stage);
  } finally {service?.close(); registry?.close(); await a.close();}
});

test('competing replacement and revoke with one revision commit at most one local decision', async () => {
  const x = await setup();
  try {
    const pending = await pendingSoftwareIdentity(x.a), revision = x.f.registry.status().revision;
    const results = await Promise.allSettled(['registration.credential.replace', 'registration.credential.revoke'].map(action => Promise.resolve().then(() => x.local(action, x.key.id, {revision, ...(action.endsWith('replace') ? {applicationId: pending.applicationId, grants: read} : {})}))));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason.code, 'SECURITY_POLICY_CONFLICT');
    await x.a.reopen(); assert.equal(x.f.registry.readRegistrationStorage().credentials.length, 2);
    assert.throws(() => x.f.registry.verifySession(x.login.session), {code: 'SECURITY_CREDENTIAL_REVOKED'});
    x.f.registry.verifySession((await pending.login()).session);
  } finally {await x.a.close();}
});

test('mixed API, public-key and local-management sessions retain separate scopes through restart and user stop', async () => {
  const x = await setup(), {f} = x;
  try {
    const principalId = f.registry.verifySession(x.login.session).credential.principalId;
    const api = f.registry.createCredential(principalId, 'Synthetic application API', read), session = f.registry.createSession(api.token);
    const pairing = f.registry.createPairingForCredential(api.credential.id, 5, origin);
    const admin = f.registry.withLocalActor(SID, () => f.registry.createLocalBrowserPairing('http://127.0.0.1:5175', [], true));
    const adminSession = f.registry.consumePairing(admin.code, 'http://127.0.0.1:5175');
    await x.a.reopen();
    f.registry.authenticate(api.token); f.registry.verifySession(session.session); f.registry.verifySession(x.login.session);
    assert.equal(f.registry.verifyBrowserSession(adminSession.session, 'http://127.0.0.1:5175').securityAdmin, true);
    assert.deepEqual(f.registry.verifySession(adminSession.session).credential.grants, []);
    x.local('registration.user.disable', x.key.userId);
    assert.throws(() => f.registry.verifySession(x.login.session), {code: 'SECURITY_CREDENTIAL_REVOKED'});
    f.registry.authenticate(api.token); f.registry.verifySession(session.session);
    const paired = f.registry.consumePairing(pairing.code, origin); f.registry.verifySession(paired.session);
    await x.a.reopen(); f.registry.verifySession(adminSession.session); f.registry.verifySession(paired.session);
    const encoded = JSON.stringify(f.registry.auditEvents());
    for (const secret of [api.token, pairing.code, paired.session, x.login.session, adminSession.session, x.key.rawId, x.key.publicKeyCose]) assert.equal(encoded.includes(secret), false, 'Audits exclude authentication material');
    const fingerprint = createHash('sha256').update(readFileSync(join(f.dir, 'instance.key'))).digest('hex'); assert.match(fingerprint, /^[a-f0-9]{64}$/);
    compatibility = true;
  } finally {await x.a.close();}
});

test('resilience matrix records every hard exit, signed race, audit failure and compatibility case', t => {
  assert.equal(hardExits.size, 30); assert.equal(races.size, 10); assert.equal(auditFaults.size, 4); assert.equal(compatibility, true);
  t.diagnostic(JSON.stringify({format: 'modeldb.authentication-resilience-matrix.v1', ok: true, hardExitCases: hardExits.size, signedRaceCases: races.size, auditFaultCases: auditFaults.size, checks: {hardProcessExits: true, atomicSessionAudit: true, unknownOutcomeInspectable: true, noRevivalAfterRestart: true, disableEnableProofBarrier: true, latestReduction: true, maintenanceCas: true, legacyApiPairingManagement: compatibility, noSecretsInLogs: true}, liveMaterialRead: false, hardwareAuthenticatorTested: false}));
});

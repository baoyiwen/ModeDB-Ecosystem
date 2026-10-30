import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEVICE_REGISTRATION_CAPACITY_V1,
  DEVICE_REGISTRATION_FORMAT,
  DeviceRegistrationContractError,
  assertDeviceRegistrationAuditEvent,
  assertDeviceRegistrationCapacity,
  assertDeviceRegistrationCompleteRequest,
  assertDeviceRegistrationConnectionDescriptor,
  assertDeviceRegistrationInstanceBinding,
  assertDeviceRegistrationBeginRequest,
  assertDeviceRegistrationBeginResponse,
  assertDeviceRegistrationCapabilities,
  assertDeviceRegistrationDescriptorBinding,
  assertDeviceRegistrationStatusRequest,
  assertDeviceRegistrationStatusResponse,
  assertDeviceRegistrationTransition,
  canTransitionDeviceRegistrationApplication,
  canTransitionDeviceRegistrationChallenge,
  canTransitionDeviceRegistrationCredential,
  isDeviceRegistrationInstanceId,
} from '../../packages/shared/src/device-registration-contracts.js';

const instanceId = '3f1d6f1f-b6c8-4b6a-9d72-6c9b4d5c7e10';
const descriptor = () => ({
  format: 'modeldb.device-registration-connection.v1',
  version: 1,
  instanceId,
  serverOrigin: 'https://modeldb-a.example.test',
  rpId: 'modeldb-a.example.test',
  registrationMode: 'planned',
  issuedAtUtc: '2026-10-26T00:00:00.000Z',
  expiresAtUtc: '2026-10-27T00:00:00.000Z',
  deploymentDescriptorSha256: 'a'.repeat(64),
  tls: { mode: 'public-ca' as 'public-ca' | 'owner-pinned', minVersion: 'TLS1.2' as const },
});

const begin = () => ({
  format: DEVICE_REGISTRATION_FORMAT,
  version: 1,
  instanceId,
  deploymentDescriptorSha256: 'a'.repeat(64),
  displayName: 'B workstation',
  userVerification: 'required',
});

test('accepts the public descriptor and exact capacity contract', () => {
  assert.doesNotThrow(() => assertDeviceRegistrationConnectionDescriptor(descriptor()));
  assert.doesNotThrow(() => assertDeviceRegistrationCapacity(DEVICE_REGISTRATION_CAPACITY_V1));
  assert.equal(DEVICE_REGISTRATION_CAPACITY_V1.challengeBytes, 32);
  assert.equal(DEVICE_REGISTRATION_CAPACITY_V1.maxPendingApplications, 1000);
});

test('rejects descriptor trust-boundary drift and secrets', () => {
  for (const mutate of [
    (value: ReturnType<typeof descriptor>) => { value.serverOrigin = 'http://modeldb-a.example.test'; },
    (value: ReturnType<typeof descriptor>) => { value.serverOrigin = 'https://192.0.2.10'; value.rpId = '192.0.2.10'; },
    (value: ReturnType<typeof descriptor>) => { value.serverOrigin = 'https://node.localhost'; value.rpId = 'node.localhost'; },
    (value: ReturnType<typeof descriptor>) => { value.rpId = 'other.example.test'; },
    (value: ReturnType<typeof descriptor>) => { value.expiresAtUtc = value.issuedAtUtc; },
    (value: ReturnType<typeof descriptor>) => { (value as Record<string, unknown>).token = 'secret'; },
    (value: ReturnType<typeof descriptor>) => { value.tls = { mode: 'owner-pinned', minVersion: 'TLS1.2' }; },
  ]) {
    const value = descriptor();
    mutate(value);
    assert.throws(() => assertDeviceRegistrationConnectionDescriptor(value));
  }
});

test('enforces request size, protocol and encoded payload limits', () => {
  assert.doesNotThrow(() => assertDeviceRegistrationBeginRequest(begin()));
  assert.throws(() => assertDeviceRegistrationBeginRequest({ ...begin(), userVerification: 'preferred' }));
  assert.throws(() => assertDeviceRegistrationBeginRequest({ ...begin(), displayName: 'x'.repeat(81) }));
  assert.throws(() => assertDeviceRegistrationBeginRequest({ ...begin(), instanceId: 'other' }));
  assert.equal(isDeviceRegistrationInstanceId(instanceId + '\n'), false);
  assert.throws(() => assertDeviceRegistrationBeginRequest({ ...begin(), instanceId: instanceId + '\n' }));
  assert.throws(() => assertDeviceRegistrationBeginRequest({ ...begin(), deploymentDescriptorSha256: 'a'.repeat(64) + '\n' }));
  const complete = {
    format: DEVICE_REGISTRATION_FORMAT,
    version: 1,
    registrationId: 'registration-1',
    challengeId: 'challenge-1',
    instanceId,
    deploymentDescriptorSha256: 'a'.repeat(64),
    continuationSecret: Buffer.alloc(32).toString('base64url'),
    credential: {
      id: 'AA', rawId: 'AA', type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: Buffer.alloc(16384).toString('base64url'),
        attestationObject: Buffer.alloc(65536).toString('base64url'), transports: ['internal'] },
    },
  } as const;
  assert.doesNotThrow(() => assertDeviceRegistrationCompleteRequest(complete));
  for (const response of [
    { ...complete.credential.response, clientDataJSON: Buffer.alloc(16385).toString('base64url') },
    { ...complete.credential.response, attestationObject: Buffer.alloc(65537).toString('base64url') },
    ...['A+', 'A', 'AB', 'AAB', 'AA=='].map(attestationObject => ({ ...complete.credential.response, attestationObject })),
  ]) {
    assert.throws(() => assertDeviceRegistrationCompleteRequest({ ...complete, credential: { ...complete.credential, response } }), { code: 'SECURITY_REGISTRATION_SCHEMA_INVALID' });
  }
  assert.throws(() => assertDeviceRegistrationCompleteRequest({ ...complete, credential: { ...complete.credential, rawId: 'AQ' } }));
  assert.throws(() => assertDeviceRegistrationCompleteRequest({ ...complete, continuationSecret: 'AA' }));
  assert.throws(() => assertDeviceRegistrationCompleteRequest({ ...complete, credential: { ...complete.credential, id: 'AAA\n', rawId: 'AAA\n' } }));
});

test('requires trusted instance binding and explicit state transitions', () => {
  assert.equal(assertDeviceRegistrationInstanceBinding(instanceId, instanceId), true);
  assert.throws(() => assertDeviceRegistrationInstanceBinding(instanceId, '8b0c8c6c-8f3c-4a30-9d8e-18be6e6f4c02'), {
    code: 'SECURITY_REGISTRATION_INSTANCE_MISMATCH',
  });
  assert.equal(canTransitionDeviceRegistrationApplication('pending', 'approved'), true);
  assert.equal(canTransitionDeviceRegistrationApplication('approved', 'pending'), false);
  assert.equal(canTransitionDeviceRegistrationCredential('active', 'disabled'), true);
  assert.equal(canTransitionDeviceRegistrationCredential('revoked', 'active'), false);
  assert.equal(canTransitionDeviceRegistrationChallenge('issued', 'consumed'), true);
  assert.equal(canTransitionDeviceRegistrationChallenge('consumed', 'expired'), false);
  assert.equal(assertDeviceRegistrationTransition('application', 'pending', 'rejected'), true);
  assert.throws(() => assertDeviceRegistrationTransition('credential', 'revoked', 'active'), {
    code: 'SECURITY_REGISTRATION_CONFLICT',
  });
});

test('accepts metadata-only registration audit events and rejects sensitive or unknown fields', () => {
  const event = {
    format: DEVICE_REGISTRATION_FORMAT,
    version: 1,
    eventId: 'event-1',
    requestId: 'request-1',
    timestampUtc: '2026-10-26T00:00:00.000Z',
    action: 'registration.begin',
    result: 'succeeded',
    instanceId,
    registrationId: 'registration-1',
    actor: { kind: 'anonymous', identityTrust: 'unverified' },
    source: { transport: 'http', clientIp: '192.0.2.10', clientIpBasis: 'socket' },
    durationMs: 12,
    observedCount: 1,
  } as const;
  assert.doesNotThrow(() => assertDeviceRegistrationAuditEvent(event));
  assert.throws(() => assertDeviceRegistrationAuditEvent({ ...event, clientDataJson: 'secret' }));
  assert.throws(() => assertDeviceRegistrationAuditEvent({ ...event, reasonCode: 'UNKNOWN' }));
  assert.throws(() => assertDeviceRegistrationAuditEvent({ ...event, actor: { kind: 'operator', identityTrust: 'verified', principalId: 'admin', token: 'secret' } }));
  assert.throws(() => assertDeviceRegistrationAuditEvent({ ...event, observedCount: 0 }));
  assert.ok(DeviceRegistrationContractError);
});

test('binds downloaded descriptions to trusted deployment, TLS and validity', () => {
  const value = descriptor();
  const now = Date.parse('2026-10-26T12:00:00.000Z');
  assert.doesNotThrow(() => assertDeviceRegistrationDescriptorBinding(value, value, now));
  for (const nowMs of [Date.parse(value.issuedAtUtc) - 1, Date.parse(value.expiresAtUtc), NaN]) {
    assert.throws(() => assertDeviceRegistrationDescriptorBinding(value, value, nowMs));
  }
  assert.throws(() => assertDeviceRegistrationDescriptorBinding(value, { ...value, deploymentDescriptorSha256: 'b'.repeat(64) }, now));
  for (const patch of [
    { serverOrigin: 'https://MODELDB-A.example.test' },
    { serverOrigin: 'https://modeldb-a.example.test:443' },
    { serverOrigin: 'https://modeldb-a.example.test:999999' },
    { expiresAtUtc: '2026-10-28T00:00:00.000Z' },
    { issuedAtUtc: '2026-02-30T00:00:00.000Z' },
  ]) { assert.throws(() => assertDeviceRegistrationConnectionDescriptor({ ...value, ...patch }), DeviceRegistrationContractError); }
});

test('requires explicit capabilities and a separate 32-byte continuation secret for status', () => {
  const capability = { format: DEVICE_REGISTRATION_FORMAT, version: 1, instanceId,
    mode: 'disabled', protocolVersions: [1], proof: 'webauthn', userVerification: 'required',
    approval: 'local-operator', capacity: DEVICE_REGISTRATION_CAPACITY_V1 };
  assert.doesNotThrow(() => assertDeviceRegistrationCapabilities(capability));
  assert.throws(() => assertDeviceRegistrationCapabilities({ ...capability, protocolVersions: [2] }));
  assert.throws(() => assertDeviceRegistrationCapabilities({ ...capability, capacity: { ...DEVICE_REGISTRATION_CAPACITY_V1, maxPendingApplications: 1001 } }));
  assert.equal(Object.isFrozen(DEVICE_REGISTRATION_CAPACITY_V1), true);
  const request = { format: DEVICE_REGISTRATION_FORMAT, version: 1, instanceId, registrationId: 'registration-1', continuationSecret: Buffer.alloc(32).toString('base64url') };
  assert.doesNotThrow(() => assertDeviceRegistrationStatusRequest(request));
  const { continuationSecret: _secret, ...noSecret } = request;
  assert.throws(() => assertDeviceRegistrationStatusRequest(noSecret));
});

test('fails closed for unknown state kinds, prototype keys and audit attribution', () => {
  for (const kind of ['application', 'credential', 'challenge', 'unknown']) {
    for (const from of ['toString', '__proto__', 'constructor', 'missing']) {
      assert.throws(() => assertDeviceRegistrationTransition(kind as 'application', from, 'consumed'), { code: 'SECURITY_REGISTRATION_CONFLICT' });
    }
  }
  const audit = { format: DEVICE_REGISTRATION_FORMAT, version: 1, eventId: 'e', requestId: 'r',
    timestampUtc: '2026-10-26T00:00:00.000Z', action: 'registration.begin', result: 'succeeded', instanceId,
    actor: { kind: 'anonymous', identityTrust: 'unverified' }, source: { transport: 'http' }, durationMs: 0 };
  assert.doesNotThrow(() => assertDeviceRegistrationAuditEvent(audit));
  for (const patch of [
    { action: 'invented' }, { origin: 'http://modeldb-a.example.test' },
    { actor: { kind: 'anonymous', identityTrust: 'verified', principalId: 'admin' } },
    { source: { transport: 'http', clientIp: '999.1.1.1', clientIpBasis: 'socket' } },
    { source: { transport: 'http', clientIp: '192.0.2.10' } }, { durationMs: -1 },
  ]) { assert.throws(() => assertDeviceRegistrationAuditEvent({ ...audit, ...patch })); }
});

test('validates creation options with required UV, algorithms and ephemeral binding', () => {
  const bytes = Buffer.alloc(32).toString('base64url');
  const response = { format: DEVICE_REGISTRATION_FORMAT, version: 1, registrationId: 'r', challengeId: 'c',
    instanceId, deploymentDescriptorSha256: 'a'.repeat(64), continuationSecret: bytes,
    challengeExpiresAtUtc: '2026-10-26T00:01:00.000Z', publicKey: {
      rp: { id: 'modeldb-a.example.test', name: 'ModelDB' }, user: { id: bytes, name: 'r', displayName: 'B' },
      challenge: bytes, pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      timeout: 60000, attestation: 'none', authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    } };
  assert.doesNotThrow(() => assertDeviceRegistrationBeginResponse(response));
  for (const patch of [{ challenge: 'AA' }, { attestation: 'direct' }, { timeout: 120000 },
    { authenticatorSelection: { residentKey: 'preferred', userVerification: 'discouraged' } },
    { pubKeyCredParams: [{ type: 'public-key', alg: -7 }] }]) {
    assert.throws(() => assertDeviceRegistrationBeginResponse({ ...response, publicKey: { ...response.publicKey, ...patch } }));
  }
});

test('status exposes application metadata without granting a session or leaking principals', () => {
  const response = { format: DEVICE_REGISTRATION_FORMAT, version: 1, registrationId: 'r', instanceId,
    state: 'pending', createdAtUtc: '2026-10-26T00:00:00.000Z', expiresAtUtc: '2026-10-27T00:00:00.000Z' };
  assert.doesNotThrow(() => assertDeviceRegistrationStatusResponse(response));
  assert.doesNotThrow(() => assertDeviceRegistrationStatusResponse({ ...response, state: 'approved', approvedAtUtc: '2026-10-26T12:00:00.000Z' }));
  for (const patch of [{ state: 'approved' }, { state: 'rejected', rejectedAtUtc: response.expiresAtUtc },
    { principalId: 'other-person' }, { cookie: 'synthetic-secret' }, { approvedAtUtc: response.createdAtUtc }]) {
    assert.throws(() => assertDeviceRegistrationStatusResponse({ ...response, ...patch }));
  }
});

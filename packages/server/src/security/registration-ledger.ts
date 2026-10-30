/** Internal persistence schema. Admission, WebAuthn verification and operator authorization belong
 * to the service layer; these records alone never authenticate a request. No private keys/proofs. */
import { Buffer } from 'node:buffer';
import {
  DEVICE_REGISTRATION_CAPACITY_V1 as CAPACITY,
  DeviceRegistrationContractError,
  assertDeviceRegistrationBeginRequest,
  assertDeviceRegistrationConnectionDescriptor,
  assertDeviceRegistrationTransition,
  type DeviceRegistrationApplicationState,
  type DeviceRegistrationChallengeState,
  type DeviceRegistrationCredentialState,
  type SecurityGrant,
} from '@mode-db/shared';

export interface RegistrationBinding {
  instanceId: string;
  serverOrigin: string;
  rpId: string;
  deploymentDescriptorSha256: string;
}

/** Only an adapter that has successfully verified a WebAuthn response may construct this. */
export interface RegistrationPublicKey {
  rawId: string;
  publicKeyCose: string;
  algorithm: -7 | -257;
  counter: number;
  deviceType: 'singleDevice' | 'multiDevice';
  backedUp: boolean;
}

export interface RegistrationApplication extends RegistrationBinding {
  id: string;
  displayName: string;
  userHandle: string;
  continuationSecretHash: string;
  createdAtUtc: string;
  expiresAtUtc: string;
  state: DeviceRegistrationApplicationState;
  /** Present together only after the service has verified the public key proof. */
  verifiedAtUtc?: string;
  candidate?: RegistrationPublicKey;
  decidedAtUtc?: string;
  userId?: string;
  credentialId?: string;
}

export interface RegistrationChallenge {
  id: string;
  applicationId: string;
  purpose: 'registration';
  /** Only a digest is persisted; the random challenge is returned once by the future service. */
  challengeHash: string;
  createdAtUtc: string;
  expiresAtUtc: string;
  state: DeviceRegistrationChallengeState;
  finishedAtUtc?: string;
}

export interface RegistrationUser {
  id: string;
  /** Existing operator principal, never an asserted application user label. */
  principalId: string;
  displayName: string;
  enabled: boolean;
  createdAtUtc: string;
  updatedAtUtc: string;
}

export interface RegistrationCredential extends RegistrationPublicKey {
  /** Missing on pre-approval-service records means no grants. Never inherit Bearer privileges. */
  grants?: SecurityGrant[];
  id: string;
  applicationId: string;
  userId: string;
  state: DeviceRegistrationCredentialState;
  createdAtUtc: string;
  updatedAtUtc: string;
  disabledAtUtc?: string;
  revokedAtUtc?: string;
}

export interface RegistrationLedger {
  version: 1;
  /** A registration window still grants no business access. */
  mode: 'disabled' | 'enabled';
  applications: RegistrationApplication[];
  challenges: RegistrationChallenge[];
  users: RegistrationUser[];
  credentials: RegistrationCredential[];
}

export type RegistrationPrincipal = { id: string; kind: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ID = /^[A-Za-z0-9_-]{1,96}$/;
const invalid = (): never => {
  throw new DeviceRegistrationContractError('SECURITY_REGISTRATION_SCHEMA_INVALID');
};
function requireValue(condition: unknown): asserts condition {
  if (!condition) {
    invalid();
  }
}
function text(value: unknown, pattern: RegExp): string {
  requireValue(typeof value === 'string' && pattern.exec(value)?.[0] === value);
  return value;
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  requireValue(value && typeof value === 'object' && !Array.isArray(value));
  const obj = value as Record<string, unknown>;
  requireValue(Object.keys(obj).every((key) => keys.includes(key)));
  return obj;
}
function date(value: unknown): number {
  const s = text(value, DATE),
    ms = Date.parse(s);
  requireValue(Number.isFinite(ms) && new Date(ms).toISOString() === s);
  return ms;
}
function binary(value: unknown, max: number, exact?: number): void {
  const s = text(value, /^[A-Za-z0-9_-]+$/);
  requireValue(s.length <= Math.ceil((max * 4) / 3));
  const decoded = Buffer.from(s, 'base64url');
  requireValue(
    decoded.toString('base64url') === s &&
      decoded.length <= max &&
      (exact === undefined || decoded.length === exact),
  );
}
function records<T>(value: unknown, max: number): Map<string, T> {
  requireValue(Array.isArray(value));
  if (value.length > max) {
    throw new DeviceRegistrationContractError('SECURITY_REGISTRATION_CAPACITY');
  }
  const result = new Map<string, T>();
  for (const record of value) {
    requireValue(record && typeof record === 'object');
    const id = text(record.id, UUID);
    requireValue(!result.has(id));
    result.set(id, record as T);
  }
  return result;
}
function publicKey(value: unknown): void {
  const key = object(value, [
    'rawId',
    'publicKeyCose',
    'algorithm',
    'counter',
    'deviceType',
    'backedUp',
  ]);
  binary(key.rawId, CAPACITY.maxCredentialIdBytes);
  binary(key.publicKeyCose, 4096);
  requireValue(key.algorithm === -7 || key.algorithm === -257);
  requireValue(
    Number.isSafeInteger(key.counter) &&
      (key.counter as number) >= 0 &&
      (key.counter as number) <= 0xffffffff,
  );
  requireValue(
    ['singleDevice', 'multiDevice'].includes(key.deviceType as string) &&
      typeof key.backedUp === 'boolean',
  );
  requireValue(key.backedUp !== true || key.deviceType === 'multiDevice');
}
const KEY_FIELDS = [
  'rawId',
  'publicKeyCose',
  'algorithm',
  'counter',
  'deviceType',
  'backedUp',
] as const;
const pickKey = (key: RegistrationPublicKey): RegistrationPublicKey =>
  Object.fromEntries(
    KEY_FIELDS.map((field) => [field, key[field]]),
  ) as unknown as RegistrationPublicKey;

/** Strict, exact-database scopes for newly approved public-key credentials. */
export function normalizeRegistrationGrants(input: unknown): SecurityGrant[] {
  requireValue(Array.isArray(input) && input.length <= 100);
  const actions = [
    'model.read',
    'model.write',
    'schema.manage',
    'database.manage',
    'callable.query',
    'callable.operation',
    'callable.binding',
    'transfer.import',
    'transfer.export',
    'backup.manage',
  ];
  return input.map((value) => {
    const g = object(value, ['database', 'resource', 'actions', 'releaseDigest']);
    const database = text(g.database, ID),
      resource = text(g.resource, /^(?:\*|[A-Za-z0-9_-]{1,96})$/);
    requireValue(
      Array.isArray(g.actions) && g.actions.length > 0 && g.actions.length <= actions.length,
    );
    requireValue(g.actions.every((a) => typeof a === 'string' && actions.includes(a)));
    if (g.releaseDigest !== undefined) {
      text(g.releaseDigest, HASH);
    }
    if (g.actions.some((a) => a.startsWith('callable.'))) {
      requireValue(resource !== '*' && g.releaseDigest !== undefined);
    }
    return {
      database,
      resource,
      actions: [...new Set(g.actions)] as SecurityGrant['actions'],
      ...(g.releaseDigest === undefined ? {} : { releaseDigest: g.releaseDigest as string }),
    };
  });
}

export function emptyRegistrationLedger(): RegistrationLedger {
  return {
    version: 1,
    mode: 'disabled',
    applications: [],
    challenges: [],
    users: [],
    credentials: [],
  };
}

/** Validate all cross-record links and bounds before accepting a protected ledger. */
function validateRegistrationLedger(
  input: unknown,
  instanceId: string,
  principals: readonly RegistrationPrincipal[],
): asserts input is RegistrationLedger {
  const raw = object(input, [
    'version',
    'mode',
    'applications',
    'challenges',
    'users',
    'credentials',
  ]);
  requireValue(raw.version === 1 && ['disabled', 'enabled'].includes(raw.mode as string));
  if (Buffer.byteLength(JSON.stringify(raw)) > 16 * 1024 * 1024) {
    throw new DeviceRegistrationContractError('SECURITY_REGISTRATION_CAPACITY');
  }
  const apps = records<RegistrationApplication>(raw.applications, 11000);
  const challenges = records<RegistrationChallenge>(
    raw.challenges,
    CAPACITY.maxOutstandingChallenges,
  );
  const users = records<RegistrationUser>(raw.users, 10000);
  const credentials = records<RegistrationCredential>(
    raw.credentials,
    CAPACITY.maxCredentialsPerInstance,
  );
  const operatorIds = new Set(principals.filter((p) => p.kind === 'operator').map((p) => p.id));
  const allIds = [...apps.keys(), ...challenges.keys(), ...users.keys(), ...credentials.keys()];
  requireValue(new Set(allIds).size === allIds.length);
  const principalIds = new Set<string>(),
    handles = new Set<string>(),
    rawIds = new Set<string>();
  const perUser = new Map<string, number>();
  for (const user of users.values()) {
    object(user, ['id', 'principalId', 'displayName', 'enabled', 'createdAtUtc', 'updatedAtUtc']);
    text(user.principalId, ID);
    text(user.displayName, /^[^\u0000-\u001f\u007f]{1,80}$/);
    requireValue(operatorIds.has(user.principalId) && !principalIds.has(user.principalId));
    principalIds.add(user.principalId);
    requireValue(
      typeof user.enabled === 'boolean' && date(user.updatedAtUtc) >= date(user.createdAtUtc),
    );
  }
  let pending = 0;
  for (const app of apps.values()) {
    object(app, [
      'id',
      'instanceId',
      'serverOrigin',
      'rpId',
      'deploymentDescriptorSha256',
      'displayName',
      'userHandle',
      'continuationSecretHash',
      'createdAtUtc',
      'expiresAtUtc',
      'state',
      'verifiedAtUtc',
      'candidate',
      'decidedAtUtc',
      'userId',
      'credentialId',
    ]);
    requireValue(app.instanceId === instanceId);
    assertDeviceRegistrationBeginRequest({
      format: 'modeldb.device-registration.v1',
      version: 1,
      instanceId: app.instanceId,
      deploymentDescriptorSha256: app.deploymentDescriptorSha256,
      displayName: app.displayName,
      userVerification: 'required',
    });
    // Reuse the frozen public DNS/Origin/RP/date syntax; this does not establish TLS trust.
    assertDeviceRegistrationConnectionDescriptor({
      format: 'modeldb.device-registration-connection.v1',
      version: 1,
      instanceId: app.instanceId,
      serverOrigin: app.serverOrigin,
      rpId: app.rpId,
      registrationMode: 'disabled',
      issuedAtUtc: app.createdAtUtc,
      expiresAtUtc: app.expiresAtUtc,
      deploymentDescriptorSha256: app.deploymentDescriptorSha256,
      tls: { mode: 'public-ca', minVersion: 'TLS1.2' },
    });
    binary(app.userHandle, 32, 32);
    text(app.continuationSecretHash, HASH);
    requireValue(!handles.has(app.userHandle));
    handles.add(app.userHandle);
    const created = date(app.createdAtUtc),
      expires = date(app.expiresAtUtc);
    requireValue(expires > created && expires - created <= CAPACITY.applicationTtlSeconds * 1000);
    requireValue(['pending', 'approved', 'rejected', 'expired'].includes(app.state));
    requireValue((app.candidate !== undefined) === (app.verifiedAtUtc !== undefined));
    if (app.candidate) {
      publicKey(app.candidate);
      requireValue(date(app.verifiedAtUtc) >= created && date(app.verifiedAtUtc) < expires);
    }
    requireValue((app.state === 'pending') === (app.decidedAtUtc === undefined));
    if (app.decidedAtUtc !== undefined) {
      const decided = date(app.decidedAtUtc);
      requireValue(
        decided >= created && (app.state === 'expired' ? decided >= expires : decided < expires),
      );
    }
    requireValue(
      (app.state === 'approved') === (app.userId !== undefined && app.credentialId !== undefined),
    );
    if (app.state !== 'approved') {
      requireValue(app.userId === undefined && app.credentialId === undefined);
    }
    if (app.state === 'approved') {
      const credential = credentials.get(app.credentialId!);
      requireValue(
        app.candidate &&
          users.has(app.userId!) &&
          credential?.applicationId === app.id &&
          credential.userId === app.userId,
      );
      requireValue(app.verifiedAtUtc! <= app.decidedAtUtc!);
      requireValue(
        credential.rawId === app.candidate.rawId &&
          credential.publicKeyCose === app.candidate.publicKeyCose &&
          credential.algorithm === app.candidate.algorithm &&
          credential.deviceType === app.candidate.deviceType &&
          credential.counter >= app.candidate.counter,
      );
    } else if (app.candidate && app.state === 'pending') {
      requireValue(!rawIds.has(app.candidate.rawId));
      rawIds.add(app.candidate.rawId);
    }
    if (app.state === 'pending') {
      pending++;
    }
  }
  if (pending > CAPACITY.maxPendingApplications) {
    throw new DeviceRegistrationContractError('SECURITY_REGISTRATION_CAPACITY');
  }
  for (const credential of credentials.values()) {
    object(credential, [
      'id',
      'applicationId',
      'userId',
      ...KEY_FIELDS,
      'state',
      'createdAtUtc',
      'updatedAtUtc',
      'disabledAtUtc',
      'revokedAtUtc',
      'grants',
    ]);
    if (credential.grants !== undefined) {
      normalizeRegistrationGrants(credential.grants);
    }
    publicKey(pickKey(credential));
    const app = apps.get(credential.applicationId);
    requireValue(
      users.has(credential.userId) &&
        app?.state === 'approved' &&
        app.credentialId === credential.id,
    );
    requireValue(!rawIds.has(credential.rawId));
    rawIds.add(credential.rawId);
    const count = (perUser.get(credential.userId) ?? 0) + 1;
    perUser.set(credential.userId, count);
    if (count > CAPACITY.maxCredentialsPerPrincipal) {
      throw new DeviceRegistrationContractError('SECURITY_REGISTRATION_CAPACITY');
    }
    requireValue(['active', 'disabled', 'revoked'].includes(credential.state));
    const created = date(credential.createdAtUtc),
      updated = date(credential.updatedAtUtc);
    requireValue(updated >= created && created === date(app.decidedAtUtc));
    requireValue((credential.state === 'disabled') === (credential.disabledAtUtc !== undefined));
    requireValue((credential.state === 'revoked') === (credential.revokedAtUtc !== undefined));
    for (const at of [credential.disabledAtUtc, credential.revokedAtUtc]) {
      if (at !== undefined) {
        requireValue(date(at) === updated);
      }
    }
  }
  const appChallenges = new Set<string>();
  for (const challenge of challenges.values()) {
    object(challenge, [
      'id',
      'applicationId',
      'purpose',
      'challengeHash',
      'createdAtUtc',
      'expiresAtUtc',
      'state',
      'finishedAtUtc',
    ]);
    const app = apps.get(challenge.applicationId);
    requireValue(app && challenge.purpose === 'registration' && !appChallenges.has(app.id));
    appChallenges.add(app.id);
    text(challenge.challengeHash, HASH);
    const created = date(challenge.createdAtUtc),
      expires = date(challenge.expiresAtUtc);
    requireValue(
      created >= date(app.createdAtUtc) &&
        expires > created &&
        expires <= date(app.expiresAtUtc) &&
        expires - created <= CAPACITY.challengeTtlSeconds * 1000,
    );
    requireValue(['issued', 'consumed', 'expired', 'rejected'].includes(challenge.state));
    requireValue((challenge.state === 'issued') === (challenge.finishedAtUtc === undefined));
    if (challenge.finishedAtUtc !== undefined) {
      const finished = date(challenge.finishedAtUtc);
      requireValue(
        finished >= created &&
          (challenge.state === 'expired' ? finished >= expires : finished < expires),
      );
    }
    requireValue(
      challenge.state !== 'issued' || (app.state === 'pending' && app.candidate === undefined),
    );
  }
}

export function assertRegistrationLedger(
  input: unknown,
  instanceId: string,
  principals: readonly RegistrationPrincipal[],
): asserts input is RegistrationLedger {
  try {
    validateRegistrationLedger(input, instanceId, principals);
  } catch (error) {
    if (error instanceof DeviceRegistrationContractError) {
      throw error;
    }
    invalid();
  }
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
function immutable<T>(before: T, after: T, fields: readonly (keyof T)[]): void {
  requireValue(fields.every((field) => same(before[field], after[field])));
}

/** A storage transaction cannot resurrect terminal records or swap an established identity. */
export function assertRegistrationLedgerTransition(
  before: RegistrationLedger,
  after: RegistrationLedger,
  nowMs: number,
  restrictCredentialId?: string,
): void {
  requireValue(Number.isFinite(nowMs));
  const oldApps = new Set(before.applications.map((app) => app.id));
  const oldKeys = new Set(before.credentials.map((key) => key.id));
  const oldChallenges = new Set(before.challenges.map((challenge) => challenge.id));
  for (const app of after.applications) {
    requireValue(date(app.createdAtUtc) <= nowMs);
    if (!oldApps.has(app.id)) {
      requireValue(
        app.state === 'pending' && app.candidate === undefined && date(app.expiresAtUtc) > nowMs,
      );
    }
    for (const at of [app.verifiedAtUtc, app.decidedAtUtc]) {
      if (at !== undefined) {
        requireValue(date(at) <= nowMs);
      }
    }
  }
  for (const key of after.credentials) {
    requireValue(date(key.updatedAtUtc) <= nowMs);
    if (!oldKeys.has(key.id)) {
      requireValue(key.state === 'active');
    }
  }
  for (const user of after.users) {
    requireValue(date(user.updatedAtUtc) <= nowMs);
  }
  for (const challenge of after.challenges) {
    requireValue(date(challenge.createdAtUtc) <= nowMs);
    if (!oldChallenges.has(challenge.id)) {
      requireValue(challenge.state === 'issued' && date(challenge.expiresAtUtc) > nowMs);
    }
    if (challenge.finishedAtUtc !== undefined) {
      requireValue(date(challenge.finishedAtUtc) <= nowMs);
    }
  }
  const nextApps = new Map(after.applications.map((app) => [app.id, app]));
  const nextKeys = new Map(after.credentials.map((key) => [key.id, key]));
  const nextUsers = new Map(after.users.map((user) => [user.id, user]));
  const nextChallenges = new Map(after.challenges.map((challenge) => [challenge.id, challenge]));
  for (const app of before.applications) {
    const next = nextApps.get(app.id);
    if (!next) {
      requireValue(
        app.state !== 'pending' && app.state !== 'approved' && date(app.expiresAtUtc) <= nowMs,
      );
      continue;
    }
    immutable(app, next, [
      'id',
      'instanceId',
      'serverOrigin',
      'rpId',
      'deploymentDescriptorSha256',
      'displayName',
      'userHandle',
      'continuationSecretHash',
      'createdAtUtc',
      'expiresAtUtc',
    ]);
    if (app.state !== next.state) {
      assertDeviceRegistrationTransition('application', app.state, next.state);
    }
    if (app.candidate) {
      immutable(app, next, ['candidate', 'verifiedAtUtc']);
    }
    if (!app.candidate && next.candidate) {
      const consumed = after.challenges.find((challenge) => challenge.applicationId === app.id);
      requireValue(
        consumed?.state === 'consumed' &&
          date(consumed.expiresAtUtc) > nowMs &&
          date(consumed.finishedAtUtc) <= date(next.verifiedAtUtc),
      );
    }
    if (app.state !== 'pending') {
      requireValue(same(app, next));
    }
  }
  for (const key of before.credentials) {
    const next = nextKeys.get(key.id);
    requireValue(next);
    immutable(key, next, [
      'id',
      'applicationId',
      'userId',
      'rawId',
      'publicKeyCose',
      'algorithm',
      'deviceType',
      'createdAtUtc',
    ]);
    if (key.id === restrictCredentialId) {
      // The separate trusted restriction primitive can only remove existing capabilities.
      requireValue(
        (next.grants ?? []).every((grant) =>
          (key.grants ?? []).some(
            (old) =>
              old.database === grant.database &&
              old.resource === grant.resource &&
              old.releaseDigest === grant.releaseDigest &&
              grant.actions.every((action) => old.actions.includes(action)),
          ),
        ),
      );
    } else {
      immutable(key, next, ['grants']);
    }
    requireValue(next.counter >= key.counter && date(next.updatedAtUtc) >= date(key.updatedAtUtc));
    if (key.state !== next.state) {
      assertDeviceRegistrationTransition('credential', key.state, next.state);
    }
    if (key.state === 'revoked') {
      requireValue(same(key, next));
    }
  }
  for (const user of before.users) {
    const next = nextUsers.get(user.id);
    requireValue(next);
    immutable(user, next, ['id', 'principalId', 'createdAtUtc']);
    requireValue(date(next.updatedAtUtc) >= date(user.updatedAtUtc));
  }
  for (const challenge of before.challenges) {
    const next = nextChallenges.get(challenge.id);
    if (!next) {
      requireValue(date(challenge.expiresAtUtc) <= nowMs);
      continue;
    }
    immutable(challenge, next, [
      'id',
      'applicationId',
      'purpose',
      'challengeHash',
      'createdAtUtc',
      'expiresAtUtc',
    ]);
    if (challenge.state !== next.state) {
      assertDeviceRegistrationTransition('challenge', challenge.state, next.state);
    }
    if (challenge.state !== 'issued') {
      requireValue(same(challenge, next));
    }
  }
}

/** Access reset invalidates all registration identities too, without changing data keys. */
export function resetRegistrationAccess(ledger: RegistrationLedger, nowMs: number): void {
  ledger.mode = 'disabled';
  const at = new Date(nowMs).toISOString();
  for (const key of ledger.credentials) {
    if (key.state === 'revoked') {
      continue;
    }
    key.state = 'revoked';
    key.revokedAtUtc = at;
    key.updatedAtUtc = at;
    delete key.disabledAtUtc;
  }
  for (const app of ledger.applications) {
    if (app.state !== 'pending') {
      continue;
    }
    app.state = nowMs >= date(app.expiresAtUtc) ? 'expired' : 'rejected';
    app.decidedAtUtc = at;
  }
  for (const challenge of ledger.challenges) {
    if (challenge.state !== 'issued') {
      continue;
    }
    challenge.state = nowMs >= date(challenge.expiresAtUtc) ? 'expired' : 'rejected';
    challenge.finishedAtUtc = at;
  }
}

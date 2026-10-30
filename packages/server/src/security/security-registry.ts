import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import {
  acquireFileLeaseSync,
  assertFlatGraphSegment,
  fileDigest,
  isVaultKeyReference,
  readAtomicFileSync,
  writeAtomicFileSync,
  type AtomicCommitPoint,
  type VaultKeyReference,
} from '@mode-db/common';
import type {
  DataSecurityEvent,
  SecurityAuditPage,
  SecurityAuditQuery,
  SecurityActor,
  SecurityCredentialInfo,
  SecurityCenterSnapshot,
  SecurityRegistryStatus,
  SecurityGrant,
  SecurityProtectionState,
  SecuritySessionParent,
} from '@mode-db/shared';
import {
  DeviceAuthenticationContractError,
  DeviceRegistrationContractError,
} from '@mode-db/shared';
import { LocalVaultKeyProvider } from './local-vault-key-provider.js';
import { WindowsSecretProtector, type SecretProtector } from './windows-secret-protector.js';
import { SecurityError } from './security-errors.js';
import { securityOrigin, isLoopbackAddress, type NetworkSource } from './network-policy.js';
import {
  assertRecipientLedger,
  assertRecipientLoginKey,
  emptyRecipientLedger,
  parseRecipientCommand,
  recipientKeyPage,
  beginRecipientChallenge,
  completeRecipientChallenge,
  recipientPublicKey,
  type RecipientLedger,
} from './recipient-keys.js';
import { parseRecipientDelivery, type RecipientDeliverySelection } from './recipient-delivery.js';
import { parseRegistrationApprovalRequest } from './registration-approval.js';
import {
  isRegistrationMaintenance,
  parseRegistrationMaintenance,
  sameRegistrationPublicKey,
} from './registration-maintenance.js';
import {
  assertRegistrationLedger,
  assertRegistrationLedgerTransition,
  emptyRegistrationLedger,
  resetRegistrationAccess,
  normalizeRegistrationGrants,
  type RegistrationLedger,
} from './registration-ledger.js';

interface Principal {
  id: string;
  name: string;
  kind: 'application' | 'operator';
  enabled: boolean;
}
type Credential = { -readonly [P in keyof SecurityCredentialInfo]: SecurityCredentialInfo[P] } & {
  secretHash: string;
  kind?: 'api-credential' | 'local-management';
};
interface Session {
  id: string;
  principalId: string;
  credentialId: string;
  parent?: SecuritySessionParent;
  secretHash: string;
  createdAt: string;
  expiresAt: string;
  accessEpoch: number;
  revokedAt?: string;
  origin?: string;
  absoluteExpiresAt?: string;
  securityAdmin?: boolean;
}
interface Pairing {
  id: string;
  credentialId: string;
  parent?: Exclude<SecuritySessionParent, { kind: 'registered-public-key' }>;
  secretHash: string;
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
  origin: string;
  securityAdmin?: boolean;
}
import {
  assertAuthenticationLedger,
  emptyAuthenticationLedger,
  type AuthenticationLedger,
  type AuthenticationChallenge,
} from './authentication-ledger.js';

interface RegistryState {
  version: 1 | 2 | 3 | 4 | 5;
  recipients?: RecipientLedger;
  registration?: RegistrationLedger;
  authentication?: AuthenticationLedger;
  instanceId: string;
  revision: number;
  policyVersion: number;
  accessEpoch: number;
  principals: Principal[];
  credentials: Credential[];
  sessions: Session[];
  pairings: Pairing[];
  keyReferences: VaultKeyReference[];
  events: DataSecurityEvent[];
  protection?: SecurityProtectionState;
}

/** Options for an isolated instance registry; defaults use real Windows protection. */
export interface SecurityRegistryOptions {
  /** Offline CLI may open solely to resume a task; normal listeners must fail closed. */
  readonly resumeDatabaseRotation?: boolean;
  /** Only the offline asset preview/import entry point may resume an unfinished publication. */
  readonly resumeAssetPublication?: boolean;
  readonly protector?: SecretProtector;
  readonly now?: () => number;
  readonly auditLimit?: number;
  readonly auditRetentionDays?: number;
  /** Fault injection at durable commit boundaries; not loaded from configuration. */
  readonly onCommitPoint?: (point: AtomicCommitPoint) => void;
}

/** Non-secret, verified identity returned to the authorization layer. */
export interface VerifiedCredential {
  readonly actor: SecurityActor;
  readonly credential: SecurityCredentialInfo;
  readonly policyVersion: number;
  /** Present for a verified session, not for a reusable API token. */
  readonly sessionParent?: SecuritySessionParent;
}

export interface VerifiedBrowserSession extends VerifiedCredential {
  readonly sessionExpiresAt: string;
  readonly absoluteExpiresAt: string;
  readonly csrf: string;
  readonly securityAdmin?: boolean;
}

const ACTIONS = new Set([
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
]);
const ID = /^[a-zA-Z0-9_-]{1,96}$/;
const HASH = /^[a-f0-9]{64}$/;
const DAY = 86400000;
const MAX_AGGREGATED_OBSERVATIONS = Math.floor(Number.MAX_SAFE_INTEGER / 50000);
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const validDate = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));
function check(condition: unknown): asserts condition {
  if (!condition) {
    throw new SecurityError('SECURITY_INVALID_REQUEST');
  }
}
function grants(value: readonly SecurityGrant[]): SecurityGrant[] {
  check(Array.isArray(value) && value.length <= 100);
  return value.map((g: SecurityGrant) => {
    check(g && typeof g.database === 'string' && ID.test(g.database));
    check(typeof g.resource === 'string' && (g.resource === '*' || ID.test(g.resource)));
    check(Array.isArray(g.actions) && g.actions.length > 0 && g.actions.length <= ACTIONS.size);
    check(g.actions.every((a: string) => ACTIONS.has(a)));
    check(g.releaseDigest === undefined || HASH.test(g.releaseDigest));
    return {
      database: g.database,
      resource: g.resource,
      actions: [...new Set(g.actions)],
      ...(g.releaseDigest ? { releaseDigest: g.releaseDigest } : {}),
    };
  });
}
function info(c: Credential): SecurityCredentialInfo {
  return structuredClone({
    id: c.id,
    principalId: c.principalId,
    name: c.name,
    createdAt: c.createdAt,
    expiresAt: c.expiresAt,
    grants: c.grants,
    ...(c.revokedAt ? { revokedAt: c.revokedAt } : {}),
    ...(c.validUntil ? { validUntil: c.validUntil } : {}),
    ...(c.replacesId ? { replacesId: c.replacesId } : {}),
  });
}
function equalSecret(value: string, expected: string): boolean {
  return timingSafeEqual(Buffer.from(hash(value), 'hex'), Buffer.from(expected, 'hex'));
}
function browserOriginValue(value: string): string {
  const origin = securityOrigin(value);
  const parsed = new URL(origin);
  check(parsed.protocol === 'https:' || isLoopbackAddress(parsed.hostname));
  return origin;
}

function parentOf(entry: Session | Pairing): SecuritySessionParent {
  return (
    entry.parent ?? {
      kind: entry.securityAdmin === true ? 'local-management' : 'api-credential',
      credentialId: entry.credentialId,
    }
  );
}

/** Validate persisted references independently of liveness; revoked history remains readable. */
function assertSessionParent(
  state: RegistryState,
  entry: Session | Pairing,
  pairing = false,
): void {
  check(
    entry.parent === undefined ||
      (entry.parent !== null && typeof entry.parent === 'object' && !Array.isArray(entry.parent)),
  );
  const parent = parentOf(entry);
  check(parent && typeof parent === 'object' && !Array.isArray(parent));
  check(
    Object.keys(parent).every((key) =>
      (parent.kind === 'registered-public-key'
        ? ['kind', 'credentialId', 'userId']
        : ['kind', 'credentialId']
      ).includes(key),
    ) && parent.credentialId === entry.credentialId,
  );
  if (state.version < 3) {
    check(entry.parent === undefined);
  } else {
    check(entry.parent !== undefined);
  }
  let principalId: string;
  if (parent.kind === 'registered-public-key') {
    check(state.version >= 3 && !pairing && 'accessEpoch' in entry && entry.securityAdmin !== true);
    const credential = state.registration?.credentials.find((c) => c.id === parent.credentialId);
    const user = state.registration?.users.find((u) => u.id === parent.userId);
    const app = state.registration?.applications.find((a) => a.id === credential?.applicationId);
    check(credential && user && credential.userId === user.id);
    check(entry.origin === app?.serverOrigin && validDate(entry.absoluteExpiresAt));
    check(
      Date.parse(entry.createdAt) < Date.parse(entry.expiresAt) &&
        Date.parse(entry.expiresAt) <= Date.parse(entry.createdAt) + 30 * 60000 &&
        Date.parse(entry.expiresAt) <= Date.parse(entry.absoluteExpiresAt) &&
        Date.parse(entry.absoluteExpiresAt) <= Date.parse(entry.createdAt) + 8 * 3600000,
    );
    principalId = user.principalId;
  } else {
    check(parent.kind === 'api-credential' || parent.kind === 'local-management');
    const credential = state.credentials.find((c) => c.id === parent.credentialId);
    check(credential && (state.version < 3 || credential.kind === parent.kind));
    principalId = credential.principalId;
    if (parent.kind === 'local-management') {
      check(
        entry.securityAdmin === true &&
          credential.grants.length === 0 &&
          entry.origin &&
          isLoopbackAddress(new URL(entry.origin).hostname) &&
          state.principals.some((p) => p.id === principalId && p.kind === 'operator'),
      );
    } else {
      check(entry.securityAdmin !== true);
    }
  }
  check(!('principalId' in entry) || entry.principalId === principalId);
}

/** Encrypted, instance-owned transactional security ledger and authoritative audit journal.
 * Sensitive mutations and their audit event commit together. No business Vault stores this state.
 */
export class SecurityRegistry {
  private state!: RegistryState;
  private digest: string | null = null;
  private readonly path: string;
  private readonly protector: SecretProtector;
  private readonly now: () => number;
  private readonly auditLimit: number;
  private readonly auditRetentionDays: number;
  private readonly onCommitPoint?: (point: AtomicCommitPoint) => void;
  private release?: () => void;
  private closed = false;
  private actorId = 'local-os-owner';
  private localActor = false;
  private hostedIdentityActor = false;
  private managementEvent?: Pick<DataSecurityEvent, 'actor' | 'source' | 'requestId'>;
  private readonly listeners = new Set<
    (event: { policyVersion: number; credentialIds: readonly string[] }) => void
  >();
  private readonly credentialListeners = new Map<
    string,
    Set<(event: { policyVersion: number; credentialIds: readonly string[] }) => void>
  >();

  private constructor(directory: string, options: SecurityRegistryOptions) {
    this.path = join(resolve(directory), 'registry.mds');
    this.protector = options.protector ?? new WindowsSecretProtector();
    this.now = options.now ?? Date.now;
    this.auditLimit = options.auditLimit ?? 10000;
    this.auditRetentionDays = options.auditRetentionDays ?? 365;
    check(
      Number.isSafeInteger(this.auditLimit) && this.auditLimit >= 1 && this.auditLimit <= 50000,
    );
    check(
      Number.isSafeInteger(this.auditRetentionDays) &&
        this.auditRetentionDays >= 1 &&
        this.auditRetentionDays <= 3650,
    );
    this.onCommitPoint = options.onCommitPoint;
  }

  /** Acquire the instance lease, verify OS protection, and recover/initialize the ledger. */
  static open(directory: string, options: SecurityRegistryOptions = {}): SecurityRegistry {
    const registry = new SecurityRegistry(directory, options);
    try {
      if (
        ['.lock', '.reclaim'].some((suffix) => existsSync(resolve(directory) + '.restore' + suffix))
      ) {
        throw new SecurityError('SECURITY_INSTANCE_BUSY');
      }
      if (
        ['', '.pending', '.commit'].some((suffix) =>
          existsSync(join(resolve(directory), '..', 'security-reset.pending') + suffix),
        )
      ) {
        throw new SecurityError('SECURITY_MAINTENANCE_FAILED');
      }
      if (registry.protector instanceof WindowsSecretProtector) {
        registry.actorId = registry.protector.currentIdentity();
      }
      // Validate the directory ACL before creating a lease, then inspect files only while owned.
      // Otherwise another initializer can replace a pending file during ACL enumeration.
      if (registry.protector instanceof WindowsSecretProtector) {
        registry.protector.ensureDirectory(resolve(directory), false);
      } else {
        registry.protector.ensureDirectory(resolve(directory));
      }
      try {
        registry.release = acquireFileLeaseSync(join(resolve(directory), 'instance-owner'));
      } catch {
        throw new SecurityError('SECURITY_INSTANCE_BUSY');
      }
      registry.protector.ensureDirectory(resolve(directory));
      if (
        !options.resumeAssetPublication &&
        ['', '.pending', '.commit', '.lock', '.reclaim'].some((suffix) =>
          existsSync(join(resolve(directory), 'asset-publication.mld') + suffix),
        )
      ) {
        throw new SecurityError('SECURITY_MAINTENANCE_FAILED');
      }
      if (
        !options.resumeDatabaseRotation &&
        ['', '.pending', '.commit'].some((suffix) =>
          existsSync(join(resolve(directory), 'database-key-rotation.json') + suffix),
        )
      ) {
        throw new SecurityError('SECURITY_MAINTENANCE_FAILED');
      }
      const hasRegistry = ['', '.pending', '.commit'].some((suffix) =>
        existsSync(registry.path + suffix),
      );
      const markerPath = join(resolve(directory), 'registry.ready');
      if (
        !hasRegistry &&
        ['', '.pending', '.commit'].some((suffix) => existsSync(markerPath + suffix))
      ) {
        throw new SecurityError('SECURITY_STORE_INVALID');
      }
      const identity = new LocalVaultKeyProvider(directory, registry.protector).getIdentity(
        hasRegistry,
      );
      const raw = readAtomicFileSync(registry.path, (bytes) => {
        registry.decode(bytes, identity.instanceId);
      });
      if (raw) {
        registry.state = registry.decode(raw, identity.instanceId);
        registry.digest = fileDigest(raw);
      } else {
        registry.state = {
          version: 1,
          instanceId: identity.instanceId,
          revision: 0,
          policyVersion: 1,
          accessEpoch: 1,
          principals: [],
          credentials: [],
          sessions: [],
          pairings: [],
          keyReferences: [],
          events: [],
        };
        registry.commit('instance.initialize', () => undefined);
      }
      const validateMarker = (bytes: Buffer): void => {
        const marker = JSON.parse(bytes.toString('utf8')) as {
          version?: number;
          instanceId?: string;
        };
        if (marker.version !== 1 || marker.instanceId !== identity.instanceId) {
          throw new SecurityError('SECURITY_STORE_INVALID');
        }
      };
      if (!readAtomicFileSync(markerPath, validateMarker)) {
        writeAtomicFileSync(
          markerPath,
          Buffer.from(JSON.stringify({ version: 1, instanceId: identity.instanceId })),
          null,
          validateMarker,
        );
      }
      registry.pruneExpiredAuditEvents();
      return registry;
    } catch (error) {
      registry.release?.();
      if (error instanceof SecurityError) {
        throw error;
      }
      throw new SecurityError('SECURITY_STORE_INVALID');
    }
  }

  /** Only counts and identifiers; no credentials, hashes, secrets, or business values. */
  status(): {
    instanceId: string;
    revision: number;
    policyVersion: number;
    accessEpoch: number;
    principals: number;
    credentials: number;
    sessions: number;
    auditEvents: number;
    auditHealth: SecurityRegistryStatus['auditHealth'];
  } {
    this.assertOpen();
    const s = this.state;
    return {
      instanceId: s.instanceId,
      revision: s.revision,
      policyVersion: s.policyVersion,
      accessEpoch: s.accessEpoch,
      principals: s.principals.length,
      credentials: s.credentials.length,
      sessions: s.sessions.length,
      auditEvents: s.events.length,
      auditHealth: this.auditHealth(),
    };
  }

  protectionState(): SecurityProtectionState | undefined {
    this.assertOpen();
    return structuredClone(this.state.protection);
  }

  /** Fresh deployment only. OS-paired management sessions do not count as data use. */
  assertDeploymentUnused(): void {
    this.assertOpen();
    const s = this.state;
    if (
      s.version !== 1 ||
      s.keyReferences.length ||
      s.credentials.some(
        (c) =>
          c.grants.length ||
          !s.pairings.some((p) => p.credentialId === c.id && p.securityAdmin === true),
      ) ||
      s.principals.some((p) => !s.credentials.some((c) => c.principalId === p.id)) ||
      s.sessions.some((session) => parentOf(session).kind !== 'local-management')
    ) {
      throw new SecurityError('SECURITY_POLICY_CONFLICT');
    }
  }

  recordDeploymentPreview(): void {
    this.commit('deployment.preview', () => undefined);
  }

  /** Metadata only. Existing instances remain V1 until an explicit trusted storage migration. */
  registrationStorageStatus(): {
    ledgerVersion: 1 | 2 | 3 | 4 | 5;
    mode: 'disabled' | 'enabled';
    revision: number;
    applications: number;
    challenges: number;
    users: number;
    credentials: number;
  } {
    this.assertOpen();
    const store = this.state.registration;
    return {
      ledgerVersion: this.state.version,
      mode: store?.mode ?? 'disabled',
      revision: this.state.revision,
      applications: store?.applications.length ?? 0,
      challenges: store?.challenges.length ?? 0,
      users: store?.users.length ?? 0,
      credentials: store?.credentials.length ?? 0,
    };
  }

  /** Server-internal migration primitive; not wired to HTTP, CLI, or configuration. */
  migrateRegistrationStorage(expectedRevision: number): void {
    this.assertRegistrationRevision(expectedRevision);
    if (this.state.version >= 2) {
      return;
    }
    this.commit('registration.storage.migrate', (state) => {
      state.version = 2;
      state.registration = emptyRegistrationLedger();
    });
  }

  /** Trusted internal CAS migration only; never runs implicitly on open or exposes a login. */
  migrateSessionStorage(expectedRevision: number): void {
    this.assertRegistrationRevision(expectedRevision);
    if (this.state.version >= 3) {
      return;
    }
    this.commit('session.storage.migrate', (state) => {
      this.upgradeSessionState(state);
    });
  }

  private upgradeSessionState(state: RegistryState): void {
    if (state.version >= 3) {
      return;
    }
    const adminIds = new Set(
      [...state.sessions, ...state.pairings]
        .filter((entry) => entry.securityAdmin === true)
        .map((entry) => entry.credentialId),
    );
    for (const credential of state.credentials) {
      credential.kind = adminIds.has(credential.id) ? 'local-management' : 'api-credential';
    }
    for (const entry of [...state.sessions, ...state.pairings]) {
      entry.parent = {
        kind: entry.securityAdmin === true ? 'local-management' : 'api-credential',
        credentialId: entry.credentialId,
      };
    }
    state.registration ??= emptyRegistrationLedger();
    state.version = 3;
  }

  /** Explicit, atomic internal migration; ordinary open and disabled configuration do not upgrade. */
  migrateAuthenticationStorage(expectedRevision: number): void {
    this.assertRegistrationRevision(expectedRevision);
    if (this.state.version >= 4) {
      return;
    }
    this.commit('authentication.storage.migrate', (state) => {
      this.upgradeSessionState(state);
      state.authentication = emptyAuthenticationLedger();
      state.version = 4;
    });
  }

  readAuthenticationChallenge(id: string): AuthenticationChallenge | undefined {
    this.assertOpen();
    return structuredClone(this.state.authentication?.challenges.find((c) => c.id === id));
  }

  /** Abandon unfinished ceremonies on restart; collect elapsed terminal entries only. */
  recoverAuthenticationChallenges(): void {
    this.assertOpen();
    if (!this.state.authentication) {
      return;
    }
    if (
      !this.state.authentication.challenges.some(
        (c) =>
          c.state === 'issued' || c.state === 'claimed' || Date.parse(c.expiresAtUtc) <= this.now(),
      )
    ) {
      return;
    }
    this.commit('authentication.recover', (state) => {
      state.authentication!.challenges = state.authentication!.challenges.filter(
        (c) => Date.parse(c.expiresAtUtc) > this.now(),
      );
      for (const c of state.authentication!.challenges) {
        c.state = c.state === 'succeeded' ? 'succeeded' : 'rejected';
        c.finishedAtUtc ??= new Date(this.now()).toISOString();
      }
    });
  }

  issueAuthenticationChallenge(challenge: AuthenticationChallenge, event: DataSecurityEvent): void {
    check(
      this.state.version >= 4 &&
        challenge.state === 'issued' &&
        challenge.accessEpoch === this.state.accessEpoch,
    );
    this.commit(
      'authentication.begin',
      (state) => {
        const store = state.authentication!;
        store.challenges = store.challenges.filter((c) => Date.parse(c.expiresAtUtc) > this.now());
        if (store.challenges.length >= 1000) {
          throw new DeviceAuthenticationContractError('SECURITY_AUTHENTICATION_CAPACITY');
        }
        store.challenges.push(structuredClone(challenge));
        assertAuthenticationLedger(store, state.instanceId);
      },
      undefined,
      'succeeded',
      event,
    );
  }

  claimAuthenticationChallenge(id: string, event: DataSecurityEvent): void {
    this.commit(
      'authentication.claim',
      (state) => {
        const c = state.authentication?.challenges.find((c) => c.id === id);
        if (!c || c.state !== 'issued') {
          throw new DeviceAuthenticationContractError('SECURITY_AUTHENTICATION_CHALLENGE_REPLAYED');
        }
        if (Date.parse(c.expiresAtUtc) <= this.now() || c.accessEpoch !== state.accessEpoch) {
          throw new DeviceAuthenticationContractError('SECURITY_AUTHENTICATION_CHALLENGE_EXPIRED');
        }
        c.state = 'claimed';
        c.claimedAtUtc = new Date(this.now()).toISOString();
      },
      undefined,
      'succeeded',
      event,
    );
  }

  rejectAuthenticationChallenge(id: string, event: DataSecurityEvent): void {
    this.assertOpen();
    if (this.state.authentication?.challenges.find((c) => c.id === id)?.state !== 'claimed') {
      return;
    }
    this.commit(
      'authentication.finish',
      (state) => {
        const c = state.authentication!.challenges.find((c) => c.id === id)!;
        c.state = 'rejected';
        c.finishedAtUtc = new Date(this.now()).toISOString();
      },
      undefined,
      'denied',
      event,
    );
  }

  /** Resolve live ownership internally. Public callers receive a uniform proof rejection. */
  authenticationKey(rawId: string) {
    this.assertOpen();
    const store = this.state.registration;
    const key = store?.credentials.find((c) => c.rawId === rawId && c.state === 'active');
    const user = store?.users.find((u) => u.id === key?.userId && u.enabled);
    const app = store?.applications.find(
      (a) => a.id === key?.applicationId && a.state === 'approved',
    );
    if (
      !key ||
      !user ||
      !app ||
      !this.state.principals.some((p) => p.id === user.principalId && p.enabled)
    ) {
      throw new DeviceAuthenticationContractError('SECURITY_AUTHENTICATION_PROOF_INVALID');
    }
    return structuredClone({ key, user, app });
  }

  /** Counter, terminal challenge, session and successful audit share one durable commit. */
  completeAuthentication(
    id: string,
    rawId: string,
    counter: number,
    backedUp: boolean,
    event: DataSecurityEvent,
  ): { session: string; expiresAt: string } {
    const { key, user, app } = this.authenticationKey(rawId);
    const c = this.readAuthenticationChallenge(id);
    if (
      !c ||
      c.state !== 'claimed' ||
      c.accessEpoch !== this.state.accessEpoch ||
      Date.parse(c.expiresAtUtc) <= this.now()
    ) {
      throw new DeviceAuthenticationContractError('SECURITY_AUTHENTICATION_CHALLENGE_EXPIRED');
    }
    if (
      app.serverOrigin !== c.serverOrigin ||
      app.rpId !== c.rpId ||
      !Number.isSafeInteger(counter) ||
      counter < 0 ||
      counter > 0xffffffff ||
      (key.deviceType === 'singleDevice' &&
        (key.counter !== 0 || counter !== 0) &&
        counter <= key.counter)
    ) {
      throw new DeviceAuthenticationContractError('SECURITY_AUTHENTICATION_PROOF_INVALID');
    }
    const sessionId = randomUUID();
    const session = 'mdbs_v1_' + sessionId + '_' + randomBytes(32).toString('base64url');
    const issuedAt = this.now(),
      at = new Date(issuedAt).toISOString(),
      expiresAt = new Date(issuedAt + 30 * 60000).toISOString();
    this.commit(
      'authentication.login',
      (state) => {
        const credential = state.registration!.credentials.find((k) => k.id === key.id)!;
        credential.counter = Math.max(credential.counter, counter);
        credential.backedUp = backedUp;
        credential.updatedAtUtc = at;
        assertRegistrationLedgerTransition(
          this.state.registration!,
          state.registration!,
          this.now(),
        );
        const challenge = state.authentication!.challenges.find((c) => c.id === id)!;
        challenge.state = 'succeeded';
        challenge.finishedAtUtc = at;
        challenge.sessionId = sessionId;
        state.sessions = state.sessions.filter((s) => Date.parse(s.expiresAt) > this.now());
        if (state.sessions.length >= 10000) {
          throw new DeviceAuthenticationContractError('SECURITY_AUTHENTICATION_CAPACITY');
        }
        state.sessions.push({
          id: sessionId,
          principalId: user.principalId,
          credentialId: key.id,
          parent: { kind: 'registered-public-key', credentialId: key.id, userId: user.id },
          secretHash: hash(session),
          accessEpoch: state.accessEpoch,
          createdAt: at,
          expiresAt,
          absoluteExpiresAt: new Date(issuedAt + 8 * 3600000).toISOString(),
          origin: c.serverOrigin,
        });
      },
      key.id,
      'succeeded',
      {
        ...event,
        actor: { principalId: user.principalId, credentialId: key.id, identityTrust: 'verified' },
        resource: { credentialId: key.id },
      },
    );
    return { session, expiresAt };
  }

  /** Trusted storage adapter only. Never return this snapshot through public management APIs. */
  readRegistrationStorage(): RegistrationLedger {
    this.assertOpen();
    if (!this.state.registration) {
      throw new SecurityError('SECURITY_PROTOCOL_UNSUPPORTED');
    }
    return structuredClone(this.state.registration);
  }

  /** A validated CAS storage transaction, not an authentication or approval entry point.
   * Future service methods must verify admission/proofs/operator identity before using it. */
  commitRegistrationStorage(
    expectedRevision: number,
    input: RegistrationLedger,
    event?: DataSecurityEvent,
    maintenanceEvent?: DataSecurityEvent,
  ): void {
    this.assertRegistrationRevision(expectedRevision);
    if (!this.state.registration) {
      throw new SecurityError('SECURITY_PROTOCOL_UNSUPPORTED');
    }
    assertRegistrationLedger(input, this.state.instanceId, this.state.principals);
    const next = structuredClone(input);
    assertRegistrationLedgerTransition(this.state.registration, next, this.now());
    for (const key of next.credentials) {
      if (!this.state.registration.credentials.some((previous) => previous.id === key.id)) {
        assertRecipientLoginKey(this.state.recipients, key.publicKeyCose, this.now());
      }
    }
    const affected = this.registrationInvalidations(next);
    this.commit(
      event?.action ?? 'registration.storage.update',
      (state) => {
        state.registration = next;
        if (maintenanceEvent) {
          state.events.push({
            ...maintenanceEvent,
            policyVersion: this.state.policyVersion + (affected.length ? 1 : 0),
          });
        }
        if (affected.length) {
          state.policyVersion++;
        }
        this.revokeInactiveRegistrationSessions(state, affected);
      },
      undefined,
      event?.result ?? 'succeeded',
      event
        ? { ...event, policyVersion: this.state.policyVersion + (affected.length ? 1 : 0) }
        : undefined,
    );
    if (affected.length) {
      this.notify(affected);
    }
  }

  /** CAS reduction for OS-local or reverified dedicated management; never expands grants. */
  restrictRegisteredCredential(
    expectedRevision: number,
    credentialId: string,
    input: unknown,
  ): void {
    this.assertOpen();
    if ((!this.localActor || this.managementEvent) && !this.hostedIdentityActor) {
      throw new SecurityError('SECURITY_LOCAL_IDENTITY_DENIED');
    }
    this.assertRegistrationRevision(expectedRevision);
    const next = this.readRegistrationStorage();
    const key = next.credentials.find((c) => c.id === credentialId);
    check(key && key.state !== 'revoked');
    key.grants = normalizeRegistrationGrants(input);
    key.updatedAtUtc = new Date(this.now()).toISOString();
    if (key.state === 'disabled') {
      key.disabledAtUtc = key.updatedAtUtc;
    }
    assertRegistrationLedger(next, this.state.instanceId, this.state.principals);
    assertRegistrationLedgerTransition(this.state.registration!, next, this.now(), credentialId);
    const affected = this.registrationInvalidations(next);
    this.commit(
      'registration.credential.restrict',
      (state) => {
        state.registration = next;
        if (affected.length) {
          state.policyVersion++;
        }
      },
      credentialId,
    );
    if (affected.length) {
      this.notify(affected);
    }
  }

  /** Reverse user index fans a user change out to all of its credential subscriptions. */
  private registrationInvalidations(next: RegistrationLedger): string[] {
    const before = this.state.registration!;
    const keys = new Map(next.credentials.map((key) => [key.id, key]));
    const byUser = new Map<string, string[]>();
    const affected = new Set<string>();
    for (const key of before.credentials) {
      const ids = byUser.get(key.userId) ?? [];
      ids.push(key.id);
      byUser.set(key.userId, ids);
      const current = keys.get(key.id);
      if (
        !current ||
        key.state !== current.state ||
        JSON.stringify(key.grants ?? []) !== JSON.stringify(current.grants ?? [])
      ) {
        affected.add(key.id);
      }
    }
    const users = new Map(next.users.map((user) => [user.id, user]));
    for (const user of before.users) {
      if (user.enabled !== users.get(user.id)?.enabled) {
        for (const id of byUser.get(user.id) ?? []) {
          affected.add(id);
        }
      }
    }
    return [...affected];
  }

  private revokeInactiveRegistrationSessions(
    state: RegistryState,
    affected: readonly string[],
  ): void {
    if (!affected.length) {
      return;
    }
    const keys = new Map(state.registration!.credentials.map((key) => [key.id, key]));
    const users = new Map(state.registration!.users.map((user) => [user.id, user]));
    const inactive = new Set(
      affected.filter((id) => {
        const key = keys.get(id);
        return !key || key.state !== 'active' || !users.get(key.userId)?.enabled;
      }),
    );
    const at = new Date(this.now()).toISOString();
    for (const session of state.sessions) {
      if (
        parentOf(session).kind === 'registered-public-key' &&
        inactive.has(session.credentialId) &&
        !session.revokedAt
      ) {
        session.revokedAt = at;
      }
    }
  }

  private assertRegistrationRevision(expectedRevision: number): void {
    this.assertOpen();
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== this.state.revision) {
      throw new SecurityError('SECURITY_POLICY_CONFLICT');
    }
  }

  /** Called only after the dedicated listener boundary. Reverify the actual paired session. */
  manageHostedIdentity(session: string, origin: string, csrf: string, input: unknown): unknown {
    if (typeof csrf !== 'string' || !/^[a-f0-9]{64}$/.test(csrf)) {
      throw new SecurityError('SECURITY_CSRF_REQUIRED');
    }
    const verified = this.verifyBrowserSession(session, origin, csrf);
    if (
      !verified.securityAdmin ||
      verified.sessionParent?.kind !== 'local-management' ||
      Date.parse(verified.absoluteExpiresAt) >
        Date.parse(verified.credential.createdAt) + 60 * 60000 ||
      this.managementEvent?.actor.principalId !== verified.actor.principalId ||
      this.managementEvent?.source.transport !== 'http' ||
      this.localActor
    ) {
      throw new SecurityError('SECURITY_LOCAL_IDENTITY_DENIED');
    }
    const previous = this.hostedIdentityActor;
    this.hostedIdentityActor = true;
    try {
      return this.manageRegistration(input);
    } finally {
      this.hostedIdentityActor = previous;
    }
  }

  /** OS-local CLI or a freshly verified dedicated management session, never public identity. */
  manageRegistration(input: unknown): unknown {
    this.assertOpen();
    if ((!this.localActor || this.managementEvent) && !this.hostedIdentityActor) {
      throw new SecurityError('SECURITY_LOCAL_IDENTITY_DENIED');
    }
    let action = 'registration.maintenance';
    try {
      if (
        input &&
        typeof input === 'object' &&
        typeof (input as { action?: unknown }).action === 'string' &&
        (input as { action: string }).action.startsWith('registration.recipient.')
      ) {
        const request = parseRecipientCommand(input);
        action = request.action;
        return this.manageRecipientKey(request);
      }
      if (
        input &&
        typeof input === 'object' &&
        ['registration.sessions.list', 'registration.session.revoke'].includes(
          (input as { action: string }).action,
        )
      ) {
        action = (input as { action: string }).action;
        return this.manageIdentitySession(input);
      }
      if (isRegistrationMaintenance(input)) {
        const request = parseRegistrationMaintenance(input);
        action = request.action;
        return this.manageRegisteredIdentity(request);
      }
      const r = parseRegistrationApprovalRequest(input);
      action = r.action;
      if (r.instanceId !== this.state.instanceId) {
        throw new SecurityError('SECURITY_FORBIDDEN');
      }
      if (r.action === 'registration.list') {
        const applications = this.state.registration?.applications ?? [];
        const now = this.now();
        const entries = applications.slice(r.offset, r.offset + r.limit).map((app) => {
          const credential = this.state.registration?.credentials.find(
            (c) => c.id === app.credentialId,
          );
          const user = this.state.registration?.users.find((u) => u.id === app.userId);
          return {
            id: app.id,
            displayName: app.displayName,
            createdAtUtc: app.createdAtUtc,
            expiresAtUtc: app.expiresAtUtc,
            state:
              app.state === 'pending' && Date.parse(app.expiresAtUtc) <= now
                ? 'expired'
                : app.state,
            proofVerified: Boolean(app.candidate),
            serverOrigin: app.serverOrigin,
            rpId: app.rpId,
            ...(app.candidate
              ? {
                  publicKeyFingerprint: createHash('sha256')
                    .update(Buffer.from(app.candidate.publicKeyCose, 'base64url'))
                    .digest('hex'),
                  algorithm: app.candidate.algorithm,
                  deviceType: app.candidate.deviceType,
                  backedUp: app.candidate.backedUp,
                }
              : {}),
            ...(user ? { principalId: user.principalId, userId: user.id } : {}),
            ...(credential
              ? { credentialId: credential.id, grants: structuredClone(credential.grants ?? []) }
              : {}),
          };
        });
        this.commit('registration.list', () => undefined);
        return {
          instanceId: r.instanceId,
          revision: this.state.revision,
          applications: entries,
          total: applications.length,
          offset: r.offset,
          nextOffset: r.offset + r.limit < applications.length ? r.offset + r.limit : null,
        };
      }
      this.assertRegistrationRevision(r.revision);
      if (!this.state.registration) {
        throw new SecurityError('SECURITY_PROTOCOL_UNSUPPORTED');
      }
      const next = structuredClone(this.state),
        store = next.registration!;
      const app = store.applications.find((a) => a.id === r.id);
      if (!app) {
        throw new SecurityError('SECURITY_NOT_FOUND');
      }
      const now = this.now(),
        at = new Date(now).toISOString();
      if (
        app.state !== 'pending' ||
        Date.parse(app.expiresAtUtc) <= now ||
        Date.parse(app.createdAtUtc) > now
      ) {
        throw new SecurityError('SECURITY_POLICY_CONFLICT');
      }
      let principalId: string | undefined;
      if (r.action === 'registration.approve') {
        if (!app.candidate || !app.verifiedAtUtc || Date.parse(app.verifiedAtUtc) > now) {
          throw new SecurityError('SECURITY_FORBIDDEN');
        }
        assertRecipientLoginKey(this.state.recipients, app.candidate.publicKeyCose, now);
        let principal = r.principalId
          ? next.principals.find((p) => p.id === r.principalId)
          : undefined;
        if (r.principalId && (!principal?.enabled || principal.kind !== 'operator')) {
          throw new SecurityError('SECURITY_FORBIDDEN');
        }
        if (!principal) {
          if (next.principals.length >= 10000) {
            throw new SecurityError('SECURITY_RESPONSE_LIMIT');
          }
          principal = { id: randomUUID(), name: r.name!, kind: 'operator', enabled: true };
          next.principals.push(principal);
        }
        principalId = principal.id;
        let user = store.users.find((u) => u.principalId === principal.id);
        if (user && !user.enabled) {
          throw new SecurityError('SECURITY_FORBIDDEN');
        }
        if (!user) {
          user = {
            id: randomUUID(),
            principalId: principal.id,
            displayName: principal.name.slice(0, 80),
            enabled: true,
            createdAtUtc: at,
            updatedAtUtc: at,
          };
          store.users.push(user);
        }
        app.state = 'approved';
        app.decidedAtUtc = at;
        app.userId = user.id;
        app.credentialId = randomUUID();
        store.credentials.push({
          ...app.candidate,
          id: app.credentialId,
          applicationId: app.id,
          userId: user.id,
          state: 'active',
          grants: r.grants,
          createdAtUtc: at,
          updatedAtUtc: at,
        });
      } else {
        app.state = 'rejected';
        app.decidedAtUtc = at;
        for (const challenge of store.challenges) {
          if (challenge.applicationId === app.id && challenge.state === 'issued') {
            challenge.state = Date.parse(challenge.expiresAtUtc) <= now ? 'expired' : 'rejected';
            challenge.finishedAtUtc = at;
          }
        }
      }
      assertRegistrationLedger(store, next.instanceId, next.principals);
      assertRegistrationLedgerTransition(this.state.registration, store, now);
      const event: DataSecurityEvent = {
        version: 1,
        eventId: randomUUID(),
        timestampUtc: at,
        category: 'management',
        action: r.action,
        result: 'succeeded',
        taskId: app.id,
        actor: { principalId: this.actorId, identityTrust: 'verified' },
        source: { transport: 'local-ipc' },
        ...this.managementEvent,
        policyVersion: this.state.policyVersion + 1,
        ...(app.credentialId ? { resource: { principalId, credentialId: app.credentialId } } : {}),
      };
      this.commit(
        r.action,
        (state) => {
          state.principals = next.principals;
          state.registration = store;
          state.policyVersion++;
        },
        undefined,
        'succeeded',
        event,
      );
      this.notify([]);
      return {
        instanceId: r.instanceId,
        registrationId: app.id,
        state: app.state,
        revision: this.state.revision,
        ...(app.credentialId
          ? {
              principalId,
              userId: app.userId,
              credentialId: app.credentialId,
              grants: r.action === 'registration.approve' ? structuredClone(r.grants) : [],
            }
          : {}),
      };
    } catch (caught) {
      const error =
        caught instanceof DeviceRegistrationContractError
          ? new SecurityError(
              caught.code.endsWith('CAPACITY')
                ? 'SECURITY_RESPONSE_LIMIT'
                : 'SECURITY_INVALID_REQUEST',
            )
          : caught;
      if (
        error instanceof SecurityError &&
        [
          'SECURITY_INVALID_REQUEST',
          'SECURITY_NOT_FOUND',
          'SECURITY_POLICY_CONFLICT',
          'SECURITY_FORBIDDEN',
          'SECURITY_CONFIRMATION_REQUIRED',
          'SECURITY_PROTOCOL_UNSUPPORTED',
          'SECURITY_RESPONSE_LIMIT',
        ].includes(error.code)
      ) {
        this.commit(action, () => undefined, undefined, 'denied', {
          version: 1,
          eventId: randomUUID(),
          timestampUtc: new Date(this.now()).toISOString(),
          category: 'management',
          action,
          result: 'denied',
          reasonCode: error.code,
          actor: { principalId: this.actorId, identityTrust: 'verified' },
          source: { transport: 'local-ipc' },
          ...this.managementEvent,
          policyVersion: this.state.policyVersion,
        });
      }
      throw error;
    }
  }

  /** Offline owner only. The instance lease must remain held through sealing and publication. */
  selectDeliveryRecipient(input: unknown) {
    this.assertOpen();
    if (!this.localActor || this.managementEvent || this.hostedIdentityActor) {
      throw new SecurityError('SECURITY_LOCAL_IDENTITY_DENIED');
    }
    const r = parseRecipientDelivery(input);
    this.assertRegistrationRevision(r.revision);
    if (r.instanceId !== this.state.instanceId || this.state.version !== 5) {
      throw new SecurityError('SECURITY_FORBIDDEN');
    }
    const key = this.state.recipients!.keys.find((k) => k.id === r.id);
    const user = this.state.registration!.users.find((u) => u.id === r.userId);
    if (
      !key ||
      key.state !== 'active' ||
      key.userId !== r.userId ||
      key.keyVersion !== r.keyVersion ||
      key.fingerprint !== r.fingerprint ||
      !user?.enabled ||
      !this.state.principals.some((p) => p.id === user.principalId && p.enabled) ||
      !this.state.registration!.credentials.some(
        (c) => c.userId === r.userId && c.state === 'active',
      )
    ) {
      throw new SecurityError('SECURITY_FORBIDDEN');
    }
    return {
      key: recipientPublicKey(key.publicKey).key,
      recipient: {
        id: key.id,
        userId: key.userId,
        keyVersion: key.keyVersion,
        fingerprint: key.fingerprint,
      },
    };
  }

  /** Persist the exact ciphertext digest before it can be published outside the instance. */
  recordSealedRecipientDelivery(
    input: RecipientDeliverySelection,
    database: string,
    kind: 'backup' | 'asset',
    packageSha256: string,
  ): void {
    const { recipient } = this.selectDeliveryRecipient(input);
    check(typeof database === 'string');
    assertFlatGraphSegment(database, 'database');
    check(['backup', 'asset'].includes(kind) && /^[a-f0-9]{64}(?![\s\S])/.test(packageSha256));
    this.commit('recipient.delivery.sealed', () => undefined, undefined, 'succeeded', {
      version: 1,
      eventId: randomUUID(),
      timestampUtc: new Date(this.now()).toISOString(),
      category: 'management',
      action: 'recipient.delivery.sealed',
      result: 'succeeded',
      actor: { principalId: this.actorId, identityTrust: 'verified' },
      source: { transport: 'local-ipc' },
      resource: { database },
      policyVersion: this.state.policyVersion,
      delivery: {
        recipientKeyId: recipient.id,
        userId: recipient.userId,
        keyVersion: recipient.keyVersion,
        fingerprint: recipient.fingerprint,
        packageSha256,
        kind,
      },
    });
  }

  private manageRecipientKey(r: ReturnType<typeof parseRecipientCommand>): unknown {
    if (r.instanceId !== this.state.instanceId) {
      throw new SecurityError('SECURITY_FORBIDDEN');
    }
    if (r.action === 'registration.recipient.list') {
      this.commit(r.action, () => undefined);
      return recipientKeyPage(
        this.state.recipients,
        this.state.instanceId,
        this.state.revision,
        r.offset,
        r.limit,
      );
    }
    this.assertRegistrationRevision(r.revision);
    if (r.action === 'registration.recipient.initialize') {
      check(this.state.version >= 4);
      if (this.state.version < 5) {
        this.commit(r.action, (state) => {
          state.version = 5;
          state.recipients = emptyRecipientLedger();
        });
      }
      return { revision: this.state.revision };
    }
    check(this.state.version === 5 && this.state.recipients);
    const userUsable = (id: string): boolean => {
      const user = this.state.registration!.users.find((u) => u.id === id);
      return (
        !!user?.enabled &&
        this.state.principals.some((p) => p.id === user.principalId && p.enabled) &&
        this.state.registration!.credentials.some((k) => k.userId === id && k.state === 'active')
      );
    };
    if (r.action === 'registration.recipient.begin') {
      if (!userUsable(r.userId)) {
        throw new SecurityError('SECURITY_FORBIDDEN');
      }
      let challenge: ReturnType<typeof beginRecipientChallenge> | undefined;
      this.commit(r.action, (state) => {
        challenge = beginRecipientChallenge(
          state.recipients!,
          state.instanceId,
          r.userId,
          r.publicKey,
          this.now(),
          state.registration!,
        );
      });
      return { revision: this.state.revision, challenge };
    }
    if (r.action === 'registration.recipient.complete') {
      check(r.response.instanceId === r.instanceId);
      const recipients = structuredClone(this.state.recipients!);
      const accepted = completeRecipientChallenge(recipients, r.response, this.now(), userUsable);
      this.commit(
        r.action,
        (state) => {
          state.recipients = recipients;
        },
        undefined,
        accepted ? 'succeeded' : 'denied',
      );
      if (!accepted) {
        throw new SecurityError('SECURITY_FORBIDDEN');
      }
    } else {
      const key = this.state.recipients!.keys.find((k) => k.id === r.id);
      if (!key) {
        throw new SecurityError('SECURITY_NOT_FOUND');
      }
      if (key.state !== 'active') {
        throw new SecurityError('SECURITY_POLICY_CONFLICT');
      }
      this.commit(r.action, (state) => {
        const key = state.recipients!.keys.find((k) => k.id === r.id)!;
        key.state = 'retired';
        key.retiredAtUtc = new Date(this.now()).toISOString();
      });
    }
    return { revision: this.state.revision };
  }

  private manageRegisteredIdentity(r: ReturnType<typeof parseRegistrationMaintenance>): unknown {
    if (r.instanceId !== this.state.instanceId) {
      throw new SecurityError('SECURITY_FORBIDDEN');
    }
    const now = this.now(),
      at = new Date(now).toISOString();
    const page = (entries: unknown[], offset: number, limit: number, name: string): unknown => {
      const selected = entries.slice(offset, offset + limit);
      this.commit(r.action, () => undefined);
      return {
        instanceId: r.instanceId,
        revision: this.state.revision,
        [name]: selected,
        total: entries.length,
        offset,
        nextOffset: offset + limit < entries.length ? offset + limit : null,
      };
    };
    const store = this.state.registration;
    if (r.action === 'registration.credentials.list') {
      const users = new Map(store?.users.map((u) => [u.id, u]) ?? []);
      const entries = (store?.credentials ?? [])
        .filter((c) => !r.userId || c.userId === r.userId)
        .map((c) => ({
          id: c.id,
          applicationId: c.applicationId,
          userId: c.userId,
          principalId: users.get(c.userId)!.principalId,
          state: c.state,
          userEnabled: users.get(c.userId)!.enabled,
          createdAtUtc: c.createdAtUtc,
          updatedAtUtc: c.updatedAtUtc,
          ...(c.disabledAtUtc ? { disabledAtUtc: c.disabledAtUtc } : {}),
          ...(c.revokedAtUtc ? { revokedAtUtc: c.revokedAtUtc } : {}),
          algorithm: c.algorithm,
          deviceType: c.deviceType,
          backedUp: c.backedUp,
          publicKeyFingerprint: createHash('sha256')
            .update(Buffer.from(c.publicKeyCose, 'base64url'))
            .digest('hex'),
          grants: structuredClone(c.grants ?? []),
        }));
      return page(entries, r.offset, r.limit, 'credentials');
    }
    if (r.action === 'registration.users.list') {
      return page(
        (store?.users ?? []).map((u) => ({
          id: u.id,
          principalId: u.principalId,
          displayName: u.displayName,
          enabled: u.enabled,
          createdAtUtc: u.createdAtUtc,
          updatedAtUtc: u.updatedAtUtc,
          credentialCount: store!.credentials.filter((c) => c.userId === u.id).length,
        })),
        r.offset,
        r.limit,
        'users',
      );
    }
    this.assertRegistrationRevision(r.revision);
    if (!store) {
      throw new SecurityError('SECURITY_PROTOCOL_UNSUPPORTED');
    }
    const next = structuredClone(store);
    let principalId: string | undefined, credentialId: string | undefined;
    let result: Record<string, unknown>;
    if (r.action === 'registration.user.disable' || r.action === 'registration.user.enable') {
      const user = next.users.find((u) => u.id === r.id);
      if (!user) {
        throw new SecurityError('SECURITY_NOT_FOUND');
      }
      const enabled = r.action === 'registration.user.enable';
      if (user.enabled === enabled) {
        throw new SecurityError('SECURITY_POLICY_CONFLICT');
      }
      if (enabled && !this.state.principals.some((p) => p.id === user.principalId && p.enabled)) {
        throw new SecurityError('SECURITY_FORBIDDEN');
      }
      user.enabled = enabled;
      user.updatedAtUtc = at;
      principalId = user.principalId;
      result = { userId: user.id, enabled };
    } else {
      const key = next.credentials.find((c) => c.id === r.id);
      if (!key) {
        throw new SecurityError('SECURITY_NOT_FOUND');
      }
      const user = next.users.find((u) => u.id === key.userId)!;
      principalId = user.principalId;
      credentialId = key.id;
      if (key.state === 'revoked') {
        throw new SecurityError('SECURITY_POLICY_CONFLICT');
      }
      if (
        (r.action === 'registration.credential.enable' ||
          r.action === 'registration.credential.replace') &&
        (!user.enabled ||
          !this.state.principals.some((p) => p.id === user.principalId && p.enabled))
      ) {
        throw new SecurityError('SECURITY_FORBIDDEN');
      }
      if (r.action === 'registration.credential.restrict') {
        this.restrictRegisteredCredential(r.revision, r.id, r.grants);
        return {
          instanceId: r.instanceId,
          revision: this.state.revision,
          credentialId: key.id,
          grants: structuredClone(r.grants),
        };
      }
      if (
        (r.action === 'registration.credential.disable' && key.state !== 'active') ||
        (r.action === 'registration.credential.enable' && key.state !== 'disabled')
      ) {
        throw new SecurityError('SECURITY_POLICY_CONFLICT');
      }
      key.updatedAtUtc = at;
      delete key.disabledAtUtc;
      if (r.action === 'registration.credential.disable') {
        key.state = 'disabled';
        key.disabledAtUtc = at;
      } else if (r.action === 'registration.credential.enable') {
        key.state = 'active';
      } else {
        key.state = 'revoked';
        key.revokedAtUtc = at;
      }
      result = { credentialId: key.id, userId: key.userId, state: key.state };
      if (r.action === 'registration.credential.replace') {
        const app = next.applications.find((a) => a.id === r.applicationId);
        if (!app) {
          throw new SecurityError('SECURITY_NOT_FOUND');
        }
        if (
          app.state !== 'pending' ||
          Date.parse(app.expiresAtUtc) <= now ||
          Date.parse(app.createdAtUtc) > now
        ) {
          throw new SecurityError('SECURITY_POLICY_CONFLICT');
        }
        if (
          !app.candidate ||
          !app.verifiedAtUtc ||
          Date.parse(app.verifiedAtUtc) > now ||
          app.candidate.rawId === key.rawId ||
          sameRegistrationPublicKey(app.candidate.publicKeyCose, key.publicKeyCose)
        ) {
          throw new SecurityError('SECURITY_FORBIDDEN');
        }
        app.state = 'approved';
        app.decidedAtUtc = at;
        app.userId = user.id;
        app.credentialId = randomUUID();
        next.credentials.push({
          ...app.candidate,
          id: app.credentialId,
          applicationId: app.id,
          userId: user.id,
          state: 'active',
          grants: r.grants,
          createdAtUtc: at,
          updatedAtUtc: at,
        });
        result = {
          ...result,
          registrationId: app.id,
          replacementCredentialId: app.credentialId,
          grants: structuredClone(r.grants),
        };
      }
    }
    this.commitRegistrationStorage(r.revision, next, {
      version: 1,
      eventId: randomUUID(),
      timestampUtc: at,
      category: 'management',
      action: r.action,
      result: 'succeeded',
      actor: { principalId: this.actorId, identityTrust: 'verified' },
      source: { transport: 'local-ipc' },
      ...this.managementEvent,
      policyVersion: this.state.policyVersion,
      resource: { principalId, ...(credentialId ? { credentialId } : {}) },
      ...(r.action === 'registration.credential.replace' ? { taskId: r.applicationId } : {}),
    });
    return { instanceId: r.instanceId, revision: this.state.revision, ...result };
  }

  private manageIdentitySession(input: unknown): unknown {
    const r = input as Record<string, unknown>;
    const listing = r.action === 'registration.sessions.list';
    const allowed = listing
      ? ['action', 'instanceId', 'offset', 'limit']
      : ['action', 'instanceId', 'id', 'revision', 'confirm'];
    const uuid = (v: unknown): boolean =>
      typeof v === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.exec(v)?.[0] === v;
    if (
      Array.isArray(input) ||
      Object.keys(r).some((k) => !allowed.includes(k)) ||
      !uuid(r.instanceId)
    ) {
      throw new SecurityError('SECURITY_INVALID_REQUEST');
    }
    if (r.instanceId !== this.state.instanceId) {
      throw new SecurityError('SECURITY_FORBIDDEN');
    }
    if (listing) {
      const offset = r.offset ?? 0,
        limit = r.limit ?? 25;
      if (
        !Number.isSafeInteger(offset) ||
        (offset as number) < 0 ||
        (offset as number) > 10000 ||
        !Number.isSafeInteger(limit) ||
        (limit as number) < 1 ||
        (limit as number) > 100
      ) {
        throw new SecurityError('SECURITY_INVALID_REQUEST');
      }
      const sessions = this.securityCenterSnapshot().sessions;
      this.commit('registration.sessions.list', () => undefined);
      return {
        instanceId: r.instanceId,
        revision: this.state.revision,
        sessions: sessions.slice(offset as number, (offset as number) + (limit as number)),
        total: sessions.length,
        offset,
        nextOffset:
          (offset as number) + (limit as number) < sessions.length
            ? (offset as number) + (limit as number)
            : null,
      };
    }
    if (!uuid(r.id) || !Number.isSafeInteger(r.revision) || (r.revision as number) < 0) {
      throw new SecurityError('SECURITY_INVALID_REQUEST');
    }
    if (r.confirm !== true) {
      throw new SecurityError('SECURITY_CONFIRMATION_REQUIRED');
    }
    this.assertRegistrationRevision(r.revision as number);
    const current = this.state.sessions.find((s) => s.id === r.id);
    if (!current) {
      throw new SecurityError('SECURITY_NOT_FOUND');
    }
    if (current.revokedAt) {
      throw new SecurityError('SECURITY_POLICY_CONFLICT');
    }
    this.commit(
      'registration.session.revoke',
      (state) => {
        state.sessions.find((s) => s.id === r.id)!.revokedAt = new Date(this.now()).toISOString();
      },
      current.credentialId,
    );
    this.notify([current.credentialId]);
    return { instanceId: r.instanceId, revision: this.state.revision, sessionId: r.id };
  }

  saveProtection(action: string, protection: SecurityProtectionState): void {
    this.commit(action, (state) => {
      state.protection = structuredClone(protection);
      state.policyVersion++;
    });
    this.notify([]);
  }

  recordSecurityEvent(event: DataSecurityEvent): void {
    this.assertOpen();
    if (
      event.actor.identityTrust === 'unverified' &&
      event.result === 'denied' &&
      (event.action === 'network.reject' || event.action === 'authentication.reject')
    ) {
      check(validDate(event.timestampUtc));
      const windowStartUtc = new Date(
        Math.floor(Date.parse(event.timestampUtc) / 60000) * 60000,
      ).toISOString();
      const retained = this.state.events.filter(
        (e) => Date.parse(e.timestampUtc) >= this.now() - this.auditRetentionDays * DAY,
      );
      const currentWindow = retained.filter(
        (e) => e.aggregation?.windowStartUtc === windowStartUtc,
      );
      const key = (e: DataSecurityEvent) =>
        JSON.stringify([
          e.action,
          e.reasonCode,
          e.plane,
          e.source.transport,
          e.source.peerIp,
          e.source.clientIp,
          e.source.clientIpBasis,
          e.policyVersion,
          e.ruleId,
        ]);
      const previous = currentWindow.find((e) => key(e) === key(event));
      if (
        !previous &&
        (currentWindow.length >= Math.min(128, Math.max(1, Math.floor(this.auditLimit / 4))) ||
          retained.length >= Math.floor(this.auditLimit * 0.8))
      ) {
        throw new SecurityError('SECURITY_AUDIT_CAPACITY');
      }
      const count = (previous?.aggregation?.observedCount ?? 0) + 1;
      if (!Number.isSafeInteger(count) || count > MAX_AGGREGATED_OBSERVATIONS) {
        throw new SecurityError('SECURITY_AUDIT_CAPACITY');
      }
      const samples = [...(previous?.aggregation?.sampleRequestIds ?? [])];
      if (event.requestId && samples.length < 3 && !samples.includes(event.requestId)) {
        samples.push(event.requestId);
      }
      const aggregate: DataSecurityEvent = {
        ...event,
        timestampUtc:
          previous && Date.parse(previous.timestampUtc) > Date.parse(event.timestampUtc)
            ? previous.timestampUtc
            : event.timestampUtc,
        eventId: previous?.eventId ?? event.eventId,
        requestId: previous?.requestId ?? event.requestId,
        aggregation: {
          windowStartUtc,
          firstSeenUtc:
            previous?.aggregation &&
            Date.parse(previous.aggregation.firstSeenUtc) < Date.parse(event.timestampUtc)
              ? previous.aggregation.firstSeenUtc
              : event.timestampUtc,
          lastSeenUtc:
            previous?.aggregation &&
            Date.parse(previous.aggregation.lastSeenUtc) > Date.parse(event.timestampUtc)
              ? previous.aggregation.lastSeenUtc
              : event.timestampUtc,
          observedCount: count,
          savedDetails: 1,
          suppressedDetails: count - 1,
          sampleRequestIds: samples,
        },
      };
      this.commit(
        event.action,
        (state) => {
          if (previous) {
            state.events = state.events.filter((e) => e.eventId !== previous.eventId);
          }
        },
        undefined,
        'denied',
        aggregate,
      );
      return;
    }
    this.commit(event.action, () => undefined, undefined, 'succeeded', event);
  }

  withManagementActor<T>(
    event: Pick<DataSecurityEvent, 'actor' | 'source' | 'requestId'>,
    work: () => T,
  ): T {
    const previous = this.managementEvent;
    this.managementEvent = event;
    try {
      return work();
    } finally {
      this.managementEvent = previous;
    }
  }

  managementActorId(): string {
    return this.managementEvent?.actor.principalId ?? this.actorId;
  }

  /** Verify an already-held instance lease before an offline key operation reuses it. */
  assertMaintenanceOwnership(directory: string): void {
    if (this.closed || !this.release || this.path !== join(resolve(directory), 'registry.mds')) {
      throw new SecurityError('SECURITY_INSTANCE_BUSY');
    }
  }

  recordMaintenance(
    action:
      | 'master.rotate.started'
      | 'master.rotate.completed'
      | 'factory.reset.prepared'
      | 'factory.reset.started'
      | 'factory.reset.completed'
      | 'recovery.export.started'
      | 'recovery.export.completed'
      | 'recovery.export.failed'
      | 'database.rotate.started'
      | 'database.rotate.completed'
      | 'database.rotate.failed'
      | 'backup.task.started'
      | 'backup.task.completed'
      | 'backup.task.failed'
      | 'asset.task.started'
      | 'asset.task.completed'
      | 'asset.task.failed',
  ): void {
    this.commit(
      action,
      () => undefined,
      undefined,
      action.endsWith('.failed') ? 'failed' : action.endsWith('.started') ? 'started' : 'succeeded',
    );
  }

  private auditHealth(): SecurityRegistryStatus['auditHealth'] {
    const usagePercent = Math.round((this.state.events.length / this.auditLimit) * 100);
    const oldestEventUtc = this.state.events.reduce<string | undefined>((oldest, event) => {
      if (!oldest || Date.parse(event.timestampUtc) < Date.parse(oldest)) {
        return event.timestampUtc;
      }
      return oldest;
    }, undefined);
    return {
      maxEvents: this.auditLimit,
      usagePercent,
      status: usagePercent >= 95 ? 'critical' : usagePercent >= 80 ? 'warning' : 'healthy',
      retentionDays: this.auditRetentionDays,
      ...(oldestEventUtc ? { oldestEventUtc } : {}),
    };
  }

  /** Register an application or operator; no implicit data privileges are assigned. */
  createPrincipal(name: string, kind: Principal['kind'] = 'application'): Principal {
    check(typeof name === 'string' && name.trim().length > 0 && name.length <= 128);
    check(kind === 'application' || kind === 'operator');
    const principal: Principal = { id: randomUUID(), name: name.trim(), kind, enabled: true };
    this.commit(
      'principal.create',
      (s) => {
        check(s.principals.length < 10000);
        s.principals.push(principal);
      },
      principal.id,
    );
    return structuredClone(principal);
  }

  /** List metadata; the original credential is never retrievable. */
  listCredentials(): readonly SecurityCredentialInfo[] {
    this.assertOpen();
    return this.state.credentials.map(info);
  }

  /** Safe metadata for the OS-authenticated security center; secrets and hashes are excluded. */
  securityCenterSnapshot(): SecurityCenterSnapshot {
    this.assertOpen();
    const now = this.now();
    return structuredClone({
      status: this.status(),
      principals: this.state.principals.map(({ id, name, kind, enabled }) => ({
        id,
        name,
        kind,
        enabled,
      })),
      credentials: this.listCredentials(),
      sessions: this.state.sessions.map((session) => {
        let parentActive = false;
        try {
          this.resolveSessionParent(session);
          parentActive = true;
        } catch {
          // Unusable parents remain visible as inactive metadata, never as an authority.
        }
        return {
          id: session.id,
          principalId: session.principalId,
          credentialId: session.credentialId,
          parent: parentOf(session),
          createdAt: session.createdAt,
          expiresAt: session.expiresAt,
          ...(session.revokedAt ? { revokedAt: session.revokedAt } : {}),
          ...(session.origin ? { origin: session.origin } : {}),
          active: Boolean(
            parentActive &&
            !session.revokedAt &&
            session.accessEpoch === this.state.accessEpoch &&
            Date.parse(session.expiresAt) > now,
          ),
          securityAdmin: parentOf(session).kind === 'local-management',
        };
      }),
      keyReferences: this.state.keyReferences,
    });
  }

  /** Create a bounded-lifetime, default-deny credential; return its secret exactly once. */
  createCredential(
    principalId: string,
    name: string,
    requested: readonly SecurityGrant[] = [],
    expiresInDays = 30,
  ): { token: string; credential: SecurityCredentialInfo } {
    this.assertOpen();
    check(this.state.principals.some((p) => p.id === principalId && p.enabled));
    check(typeof name === 'string' && name.trim().length > 0 && name.length <= 128);
    check(Number.isFinite(expiresInDays) && expiresInDays > 0 && expiresInDays <= 365);
    const id = randomUUID();
    const token = `mdbt_v1_${id}_${randomBytes(32).toString('base64url')}`;
    const now = this.now();
    const record: Credential = {
      id,
      principalId,
      name: name.trim(),
      secretHash: hash(token),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + expiresInDays * DAY).toISOString(),
      grants: grants(requested),
    };
    this.commit(
      'credential.create',
      (s) => {
        check(s.credentials.length < 10000);
        if (s.version >= 3) {
          record.kind = 'api-credential';
        }
        s.credentials.push(record);
      },
      id,
    );
    return { token, credential: info(record) };
  }

  /** Authenticate with constant-time secret comparison and persisted expiry/revocation state. */
  authenticate(token: string): VerifiedCredential {
    this.assertOpen();
    check(typeof token === 'string' && token.length <= 256);
    const match = /^mdbt_v1_([a-zA-Z0-9-]{36})_([a-zA-Z0-9_-]{43})$/.exec(token);
    const record = this.state.credentials.find((c) => c.id === match?.[1]);
    if (
      !record ||
      this.isLocalManagementCredential(record.id) ||
      !equalSecret(token, record.secretHash)
    ) {
      throw new SecurityError('SECURITY_CREDENTIAL_INVALID');
    }
    if (record.revokedAt) {
      throw new SecurityError('SECURITY_CREDENTIAL_REVOKED');
    }
    if (
      Date.parse(record.expiresAt) <= this.now() ||
      (record.validUntil && Date.parse(record.validUntil) <= this.now())
    ) {
      throw new SecurityError('SECURITY_CREDENTIAL_EXPIRED');
    }
    const principal = this.state.principals.find((p) => p.id === record.principalId && p.enabled);
    if (!principal) {
      throw new SecurityError('SECURITY_CREDENTIAL_REVOKED');
    }
    return {
      actor: {
        principalId: principal.id,
        credentialId: record.id,
        ...(principal.kind === 'application' ? { applicationId: principal.id } : {}),
        identityTrust: 'verified',
      },
      credential: info(record),
      policyVersion: this.state.policyVersion,
    };
  }

  /** Rotate without widening scope or extending the original absolute expiry. */
  rotateCredential(
    id: string,
    graceMinutes = 10,
  ): { token: string; credential: SecurityCredentialInfo } {
    this.assertOpen();
    check(Number.isFinite(graceMinutes) && graceMinutes >= 0 && graceMinutes <= 60);
    const old = this.state.credentials.find((c) => c.id === id);
    if (!old) {
      throw new SecurityError('SECURITY_NOT_FOUND');
    }
    check(!this.isLocalManagementCredential(id));
    check(
      !old.revokedAt &&
        Date.parse(old.expiresAt) > this.now() &&
        (!old.validUntil || Date.parse(old.validUntil) > this.now()),
    );
    const nextId = randomUUID();
    const token = `mdbt_v1_${nextId}_${randomBytes(32).toString('base64url')}`;
    const now = new Date(this.now()).toISOString();
    const next: Credential = {
      ...structuredClone(old),
      id: nextId,
      createdAt: now,
      secretHash: hash(token),
      replacesId: old.id,
    };
    delete next.validUntil;
    this.commit(
      'credential.rotate',
      (s) => {
        check(s.credentials.length < 10000);
        const prior = s.credentials.find((c) => c.id === id)!;
        prior.validUntil = new Date(
          Math.min(
            Date.parse(prior.expiresAt),
            Date.parse(prior.validUntil ?? prior.expiresAt),
            this.now() + graceMinutes * 60000,
          ),
        ).toISOString();
        if (graceMinutes === 0) {
          prior.revokedAt = now;
        }
        s.credentials.push(next);
        s.sessions
          .filter((v) => v.credentialId === id)
          .forEach((v) => {
            v.revokedAt = now;
          });
        s.policyVersion++;
      },
      id,
    );
    this.notify([id]);
    return { token, credential: info(next) };
  }

  /** Revoke a token and its sessions before notifying live transports. */
  revokeCredential(id: string): void {
    this.assertOpen();
    if (!this.state.credentials.some((c) => c.id === id)) {
      throw new SecurityError('SECURITY_NOT_FOUND');
    }
    this.commit(
      'credential.revoke',
      (s) => {
        const at = new Date(this.now()).toISOString();
        s.credentials.find((c) => c.id === id)!.revokedAt = at;
        s.sessions
          .filter((v) => v.credentialId === id)
          .forEach((v) => {
            v.revokedAt = at;
          });
        s.policyVersion++;
      },
      id,
    );
    this.notify([id]);
  }

  /** Create a one-time browser pairing code for an already issued credential. */
  createLocalBrowserPairing(
    origin: string,
    databases: readonly string[],
    securityAdmin = false,
    absoluteLifetimeMinutes = 480,
  ): { code: string; id: string; expiresAt: string } {
    origin = browserOriginValue(origin);
    check(isLoopbackAddress(new URL(origin).hostname));
    check(
      Number.isFinite(absoluteLifetimeMinutes) &&
        absoluteLifetimeMinutes > 0 &&
        absoluteLifetimeMinutes <= 480,
    );
    check(
      Array.isArray(databases) &&
        databases.length <= 100 &&
        (securityAdmin || databases.length > 0),
    );
    const permissions = securityAdmin
      ? []
      : grants(
          [...new Set(databases)].map((database) => ({
            database,
            resource: '*',
            actions: [
              'model.read',
              'model.write',
              'schema.manage',
              'database.manage',
              'transfer.import',
              'transfer.export',
              'backup.manage',
            ],
          })),
        );
    const now = this.now();
    const principalId = randomUUID();
    const credentialId = randomUUID();
    const id = randomUUID();
    const code = `mdbp_v1_${id}_${randomBytes(32).toString('base64url')}`;
    const expiresAt = new Date(now + 5 * 60000).toISOString();
    this.commit(
      'browser.launch',
      (s) => {
        check(
          s.principals.length < 10000 && s.credentials.length < 10000 && s.pairings.length < 10000,
        );
        s.principals.push({
          id: principalId,
          name: 'Local browser',
          kind: 'operator',
          enabled: true,
        });
        // No reusable credential secret is delivered to the browser or CLI.
        s.credentials.push({
          id: credentialId,
          principalId,
          name: 'Local browser session',
          secretHash: hash(randomBytes(32).toString('base64url')),
          ...(s.version >= 3
            ? { kind: securityAdmin ? ('local-management' as const) : ('api-credential' as const) }
            : {}),
          createdAt: new Date(now).toISOString(),
          expiresAt: new Date(now + absoluteLifetimeMinutes * 60000).toISOString(),
          grants: permissions,
        });
        s.pairings.push({
          id,
          credentialId,
          origin,
          secretHash: hash(code),
          createdAt: new Date(now).toISOString(),
          expiresAt,
          ...(securityAdmin ? { securityAdmin: true } : {}),
          ...(s.version >= 3
            ? {
                parent: {
                  kind: securityAdmin ? ('local-management' as const) : ('api-credential' as const),
                  credentialId,
                },
              }
            : {}),
        });
      },
      credentialId,
    );
    return { code, id, expiresAt };
  }

  /** Only OS-issued active pairings/sessions can add an exact browser Origin. */
  allowsBrowserOrigin(origin: string): boolean {
    const now = this.now();
    const parentUsable = (entry: Session | Pairing): boolean => {
      try {
        this.resolveSessionParent(entry);
        return true;
      } catch {
        return false;
      }
    };
    return (
      this.state.pairings.some(
        (p) => p.origin === origin && !p.usedAt && Date.parse(p.expiresAt) > now && parentUsable(p),
      ) ||
      this.state.sessions.some(
        (s) =>
          s.origin === origin &&
          !s.revokedAt &&
          s.accessEpoch === this.state.accessEpoch &&
          Date.parse(s.expiresAt) > now &&
          parentUsable(s),
      )
    );
  }

  createPairingForCredential(
    credentialId: string,
    lifetimeMinutes: number,
    origin: string,
  ): { code: string; id: string; expiresAt: string } {
    this.assertOpen();
    check(ID.test(credentialId));
    check(Number.isFinite(lifetimeMinutes) && lifetimeMinutes > 0 && lifetimeMinutes <= 30);
    origin = browserOriginValue(origin);
    const credential = this.state.credentials.find((c) => c.id === credentialId);
    if (!credential) {
      throw new SecurityError('SECURITY_NOT_FOUND');
    }
    check(!this.isLocalManagementCredential(credentialId));
    this.assertCredentialUsable(credential);
    const id = randomUUID();
    const code = `mdbp_v1_${id}_${randomBytes(32).toString('base64url')}`;
    const expiresAt = new Date(
      Math.min(
        this.now() + lifetimeMinutes * 60000,
        Date.parse(credential.expiresAt),
        Date.parse(credential.validUntil ?? credential.expiresAt),
      ),
    ).toISOString();
    this.commit(
      'pairing.create',
      (s) => {
        const now = this.now();
        s.pairings = s.pairings.filter((p) => !p.usedAt && Date.parse(p.expiresAt) > now);
        check(s.pairings.length < 10000);
        s.pairings.push({
          id,
          credentialId,
          ...(s.version >= 3 ? { parent: { kind: 'api-credential' as const, credentialId } } : {}),
          origin,
          secretHash: hash(code),
          createdAt: new Date(now).toISOString(),
          expiresAt,
        });
      },
      credentialId,
    );
    return { code, id, expiresAt };
  }

  /** Consume a pairing exactly once and mint a short-lived browser session. */
  consumePairing(
    code: string,
    origin: string,
    lifetimeMinutes = 30,
    requiredRole?: 'data' | 'management',
  ): { session: string; id: string; expiresAt: string } {
    this.assertOpen();
    check(typeof code === 'string' && code.length <= 256);
    const match = /^mdbp_v1_([a-zA-Z0-9-]{36})_([a-zA-Z0-9_-]{43})$/.exec(code);
    const pairing = this.state.pairings.find((p) => p.id === match?.[1]);
    if (!pairing || !equalSecret(code, pairing.secretHash)) {
      throw new SecurityError('SECURITY_CREDENTIAL_INVALID');
    }
    if (pairing.usedAt) {
      throw new SecurityError('SECURITY_CREDENTIAL_REVOKED');
    }
    if (Date.parse(pairing.expiresAt) <= this.now()) {
      throw new SecurityError('SECURITY_CREDENTIAL_EXPIRED');
    }
    if (securityOrigin(origin) !== pairing.origin) {
      throw new SecurityError('SECURITY_ORIGIN_DENIED');
    }
    if (
      (requiredRole === 'management' && !pairing.securityAdmin) ||
      (requiredRole === 'data' && pairing.securityAdmin)
    ) {
      throw new SecurityError('SECURITY_FORBIDDEN');
    }
    check(Number.isFinite(lifetimeMinutes) && lifetimeMinutes > 0 && lifetimeMinutes <= 720);
    const credential = this.resolveSessionParent(pairing);
    const principal = this.state.principals.find(
      (p) => p.id === credential.principalId && p.enabled,
    );
    if (!principal) {
      throw new SecurityError('SECURITY_CREDENTIAL_REVOKED');
    }
    const id = randomUUID();
    const session = `mdbs_v1_${id}_${randomBytes(32).toString('base64url')}`;
    const absoluteExpiresAt = new Date(
      Math.min(
        this.now() + 8 * 3600000,
        Date.parse(credential.expiresAt),
        Date.parse(credential.validUntil ?? credential.expiresAt),
      ),
    ).toISOString();
    const expiresAt = new Date(
      Math.min(this.now() + lifetimeMinutes * 60000, Date.parse(absoluteExpiresAt)),
    ).toISOString();
    this.commit(
      'pairing.consume',
      (s) => {
        const current = s.pairings.find((p) => p.id === pairing.id);
        if (!current || current.usedAt) {
          throw new SecurityError('SECURITY_CREDENTIAL_REVOKED');
        }
        current.usedAt = new Date(this.now()).toISOString();
        s.sessions = s.sessions.filter((v) => !v.revokedAt && Date.parse(v.expiresAt) > this.now());
        check(s.sessions.length < 10000);
        s.sessions.push({
          id,
          principalId: credential.principalId,
          credentialId: credential.id,
          secretHash: hash(session),
          accessEpoch: s.accessEpoch,
          createdAt: new Date(this.now()).toISOString(),
          expiresAt,
          origin: pairing.origin,
          absoluteExpiresAt,
          ...(pairing.securityAdmin ? { securityAdmin: true } : {}),
          ...(s.version >= 3 ? { parent: parentOf(pairing) } : {}),
        });
      },
      credential.id,
      'succeeded',
      this.browserEvent('pairing.consume', credential, 'http'),
    );
    return { session, id, expiresAt };
  }

  /** Revoke one browser session; parent credentials and business Vaults remain unchanged. */
  revokeSession(session: string): void {
    const verified = this.verifySession(session);
    const id = /^mdbs_v1_([a-zA-Z0-9-]{36})_/.exec(session)?.[1];
    if (!id) {
      throw new SecurityError('SECURITY_CREDENTIAL_INVALID');
    }
    this.commit(
      'session.revoke',
      (s) => {
        const current = s.sessions.find((v) => v.id === id);
        if (!current || current.revokedAt) {
          throw new SecurityError('SECURITY_CREDENTIAL_REVOKED');
        }
        current.revokedAt = new Date(this.now()).toISOString();
      },
      verified.credential.id,
      'succeeded',
      this.browserEvent('session.revoke', verified.credential, 'http'),
    );
    this.notify([verified.credential.id]);
  }

  /** Rotate a browser session without extending beyond the parent credential expiry. */
  rotateSession(
    session: string,
    lifetimeMinutes = 30,
  ): { session: string; id: string; expiresAt: string } {
    const verified = this.verifySession(session);
    check(Number.isFinite(lifetimeMinutes) && lifetimeMinutes > 0 && lifetimeMinutes <= 720);
    const oldId = /^mdbs_v1_([a-zA-Z0-9-]{36})_/.exec(session)?.[1];
    if (!oldId) {
      throw new SecurityError('SECURITY_CREDENTIAL_INVALID');
    }
    const id = randomUUID();
    const next = `mdbs_v1_${id}_${randomBytes(32).toString('base64url')}`;
    const previous = this.state.sessions.find((v) => v.id === oldId)!;
    check(parentOf(previous).kind !== 'registered-public-key' || lifetimeMinutes <= 30);
    const absoluteExpiresAt = previous.absoluteExpiresAt ?? previous.expiresAt;
    const expiresAt = new Date(
      Math.min(
        this.now() + lifetimeMinutes * 60000,
        Date.parse(verified.credential.expiresAt),
        Date.parse(verified.credential.validUntil ?? verified.credential.expiresAt),
        Date.parse(absoluteExpiresAt),
      ),
    ).toISOString();
    this.commit(
      'session.rotate',
      (s) => {
        const old = s.sessions.find((v) => v.id === oldId);
        if (!old || old.revokedAt) {
          throw new SecurityError('SECURITY_CREDENTIAL_REVOKED');
        }
        old.revokedAt = new Date(this.now()).toISOString();
        s.sessions = s.sessions.filter((v) => Date.parse(v.expiresAt) > this.now());
        check(s.sessions.length < 10000);
        s.sessions.push({
          id,
          principalId: verified.credential.principalId,
          credentialId: verified.credential.id,
          secretHash: hash(next),
          accessEpoch: s.accessEpoch,
          createdAt: new Date(this.now()).toISOString(),
          expiresAt,
          origin: previous.origin,
          absoluteExpiresAt,
          ...(previous.securityAdmin ? { securityAdmin: true } : {}),
          ...(s.version >= 3 ? { parent: parentOf(previous) } : {}),
        });
      },
      verified.credential.id,
      'succeeded',
      this.browserEvent('session.rotate', verified.credential, 'http'),
    );
    this.notify([verified.credential.id]);
    return { session: next, id, expiresAt };
  }

  /** Session lifecycle primitive; browser pairing/cookies use this in SEC-M4. */
  createSession(token: string, lifetimeMinutes = 30): { session: string; id: string } {
    const verified = this.authenticate(token);
    check(Number.isFinite(lifetimeMinutes) && lifetimeMinutes > 0 && lifetimeMinutes <= 720);
    const id = randomUUID();
    const session = `mdbs_v1_${id}_${randomBytes(32).toString('base64url')}`;
    this.commit(
      'session.create',
      (s) => {
        check(s.sessions.length < 10000);
        s.sessions.push({
          id,
          principalId: verified.credential.principalId,
          credentialId: verified.credential.id,
          ...(s.version >= 3
            ? { parent: { kind: 'api-credential' as const, credentialId: verified.credential.id } }
            : {}),
          secretHash: hash(session),
          accessEpoch: s.accessEpoch,
          createdAt: new Date(this.now()).toISOString(),
          expiresAt: new Date(
            Math.min(
              this.now() + lifetimeMinutes * 60000,
              Date.parse(verified.credential.expiresAt),
            ),
          ).toISOString(),
        });
      },
      verified.credential.id,
    );
    return { session, id };
  }

  /** Recheck parent credential and session on every new action; never trust cached grants. */
  verifySession(session: string): VerifiedCredential {
    this.assertOpen();
    check(typeof session === 'string' && session.length <= 256);
    const match = /^mdbs_v1_([a-zA-Z0-9-]{36})_([a-zA-Z0-9_-]{43})$/.exec(session);
    const v = this.state.sessions.find((s) => s.id === match?.[1]);
    if (!v || !equalSecret(session, v.secretHash)) {
      throw new SecurityError('SECURITY_CREDENTIAL_INVALID');
    }
    if (v.revokedAt || v.accessEpoch !== this.state.accessEpoch) {
      throw new SecurityError('SECURITY_CREDENTIAL_REVOKED');
    }
    const c = this.resolveSessionParent(v);
    if (
      Date.parse(v.expiresAt) <= this.now() ||
      Date.parse(c.expiresAt) <= this.now() ||
      (c.validUntil && Date.parse(c.validUntil) <= this.now())
    ) {
      throw new SecurityError('SECURITY_CREDENTIAL_EXPIRED');
    }
    const p = this.state.principals.find((p) => p.id === v.principalId && p.enabled);
    if (!p) {
      throw new SecurityError('SECURITY_CREDENTIAL_REVOKED');
    }
    return {
      actor: {
        principalId: p.id,
        credentialId: c.id,
        ...(p.kind === 'application' ? { applicationId: p.id } : {}),
        identityTrust: 'verified',
      },
      credential: structuredClone(c),
      policyVersion: this.state.policyVersion,
      sessionParent: structuredClone(parentOf(v)),
    };
  }

  /** Cookie use requires the paired Origin and a proof bound to this exact session. */
  verifyBrowserSession(session: string, origin: string, csrf?: string): VerifiedBrowserSession {
    const verified = this.verifySession(session);
    const id = /^mdbs_v1_([a-zA-Z0-9-]{36})_/.exec(session)![1];
    const current = this.state.sessions.find((v) => v.id === id)!;
    if (!current.origin || current.origin !== securityOrigin(origin)) {
      throw new SecurityError('SECURITY_ORIGIN_DENIED');
    }
    const expected = hash(`modeldb-browser-csrf-v1:${session}`);
    if (csrf !== undefined && !equalSecret(csrf, hash(expected))) {
      throw new SecurityError('SECURITY_CSRF_REQUIRED');
    }
    return {
      ...verified,
      sessionExpiresAt: current.expiresAt,
      absoluteExpiresAt: current.absoluteExpiresAt ?? current.expiresAt,
      csrf: expected,
      ...(verified.sessionParent?.kind === 'local-management' ? { securityAdmin: true } : {}),
    };
  }

  /** Server-clock deadline for an idle authenticated stream; never extends its session. */
  accessRemainingMs(access: string): number {
    const verified = access.startsWith('mdbs_v1_')
      ? this.verifySession(access)
      : this.authenticate(access);
    const session = access.startsWith('mdbs_v1_')
      ? this.state.sessions.find((entry) => entry.id === access.split('_')[2])
      : undefined;
    return Math.max(
      0,
      Math.min(
        Date.parse(verified.credential.expiresAt),
        verified.credential.validUntil ? Date.parse(verified.credential.validUntil) : Infinity,
        session ? Date.parse(session.expiresAt) : Infinity,
      ) - this.now(),
    );
  }

  private browserEvent(
    action: string,
    credential: SecurityCredentialInfo,
    transport: 'http',
  ): DataSecurityEvent {
    return {
      version: 1,
      eventId: randomUUID(),
      timestampUtc: new Date(this.now()).toISOString(),
      category: 'management',
      action,
      result: 'succeeded',
      actor: {
        principalId: credential.principalId,
        credentialId: credential.id,
        identityTrust: 'verified',
      },
      resource: { credentialId: credential.id },
      source: { transport },
      policyVersion: this.state.policyVersion,
    };
  }

  private isLocalManagementCredential(id: string): boolean {
    if (this.state.version >= 3) {
      return this.state.credentials.some((c) => c.id === id && c.kind === 'local-management');
    }
    return (
      this.state.credentials.some((c) => c.id === id && c.kind === 'local-management') ||
      [...this.state.pairings, ...this.state.sessions].some(
        (entry) => entry.credentialId === id && parentOf(entry).kind === 'local-management',
      )
    );
  }

  /** Always project live grants from the correct namespace; never copy sibling API grants. */
  private resolveSessionParent(entry: Session | Pairing): SecurityCredentialInfo {
    assertSessionParent(this.state, entry, this.state.pairings.includes(entry as Pairing));
    const parent = parentOf(entry);
    let credential: SecurityCredentialInfo | undefined;
    if (parent.kind === 'registered-public-key') {
      const key = this.state.registration?.credentials.find((c) => c.id === parent.credentialId);
      const user = this.state.registration?.users.find((u) => u.id === parent.userId);
      if (key?.state !== 'active' || !user?.enabled) {
        throw new SecurityError('SECURITY_CREDENTIAL_REVOKED');
      }
      credential = {
        id: key.id,
        principalId: user.principalId,
        name: 'Registered public key',
        createdAt: key.createdAtUtc,
        expiresAt: ('absoluteExpiresAt' in entry && entry.absoluteExpiresAt) || entry.expiresAt,
        grants: structuredClone(key.grants ?? []),
      };
    } else {
      const c = this.state.credentials.find((c) => c.id === parent.credentialId);
      if (c) {
        credential = info(c);
      }
    }
    if (
      !credential ||
      !this.state.principals.some((p) => p.id === credential.principalId && p.enabled)
    ) {
      throw new SecurityError('SECURITY_CREDENTIAL_REVOKED');
    }
    this.assertCredentialUsable(credential);
    return credential;
  }

  private assertCredentialUsable(c: SecurityCredentialInfo): void {
    if (c.revokedAt) {
      throw new SecurityError('SECURITY_CREDENTIAL_REVOKED');
    }
    if (
      Date.parse(c.expiresAt) <= this.now() ||
      (c.validUntil && Date.parse(c.validUntil) <= this.now())
    ) {
      throw new SecurityError('SECURITY_CREDENTIAL_EXPIRED');
    }
  }

  /** Invalidate network access only; never touches IMK, DEK, or business Vaults. */
  resetAccess(): void {
    this.assertOpen();
    const affected = [
      ...this.state.credentials,
      ...(this.state.registration?.credentials ?? []),
    ].map((c) => c.id);
    this.commit('access.reset', (s) => {
      const at = new Date(this.now()).toISOString();
      s.credentials.forEach((c) => {
        c.revokedAt = at;
      });
      s.sessions.forEach((v) => {
        v.revokedAt = at;
      });
      for (const c of s.authentication?.challenges ?? []) {
        if (c.state === 'issued' || c.state === 'claimed') {
          c.state = 'rejected';
          c.finishedAtUtc = at;
        }
      }
      s.accessEpoch++;
      s.policyVersion++;
      for (const key of s.recipients?.keys ?? []) {
        if (key.state === 'active') {
          key.state = 'retired';
          key.retiredAtUtc = at;
        }
      }
      for (const challenge of s.recipients?.challenges ?? []) {
        if (challenge.state === 'issued') {
          challenge.state = 'rejected';
        }
      }
      if (s.registration) {
        resetRegistrationAccess(s.registration, this.now());
      }
    });
    this.notify(affected);
  }

  /** Record only validated public key references; secret bytes never enter the registry. */
  registerKeyReference(reference: VaultKeyReference): void {
    this.assertOpen();
    check(isVaultKeyReference(reference) && reference.instanceId === this.state.instanceId);
    if (
      this.state.keyReferences.some(
        (r) => r.keyId === reference.keyId && r.keyVersion === reference.keyVersion,
      )
    ) {
      return;
    }
    this.commit('key.reference.register', (s) => {
      check(s.keyReferences.length < 10000);
      s.keyReferences.push(structuredClone(reference));
    });
  }

  /** Record a rejected maintenance command using fixed action/reason fields only. */
  recordRejectedMaintenance(): void {
    this.commit('maintenance.reject', () => undefined, undefined, 'denied');
  }

  /** Persist a minimal access intent/result, with no parameters or business values. */
  recordAccess(
    actor: SecurityActor,
    database: string,
    result: 'started' | 'succeeded' | 'denied' | 'failed',
    transport: 'http' | 'websocket',
    requestId: string,
    action = 'data.execute',
    networkSource?: NetworkSource,
  ): void {
    check(ID.test(database) && ID.test(requestId) && /^[a-z.]{1,64}$/.test(action));
    this.commit(action, () => undefined, undefined, 'succeeded', {
      version: 1,
      eventId: randomUUID(),
      timestampUtc: new Date(this.now()).toISOString(),
      category: 'data',
      action,
      result,
      actor: structuredClone(actor),
      source: {
        transport,
        ...(networkSource
          ? {
              peerIp: networkSource.peerIp,
              clientIp: networkSource.clientIp,
              clientIpBasis: networkSource.clientIpBasis,
            }
          : {}),
      },
      resource: { database },
      requestId,
      policyVersion: this.state.policyVersion,
    });
  }

  /** Run one synchronous command with the SID already verified by the pipe broker. */
  withLocalActor<T>(sid: string, command: () => T): T {
    this.assertOpen();
    check(/^S-1-[0-9-]{1,180}$/.test(sid));
    const previous = this.actorId;
    const previousLocal = this.localActor;
    this.actorId = sid;
    this.localActor = true;
    try {
      return command();
    } finally {
      this.actorId = previous;
      this.localActor = previousLocal;
    }
  }

  /** Return a copy of the encrypted audit ledger for local maintenance and tests. */
  auditEvents(): readonly DataSecurityEvent[] {
    this.assertOpen();
    return structuredClone(this.state.events);
  }

  /** Return a bounded, newest-first audit page with non-sensitive aggregates. */
  auditPage(query: SecurityAuditQuery = {}): SecurityAuditPage {
    this.assertOpen();
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 50;
    check(Number.isSafeInteger(offset) && offset >= 0 && offset <= 1_000_000);
    check(Number.isSafeInteger(limit) && limit >= 1 && limit <= 200);
    const filtered = this.filteredAuditEvents(query);
    const byCategory: Record<DataSecurityEvent['category'], number> = {
      authentication: 0,
      network: 0,
      management: 0,
      data: 0,
    };
    const byResult: Record<DataSecurityEvent['result'], number> = {
      started: 0,
      succeeded: 0,
      denied: 0,
      failed: 0,
    };
    const ips = new Set<string>();
    let observedCount = 0,
      suppressedDetails = 0;
    for (const event of filtered) {
      const count = event.aggregation?.observedCount ?? 1;
      observedCount += count;
      suppressedDetails += event.aggregation?.suppressedDetails ?? 0;
      byCategory[event.category] += count;
      byResult[event.result] += count;
      if (event.source.clientIp) {
        ips.add(event.source.clientIp);
      }
    }
    return {
      version: 1,
      events: structuredClone(filtered.slice(offset, offset + limit)),
      total: filtered.length,
      offset,
      limit,
      hasMore: offset + limit < filtered.length,
      summary: {
        total: filtered.length,
        observedCount,
        savedDetails: filtered.length,
        suppressedDetails,
        byCategory,
        byResult,
        uniqueClientIps: ips.size,
      },
    };
  }

  /** Export the same metadata-only event contract as newline-delimited JSON. */
  auditNdjson(query: SecurityAuditQuery = {}): string {
    this.assertOpen();
    const events = this.filteredAuditEvents(query);
    return events.map((event) => JSON.stringify(event)).join('\n') + (events.length ? '\n' : '');
  }

  /** Record a successful, metadata-only export before returning its contents. */
  recordAuditExport(
    options: {
      readonly actor?: SecurityActor;
      readonly transport?: 'http' | 'local-ipc';
      readonly requestId?: string;
      readonly query?: SecurityAuditQuery;
      readonly networkSource?: NetworkSource;
    } = {},
  ): void {
    this.assertOpen();
    const affectedCount = this.filteredAuditEvents(options.query ?? {}).length;
    const transport = options.transport ?? 'local-ipc';
    const source: DataSecurityEvent['source'] = {
      transport,
      ...(options.networkSource
        ? {
            peerIp: options.networkSource.peerIp,
            clientIp: options.networkSource.clientIp,
            clientIpBasis: options.networkSource.clientIpBasis,
          }
        : {}),
    };
    this.commit('audit.export', () => undefined, undefined, 'succeeded', {
      version: 1,
      eventId: randomUUID(),
      timestampUtc: new Date(this.now()).toISOString(),
      category: 'management',
      action: 'audit.export',
      result: 'succeeded',
      ...(options.requestId ? { requestId: options.requestId } : {}),
      actor: structuredClone(
        options.actor ?? { principalId: this.actorId, identityTrust: 'verified' as const },
      ),
      source,
      policyVersion: this.state.policyVersion,
      affectedCount,
    });
  }

  private filteredAuditEvents(query: SecurityAuditQuery): DataSecurityEvent[] {
    for (const value of [query.fromUtc, query.toUtc]) {
      if (value !== undefined) {
        check(typeof value === 'string' && value.length > 0 && value.length <= 40);
      }
    }
    const dates = [query.fromUtc, query.toUtc].map((value) =>
      value === undefined ? undefined : Date.parse(value),
    );
    check(dates.every((value) => value === undefined || Number.isFinite(value)));
    check(dates[0] === undefined || dates[1] === undefined || dates[0] <= dates[1]);
    const categories = new Set<DataSecurityEvent['category']>([
      'authentication',
      'network',
      'management',
      'data',
    ]);
    const results = new Set<DataSecurityEvent['result']>([
      'started',
      'succeeded',
      'denied',
      'failed',
    ]);
    if (query.category !== undefined) {
      check(categories.has(query.category));
    }
    if (query.result !== undefined) {
      check(results.has(query.result));
    }
    if (query.action !== undefined) {
      check(typeof query.action === 'string' && /^[a-z.]{1,64}$/.test(query.action));
    }
    for (const value of [
      query.principalId,
      query.credentialId,
      query.database,
      query.requestId,
      query.clientIp,
    ]) {
      if (value !== undefined) {
        check(typeof value === 'string' && value.length > 0 && value.length <= 180);
      }
    }
    return this.state.events
      .filter((event) => {
        const timestamp = Date.parse(event.timestampUtc);
        return (
          (dates[0] === undefined || timestamp >= dates[0]) &&
          (dates[1] === undefined || timestamp <= dates[1]) &&
          (query.category === undefined || event.category === query.category) &&
          (query.action === undefined || event.action === query.action) &&
          (query.result === undefined || event.result === query.result) &&
          (query.principalId === undefined || event.actor.principalId === query.principalId) &&
          (query.credentialId === undefined || event.actor.credentialId === query.credentialId) &&
          (query.database === undefined || event.resource?.database === query.database) &&
          (query.requestId === undefined ||
            event.requestId === query.requestId ||
            event.aggregation?.sampleRequestIds.includes(query.requestId)) &&
          (query.clientIp === undefined || event.source.clientIp === query.clientIp)
        );
      })
      .sort((a, b) => Date.parse(b.timestampUtc) - Date.parse(a.timestampUtc));
  }

  private pruneExpiredAuditEvents(): void {
    const cutoff = this.now() - this.auditRetentionDays * DAY;
    const expiredCount = this.state.events.filter(
      (event) => Date.parse(event.timestampUtc) < cutoff,
    ).length;
    if (expiredCount === 0) {
      return;
    }
    this.commit('audit.retention.prune', () => undefined, undefined, 'succeeded', {
      version: 1,
      eventId: randomUUID(),
      timestampUtc: new Date(this.now()).toISOString(),
      category: 'management',
      action: 'audit.retention.prune',
      result: 'succeeded',
      actor: { principalId: this.actorId, identityTrust: 'verified' },
      source: { transport: 'local-ipc' },
      policyVersion: this.state.policyVersion,
      affectedCount: expiredCount,
    });
  }

  /** Subscribe to durable invalidation notifications, suitable for WS/cache consumers. */
  onInvalidation(
    listener: (event: { policyVersion: number; credentialIds: readonly string[] }) => void,
    credentialId?: string,
  ): () => void {
    this.assertOpen();
    const listeners = credentialId
      ? (this.credentialListeners.get(credentialId) ?? new Set())
      : this.listeners;
    if (credentialId) {
      this.credentialListeners.set(credentialId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (credentialId && !listeners.size) {
        this.credentialListeners.delete(credentialId);
      }
    };
  }

  /** Release the instance lease. */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.notify([]);
    this.listeners.clear();
    this.credentialListeners.clear();
    this.release?.();
  }

  private notify(credentialIds: readonly string[]): void {
    const listeners = new Set(this.listeners);
    const groups = credentialIds.length
      ? credentialIds.map((id) => this.credentialListeners.get(id) ?? [])
      : this.credentialListeners.values();
    for (const scoped of groups) {
      for (const listener of scoped) {
        listeners.add(listener);
      }
    }
    for (const listener of listeners) {
      try {
        listener({ policyVersion: this.state.policyVersion, credentialIds });
      } catch {
        console.error('[ModelDB] SECURITY_INVALIDATION_LISTENER_FAILED');
      }
    }
  }
  private assertOpen(): void {
    if (this.closed) {
      throw new SecurityError('SECURITY_CLOSED');
    }
  }
  private commit(
    action: string,
    change: (state: RegistryState) => void,
    credentialId?: string,
    result: DataSecurityEvent['result'] = 'succeeded',
    accessEvent?: DataSecurityEvent,
  ): void {
    this.assertOpen();
    const next = structuredClone(this.state);
    const cutoff = this.now() - this.auditRetentionDays * DAY;
    const previousEventCount = next.events.length;
    next.events = next.events.filter((event) => Date.parse(event.timestampUtc) >= cutoff);
    const expiredCount = previousEventCount - next.events.length;
    change(next);
    // Once an owner loses all active login credentials, an in-flight association cannot revive.
    for (const c of next.recipients?.challenges ?? []) {
      const user = next.registration!.users.find((u) => u.id === c.userId);
      if (
        c.state === 'issued' &&
        (!user?.enabled ||
          !next.principals.some((p) => p.id === user.principalId && p.enabled) ||
          !next.registration!.credentials.some(
            (k) => k.userId === c.userId && k.state === 'active',
          ))
      ) {
        c.state = 'rejected';
      }
    }
    next.revision++;
    if (expiredCount > 0 && action !== 'audit.retention.prune') {
      next.events.push({
        version: 1,
        eventId: randomUUID(),
        timestampUtc: new Date(this.now()).toISOString(),
        category: 'management',
        action: 'audit.retention.prune',
        result: 'succeeded',
        actor: { principalId: this.actorId, identityTrust: 'verified' },
        source: { transport: 'local-ipc' },
        policyVersion: next.policyVersion,
        affectedCount: expiredCount,
      });
    }
    next.events.push(
      accessEvent ?? {
        version: 1,
        eventId: randomUUID(),
        timestampUtc: new Date(this.now()).toISOString(),
        category: 'management',
        action,
        result,
        ...(result === 'denied' ? { reasonCode: 'SECURITY_INVALID_REQUEST' } : {}),
        actor: {
          principalId: this.actorId,
          identityTrust: 'verified',
        },
        ...(credentialId
          ? {
              resource:
                action === 'principal.create' ? { principalId: credentialId } : { credentialId },
            }
          : {}),
        source: { transport: 'local-ipc' },
        policyVersion: next.policyVersion,
        ...this.managementEvent,
      },
    );
    if (next.events.length > this.auditLimit) {
      throw new SecurityError('SECURITY_AUDIT_CAPACITY');
    }
    try {
      const plaintext = Buffer.from(JSON.stringify(next));
      let bytes: Buffer;
      try {
        bytes = Buffer.from(
          this.protector.protect(plaintext, `modeldb-registry-v1:${next.instanceId}`),
        );
      } finally {
        plaintext.fill(0);
      }
      writeAtomicFileSync(
        this.path,
        bytes,
        this.digest,
        (raw) => {
          this.decode(raw, next.instanceId);
        },
        this.onCommitPoint,
      );
      this.digest = fileDigest(bytes);
      this.state = next;
    } catch {
      this.close();
      throw new SecurityError('SECURITY_STORE_WRITE_FAILED');
    }
  }
  private decode(bytes: Buffer, instanceId: string): RegistryState {
    let plaintext: Buffer | undefined;
    try {
      if (bytes.length > 32 * 1024 * 1024) {
        throw new Error();
      }
      plaintext = this.protector.unprotect(
        bytes.toString('utf8'),
        `modeldb-registry-v1:${instanceId}`,
      );
      const s = JSON.parse(plaintext.toString('utf8')) as RegistryState;
      check(
        (s.version === 1 ||
          s.version === 2 ||
          s.version === 3 ||
          s.version === 4 ||
          s.version === 5) &&
          s.instanceId === instanceId &&
          ID.test(s.instanceId),
      );
      check(s.version >= 2 || s.registration === undefined);
      if (s.version >= 4) {
        assertAuthenticationLedger(s.authentication, instanceId);
      } else {
        check(s.authentication === undefined);
      }
      // Registries created before S4.2 have no pairing collection; normalize that
      // optional field in memory while keeping the encrypted format backward compatible.
      if (s.pairings === undefined) {
        s.pairings = [];
      }
      check(Array.isArray(s.pairings));
      check(
        [s.revision, s.policyVersion, s.accessEpoch].every((v) => Number.isSafeInteger(v) && v > 0),
      );
      check(
        Array.isArray(s.principals) &&
          s.principals.length <= 10000 &&
          new Set(s.principals.map((p) => p.id)).size === s.principals.length,
      );
      check(
        s.principals.every(
          (p) =>
            ID.test(p.id) &&
            typeof p.name === 'string' &&
            p.name.length <= 128 &&
            ['application', 'operator'].includes(p.kind) &&
            typeof p.enabled === 'boolean',
        ),
      );
      if (s.version >= 2) {
        assertRegistrationLedger(s.registration, instanceId, s.principals);
      }
      if (s.version === 5) {
        assertRecipientLedger(s.recipients, instanceId, s.registration!);
      } else {
        check(s.recipients === undefined);
      }
      check(
        Array.isArray(s.credentials) &&
          s.credentials.length <= 10000 &&
          new Set(s.credentials.map((c) => c.id)).size === s.credentials.length,
      );
      for (const c of s.credentials) {
        check(
          ID.test(c.id) &&
            s.principals.some((p) => p.id === c.principalId) &&
            HASH.test(c.secretHash),
        );
        check(
          typeof c.name === 'string' &&
            c.name.length <= 128 &&
            validDate(c.createdAt) &&
            validDate(c.expiresAt),
        );
        check(
          (c.revokedAt === undefined || validDate(c.revokedAt)) &&
            (c.validUntil === undefined || validDate(c.validUntil)),
        );
        grants(c.grants);
        check(
          s.version >= 3
            ? ['api-credential', 'local-management'].includes(c.kind!)
            : c.kind === undefined,
        );
        if (s.version >= 3) {
          check(
            Object.keys(c).every((key) =>
              [
                'id',
                'principalId',
                'name',
                'secretHash',
                'createdAt',
                'expiresAt',
                'grants',
                'revokedAt',
                'validUntil',
                'replacesId',
                'kind',
              ].includes(key),
            ),
          );
        }
        if (c.kind === 'local-management') {
          check(
            c.grants.length === 0 &&
              s.principals.some((p) => p.id === c.principalId && p.kind === 'operator'),
          );
        }
        check(!s.registration?.credentials.some((key) => key.id === c.id));
      }
      check(
        Array.isArray(s.sessions) &&
          s.sessions.length <= 10000 &&
          new Set(s.sessions.map((v) => v.id)).size === s.sessions.length,
      );
      check(
        s.sessions.every(
          (v) =>
            ID.test(v.id) &&
            HASH.test(v.secretHash) &&
            s.principals.some((p) => p.id === v.principalId) &&
            validDate(v.createdAt) &&
            validDate(v.expiresAt) &&
            (v.origin === undefined || securityOrigin(v.origin) === v.origin) &&
            (v.absoluteExpiresAt === undefined || validDate(v.absoluteExpiresAt)) &&
            (v.securityAdmin === undefined || typeof v.securityAdmin === 'boolean') &&
            Number.isSafeInteger(v.accessEpoch) &&
            v.accessEpoch > 0 &&
            (v.revokedAt === undefined || validDate(v.revokedAt)),
        ),
      );
      check(
        s.pairings.length <= 10000 &&
          new Set(s.pairings.map((v) => v.id)).size === s.pairings.length,
      );
      check(
        s.pairings.every(
          (v) =>
            ID.test(v.id) &&
            HASH.test(v.secretHash) &&
            ID.test(v.credentialId) &&
            validDate(v.createdAt) &&
            validDate(v.expiresAt) &&
            (v.origin === undefined ||
              (typeof v.origin === 'string' && securityOrigin(v.origin) === v.origin)) &&
            (v.securityAdmin === undefined || typeof v.securityAdmin === 'boolean') &&
            (v.usedAt === undefined || validDate(v.usedAt)),
        ),
      );
      for (const [entries, pairing] of [
        [s.sessions, false],
        [s.pairings, true],
      ] as const) {
        for (const entry of entries) {
          assertSessionParent(s, entry, pairing);
          if (s.version >= 3) {
            const allowed = [
              'id',
              'credentialId',
              'parent',
              'secretHash',
              'createdAt',
              'expiresAt',
              'origin',
              'securityAdmin',
              ...(pairing
                ? ['usedAt']
                : ['principalId', 'accessEpoch', 'revokedAt', 'absoluteExpiresAt']),
            ];
            check(Object.keys(entry).every((key) => allowed.includes(key)));
          }
        }
      }
      check(
        Array.isArray(s.keyReferences) &&
          s.keyReferences.length <= 10000 &&
          s.keyReferences.every((r) => isVaultKeyReference(r) && r.instanceId === instanceId),
      );
      check(
        Array.isArray(s.events) &&
          s.events.length <= this.auditLimit &&
          s.events.every(
            (e) =>
              e.version === 1 &&
              ID.test(e.eventId) &&
              validDate(e.timestampUtc) &&
              typeof e.action === 'string' &&
              /^[a-z.]{1,64}$/.test(e.action) &&
              ['started', 'succeeded', 'denied', 'failed'].includes(e.result) &&
              ['authentication', 'network', 'management', 'data'].includes(e.category) &&
              (e.plane === undefined || ['data', 'management'].includes(e.plane)) &&
              (e.actor?.identityTrust === 'verified' ||
                (e.actor?.identityTrust === 'unverified' &&
                  (e.category === 'network' ||
                    e.category === 'authentication' ||
                    (e.category === 'management' && e.action === 'network.ban')))) &&
              ['local-ipc', 'http', 'websocket'].includes(e.source?.transport) &&
              (e.source?.peerIp === undefined || typeof e.source.peerIp === 'string') &&
              (e.source?.clientIp === undefined || typeof e.source.clientIp === 'string') &&
              (e.source?.clientIpBasis === undefined ||
                ['socket', 'trusted-proxy'].includes(e.source.clientIpBasis)) &&
              (e.delivery === undefined ||
                (s.version === 5 &&
                  e.category === 'management' &&
                  e.action === 'recipient.delivery.sealed' &&
                  e.result === 'succeeded' &&
                  e.source.transport === 'local-ipc' &&
                  Object.keys(e.delivery).sort().join(',') ===
                    'fingerprint,keyVersion,kind,packageSha256,recipientKeyId,userId' &&
                  ID.test(e.delivery.recipientKeyId) &&
                  ID.test(e.delivery.userId) &&
                  Number.isSafeInteger(e.delivery.keyVersion) &&
                  e.delivery.keyVersion >= 1 &&
                  e.delivery.keyVersion <= 20 &&
                  /^[a-f0-9]{64}(?![\s\S])/.test(e.delivery.fingerprint) &&
                  /^[a-f0-9]{64}(?![\s\S])/.test(e.delivery.packageSha256) &&
                  ['backup', 'asset'].includes(e.delivery.kind))) &&
              (e.aggregation === undefined ||
                (e.actor.identityTrust === 'unverified' &&
                  e.result === 'denied' &&
                  ['network.reject', 'authentication.reject'].includes(e.action) &&
                  validDate(e.aggregation.windowStartUtc) &&
                  validDate(e.aggregation.firstSeenUtc) &&
                  validDate(e.aggregation.lastSeenUtc) &&
                  e.aggregation.firstSeenUtc <= e.aggregation.lastSeenUtc &&
                  e.aggregation.savedDetails === 1 &&
                  Number.isSafeInteger(e.aggregation.observedCount) &&
                  e.aggregation.observedCount > 0 &&
                  e.aggregation.observedCount <= MAX_AGGREGATED_OBSERVATIONS &&
                  e.aggregation.suppressedDetails === e.aggregation.observedCount - 1 &&
                  Array.isArray(e.aggregation.sampleRequestIds) &&
                  e.aggregation.sampleRequestIds.length <= 3 &&
                  e.aggregation.sampleRequestIds.every(
                    (id) => typeof id === 'string' && id.length <= 180,
                  ))),
          ),
      );
      return s;
    } catch {
      throw new SecurityError('SECURITY_STORE_INVALID');
    } finally {
      plaintext?.fill(0);
    }
  }
}

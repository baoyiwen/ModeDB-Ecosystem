import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import {
  acquireFileLeaseSync,
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
} from '@mode-db/shared';
import { LocalVaultKeyProvider } from './local-vault-key-provider.js';
import { WindowsSecretProtector, type SecretProtector } from './windows-secret-protector.js';
import { SecurityError } from './security-errors.js';
import { securityOrigin, isLoopbackAddress, type NetworkSource } from './network-policy.js';

interface Principal {
  id: string;
  name: string;
  kind: 'application' | 'operator';
  enabled: boolean;
}
type Credential = { -readonly [P in keyof SecurityCredentialInfo]: SecurityCredentialInfo[P] } & {
  secretHash: string;
};
interface Session {
  id: string;
  principalId: string;
  credentialId: string;
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
  secretHash: string;
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
  origin: string;
  securityAdmin?: boolean;
}
interface RegistryState {
  version: 1;
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
  private managementEvent?: Pick<DataSecurityEvent, 'actor' | 'source' | 'requestId'>;
  private readonly listeners = new Set<
    (event: { policyVersion: number; credentialIds: readonly string[] }) => void
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

  saveProtection(action: string, protection: SecurityProtectionState): void {
    this.commit(action, (state) => {
      state.protection = structuredClone(protection);
      state.policyVersion++;
    });
    this.notify([]);
  }

  recordSecurityEvent(event: DataSecurityEvent): void {
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
        const credential = this.state.credentials.find((item) => item.id === session.credentialId);
        const principal = this.state.principals.find((item) => item.id === session.principalId);
        return {
          id: session.id,
          principalId: session.principalId,
          credentialId: session.credentialId,
          createdAt: session.createdAt,
          expiresAt: session.expiresAt,
          ...(session.revokedAt ? { revokedAt: session.revokedAt } : {}),
          ...(session.origin ? { origin: session.origin } : {}),
          active: Boolean(
            credential &&
            principal?.enabled &&
            !session.revokedAt &&
            session.accessEpoch === this.state.accessEpoch &&
            Date.parse(session.expiresAt) > now &&
            Date.parse(credential.expiresAt) > now &&
            (!credential.validUntil || Date.parse(credential.validUntil) > now),
          ),
          securityAdmin: session.securityAdmin === true,
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
    if (!record || !equalSecret(token, record.secretHash)) {
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
  ): { code: string; id: string; expiresAt: string } {
    origin = browserOriginValue(origin);
    check(isLoopbackAddress(new URL(origin).hostname));
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
          createdAt: new Date(now).toISOString(),
          expiresAt: new Date(now + 8 * 3600000).toISOString(),
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
        });
      },
      credentialId,
    );
    return { code, id, expiresAt };
  }

  /** Only OS-issued active pairings/sessions can add an exact browser Origin. */
  allowsBrowserOrigin(origin: string): boolean {
    const now = this.now();
    const credentialUsable = (id: string): boolean => {
      const c = this.state.credentials.find((c) => c.id === id);
      return (
        !!c &&
        !c.revokedAt &&
        Date.parse(c.expiresAt) > now &&
        (!c.validUntil || Date.parse(c.validUntil) > now) &&
        this.state.principals.some((p) => p.id === c.principalId && p.enabled)
      );
    };
    return (
      this.state.pairings.some(
        (p) =>
          p.origin === origin &&
          !p.usedAt &&
          Date.parse(p.expiresAt) > now &&
          credentialUsable(p.credentialId),
      ) ||
      this.state.sessions.some(
        (s) =>
          s.origin === origin &&
          !s.revokedAt &&
          s.accessEpoch === this.state.accessEpoch &&
          Date.parse(s.expiresAt) > now &&
          credentialUsable(s.credentialId),
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
    check(Number.isFinite(lifetimeMinutes) && lifetimeMinutes > 0 && lifetimeMinutes <= 720);
    const credential = this.state.credentials.find((c) => c.id === pairing.credentialId);
    if (!credential) {
      throw new SecurityError('SECURITY_CREDENTIAL_REVOKED');
    }
    this.assertCredentialUsable(credential);
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
    const c = this.state.credentials.find((c) => c.id === v.credentialId);
    if (!c || c.revokedAt) {
      throw new SecurityError('SECURITY_CREDENTIAL_REVOKED');
    }
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
      credential: info(c),
      policyVersion: this.state.policyVersion,
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
      ...(current.securityAdmin ? { securityAdmin: true } : {}),
    };
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

  private assertCredentialUsable(c: Credential): void {
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
    const affected = this.state.credentials.map((c) => c.id);
    this.commit('access.reset', (s) => {
      const at = new Date(this.now()).toISOString();
      s.credentials.forEach((c) => {
        c.revokedAt = at;
      });
      s.sessions.forEach((v) => {
        v.revokedAt = at;
      });
      s.accessEpoch++;
      s.policyVersion++;
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
    this.actorId = sid;
    try {
      return command();
    } finally {
      this.actorId = previous;
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
    for (const event of filtered) {
      byCategory[event.category]++;
      byResult[event.result]++;
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
          (query.requestId === undefined || event.requestId === query.requestId) &&
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
  ): () => void {
    this.assertOpen();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Release the instance lease. */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.listeners.clear();
    this.release?.();
  }

  private notify(credentialIds: readonly string[]): void {
    for (const listener of this.listeners) {
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
      check(s.version === 1 && s.instanceId === instanceId && ID.test(s.instanceId));
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
            s.credentials.some((c) => c.id === v.credentialId && c.principalId === v.principalId) &&
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
            s.credentials.some((c) => c.id === v.credentialId) &&
            validDate(v.createdAt) &&
            validDate(v.expiresAt) &&
            (v.origin === undefined ||
              (typeof v.origin === 'string' && securityOrigin(v.origin) === v.origin)) &&
            (v.securityAdmin === undefined || typeof v.securityAdmin === 'boolean') &&
            (v.usedAt === undefined || validDate(v.usedAt)),
        ),
      );
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
                ['socket', 'trusted-proxy'].includes(e.source.clientIpBasis)),
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

/** Registration admission only. No approval, token/session issuance or business grants. */
import { createHash, randomBytes, randomUUID, timingSafeEqual, X509Certificate } from 'node:crypto';
import { generateRegistrationOptions, verifyRegistrationResponse } from '@simplewebauthn/server';
import { decodeAttestationObject, decodeCredentialPublicKey } from '@simplewebauthn/server/helpers';
import {
  DEVICE_REGISTRATION_CAPACITY_V1 as CAP,
  DEVICE_REGISTRATION_FORMAT as FORMAT,
  DeviceRegistrationContractError,
  assertDeviceRegistrationConnectionDescriptor,
  assertDeviceRegistrationBeginRequest,
  assertDeviceRegistrationBeginResponse,
  assertDeviceRegistrationCompleteRequest,
  assertDeviceRegistrationStatusRequest,
  type DataSecurityEvent,
  type DeviceRegistrationConnectionDescriptorV1,
  type DeviceRegistrationCapabilitiesV1,
  type DeviceRegistrationStatusResponseV1,
  type DeviceRegistrationBeginResponseV1,
  type DeviceRegistrationErrorCode,
} from '@mode-db/shared';
import type { NetworkSource } from './network-policy.js';
import type { SecurityRegistry } from './security-registry.js';
import type { RegistrationApplication, RegistrationLedger } from './registration-ledger.js';
import { SecurityError } from './security-errors.js';
import { recordPublicRejection } from './public-rejection-audit.js';

export interface RegistrationConfig {
  readonly descriptor: DeviceRegistrationConnectionDescriptorV1;
  readonly allowStorageMigration?: boolean;
}
export interface RegistrationRequestContext {
  readonly source: NetworkSource;
  readonly requestId: string;
  /** Recheck the original socket/headers and current policy after every asynchronous boundary. */
  readonly recheck: () => void;
}
type Action = 'capabilities' | 'descriptor' | 'begin' | 'complete' | 'status';
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const utc = (ms: number) => new Date(ms).toISOString();
function fail(suffix: string): never {
  throw new DeviceRegistrationContractError(
    `SECURITY_REGISTRATION_${suffix}` as DeviceRegistrationErrorCode,
  );
}
const sameHash = (a: string, b: string) =>
  timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

/** Bounded scheduler. Local maintenance never enters this public queue. */
class ProofSlots {
  active = 0;
  private waiting: Array<{ start: () => void; reject: () => void }> = [];
  get queued() {
    return this.waiting.length;
  }
  acquire(): Promise<() => void> {
    if (
      this.active >= CAP.maxConcurrentProofVerifications &&
      this.waiting.length >= CAP.maxQueuedProofVerifications
    ) {
      return Promise.reject(new DeviceRegistrationContractError('SECURITY_REGISTRATION_CAPACITY'));
    }
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const item = {
        start: () => {
          clearTimeout(timer);
          this.active++;
          let released = false;
          resolve(() => {
            if (released) {
              return;
            }
            released = true;
            this.active--;
            this.waiting.shift()?.start();
          });
        },
        reject: () => {
          clearTimeout(timer);
          reject(new DeviceRegistrationContractError('SECURITY_REGISTRATION_CAPACITY'));
        },
      };
      if (this.active < CAP.maxConcurrentProofVerifications) {
        item.start();
      } else {
        this.waiting.push(item);
        timer = setTimeout(() => {
          this.waiting = this.waiting.filter((value) => value !== item);
          item.reject();
        }, CAP.challengeTtlSeconds * 1000);
        timer.unref();
      }
    });
  }
  close() {
    const pending = this.waiting.splice(0);
    for (const item of pending) {
      item.reject();
    }
  }
}

export class RegistrationService {
  readonly descriptor?: DeviceRegistrationConnectionDescriptorV1;
  private clock = 0;
  private closed = false;
  private readonly slots = new ProofSlots();
  private readonly claims = new Set<string>();
  private readonly budgets = new Map<string, { window: number; count: number }>();
  private readonly polls = new Map<string, number>();
  private readonly sampled = new Map<Action, number>();
  private readonly observations = { observed: 0, saved: 0, suppressed: 0 };
  private readonly sweeper: ReturnType<typeof setInterval>;

  constructor(
    private readonly registry: SecurityRegistry,
    config?: RegistrationConfig,
    endpoint?: { publicBaseUrl?: string; mode: string; certificate?: string | Buffer },
    private readonly now: () => number = Date.now,
    /** Trusted embedding/test seam, never loaded from JSON. */
    private readonly verify = verifyRegistrationResponse,
  ) {
    if (config !== undefined) {
      if (
        !config ||
        Object.keys(config).some((key) => !['descriptor', 'allowStorageMigration'].includes(key)) ||
        (config.allowStorageMigration !== undefined &&
          typeof config.allowStorageMigration !== 'boolean')
      ) {
        throw new SecurityError('SECURITY_INVALID_CONFIG');
      }
      assertDeviceRegistrationConnectionDescriptor(config.descriptor);
      const d = structuredClone(config.descriptor);
      if (
        d.registrationMode === 'planned' ||
        d.instanceId !== registry.status().instanceId ||
        endpoint?.publicBaseUrl !== d.serverOrigin ||
        !['tls', 'proxy'].includes(endpoint.mode)
      ) {
        throw new SecurityError('SECURITY_INVALID_CONFIG');
      }
      if (
        Date.parse(d.issuedAtUtc) > this.time() ||
        (d.registrationMode === 'enabled' && Number(process.versions.node.split('.')[0]) < 22)
      ) {
        throw new SecurityError('SECURITY_INVALID_CONFIG');
      }
      if (endpoint.mode === 'tls') {
        try {
          if (!endpoint.certificate) {
            throw new Error();
          }
          const certificate = new X509Certificate(endpoint.certificate);
          if (
            certificate.checkHost(d.rpId, { subject: 'never' }) !== d.rpId ||
            Date.parse(certificate.validFrom) > this.time() ||
            Date.parse(certificate.validTo) <= this.time() ||
            (d.tls.mode === 'owner-pinned' &&
              digest(certificate.publicKey.export({ type: 'spki', format: 'der' })) !==
                d.tls.spkiSha256)
          ) {
            throw new Error();
          }
        } catch {
          throw new SecurityError('SECURITY_INVALID_CONFIG');
        }
      }
      Object.freeze(d.tls);
      this.descriptor = Object.freeze(d);
      if (
        d.registrationMode === 'enabled' &&
        Date.parse(d.expiresAtUtc) > this.time() &&
        registry.registrationStorageStatus().ledgerVersion === 1
      ) {
        if (config.allowStorageMigration !== true) {
          throw new SecurityError('SECURITY_INVALID_CONFIG');
        }
        registry.migrateRegistrationStorage(registry.status().revision);
      }
    }
    if (registry.registrationStorageStatus().ledgerVersion >= 2) {
      const store = registry.readRegistrationStorage();
      const mode =
        this.descriptor?.registrationMode === 'enabled' &&
        Date.parse(this.descriptor.expiresAtUtc) > this.time()
          ? 'enabled'
          : 'disabled';
      if (store.mode !== mode) {
        store.mode = mode;
        registry.commitRegistrationStorage(registry.status().revision, store);
      }
      // Recover abandoned claimed challenges, and reclaim elapsed records before serving requests.
      this.expire();
    }
    this.sweeper = setInterval(() => {
      try {
        if (this.registry.registrationStorageStatus().ledgerVersion < 2) {
          return;
        }
        // Expired admission must be persisted promptly. Finished ceremonies are already
        // unusable; collect their bounded garbage in the next public/recovery transaction
        // instead of starting a blocking DPAPI write while serving unrelated TLS traffic.
        const store = this.registry.readRegistrationStorage();
        const now = this.time();
        if (
          store.applications.some(
            (app) =>
              app.state === 'pending' &&
              (Date.parse(app.expiresAtUtc) <= now ||
                (!app.candidate &&
                  !this.claims.has(app.id) &&
                  !store.challenges.some(
                    (c) =>
                      c.applicationId === app.id &&
                      c.state === 'issued' &&
                      Date.parse(c.expiresAtUtc) > now,
                  ))),
          )
        ) {
          this.expire();
        }
      } catch {
        this.close();
      }
    }, 30000);
    this.sweeper.unref();
  }
  private time() {
    this.clock = Math.max(this.clock, this.now());
    return this.clock;
  }
  close() {
    this.closed = true;
    clearInterval(this.sweeper);
    this.slots.close();
  }
  metrics() {
    return {
      activeProofs: this.slots.active,
      queuedProofs: this.slots.queued,
      budgetRows: this.budgets.size,
      ...this.observations,
    };
  }
  private isEnabled() {
    return (
      !this.closed &&
      this.descriptor?.registrationMode === 'enabled' &&
      Date.parse(this.descriptor.expiresAtUtc) > this.time() &&
      this.registry.registrationStorageStatus().mode === 'enabled'
    );
  }
  private enabled() {
    if (!this.isEnabled()) {
      fail('DISABLED');
    }
    return this.descriptor!;
  }
  private count(key: string, limit: number) {
    const window = Math.floor(this.time() / 60000);
    for (const [id, item] of this.budgets) {
      if (item.window !== window) {
        this.budgets.delete(id);
      }
    }
    let item = this.budgets.get(key);
    if (!item) {
      if (this.budgets.size >= 10000) {
        fail('RATE_LIMITED');
      }
      item = { window, count: 0 };
      this.budgets.set(key, item);
    }
    if (item.count >= limit) {
      fail('RATE_LIMITED');
    }
    item.count++;
  }
  /** Called before parsing bodies; only socket/trusted-proxy attribution is accepted. */
  admit(action: Action, source: NetworkSource) {
    if (this.closed) {
      fail('DISABLED');
    }
    if (action === 'capabilities' || action === 'descriptor') {
      this.count('download:global', CAP.descriptorPerInstancePerMinute);
      this.count('download:' + source.clientIp, CAP.descriptorPerSourcePerMinute);
    } else if (action === 'status') {
      this.count('status:global', CAP.statusPollPerInstancePerMinute);
    } else {
      this.count(action + ':global', CAP.registrationStartPerInstancePerMinute);
      this.count(action + ':' + source.clientIp, CAP.registrationStartPerSourcePerMinute);
    }
  }
  capabilities(): DeviceRegistrationCapabilitiesV1 {
    return {
      format: FORMAT,
      version: 1,
      instanceId: this.registry.status().instanceId,
      mode: this.isEnabled() ? 'enabled' : 'disabled',
      protocolVersions: [1],
      proof: 'webauthn',
      userVerification: 'required',
      approval: 'local-operator',
      capacity: CAP,
    };
  }
  connection() {
    if (!this.descriptor) {
      fail('DISABLED');
    }
    if (Date.parse(this.descriptor.expiresAtUtc) <= this.time()) {
      fail('EXPIRED');
    }
    return {
      ...this.descriptor,
      registrationMode: this.isEnabled() ? ('enabled' as const) : ('disabled' as const),
    };
  }
  private event(
    action: string,
    context: RegistrationRequestContext,
    result: DataSecurityEvent['result'] = 'succeeded',
    code?: string,
  ): DataSecurityEvent {
    const s = context.source;
    return {
      version: 1,
      eventId: randomUUID(),
      timestampUtc: utc(this.time()),
      category: 'authentication',
      plane: 'data',
      action,
      result,
      reasonCode: code,
      requestId: context.requestId,
      actor: { identityTrust: 'unverified' },
      policyVersion: this.registry.status().policyVersion,
      source: {
        transport: 'http',
        peerIp: s.peerIp,
        clientIp: s.clientIp,
        clientIpBasis: s.clientIpBasis,
      },
    };
  }
  observe(action: Action, context: RegistrationRequestContext) {
    this.observations.observed++;
    const window = Math.floor(this.time() / 60000);
    if (this.sampled.get(action) === window) {
      this.observations.suppressed++;
      return;
    }
    this.registry.recordSecurityEvent(this.event('registration.' + action, context));
    this.sampled.set(action, window);
    this.observations.saved++;
  }
  deny(context: RegistrationRequestContext, code: string) {
    return recordPublicRejection(
      this.registry,
      this.event('authentication.reject', context, 'denied', code),
    );
  }
  private save(
    store: RegistrationLedger,
    action: string,
    context?: RegistrationRequestContext,
    result?: DataSecurityEvent['result'],
    code?: string,
    maintenanceEvent?: DataSecurityEvent,
  ) {
    this.registry.commitRegistrationStorage(
      this.registry.status().revision,
      store,
      context ? this.event(action, context, result, code) : undefined,
      maintenanceEvent,
    );
  }
  expire(context?: RegistrationRequestContext) {
    if (this.registry.registrationStorageStatus().ledgerVersion < 2) {
      return;
    }
    const store = this.registry.readRegistrationStorage(),
      now = this.time();
    if (this.reclaim(store, now)) {
      this.save(store, 'registration.expire', context);
    }
  }
  /** Prepare a legal transition; callers persist its audit atomically with their own write. */
  private reclaim(store: RegistrationLedger, now: number): boolean {
    const original = JSON.stringify(store);
    // Persist the terminal transition before collecting a request that expired while offline.
    // Deleting a previously pending request in the same write violates the storage contract.
    const pendingBefore = new Set(
      store.applications.filter((a) => a.state === 'pending').map((a) => a.id),
    );
    const challenges = new Map(
      store.challenges.map((challenge) => [challenge.applicationId, challenge]),
    );
    for (const app of store.applications) {
      const challenge = challenges.get(app.id);
      if (
        app.state === 'pending' &&
        (Date.parse(app.expiresAtUtc) <= now ||
          (!app.candidate &&
            !this.claims.has(app.id) &&
            (!challenge ||
              challenge.state !== 'issued' ||
              Date.parse(challenge.expiresAtUtc) <= now)))
      ) {
        app.state = Date.parse(app.expiresAtUtc) <= now ? 'expired' : 'rejected';
        app.decidedAtUtc = utc(now);
      }
      if (
        challenge?.state === 'issued' &&
        (Date.parse(challenge.expiresAtUtc) <= now || app.state !== 'pending')
      ) {
        challenge.state = Date.parse(challenge.expiresAtUtc) <= now ? 'expired' : 'rejected';
        challenge.finishedAtUtc = utc(now);
      }
    }
    store.challenges = store.challenges.filter(
      (c) => Date.parse(c.expiresAtUtc) > now || this.claims.has(c.applicationId),
    );
    store.applications = store.applications.filter(
      (a) =>
        a.state === 'pending' ||
        a.state === 'approved' ||
        pendingBefore.has(a.id) ||
        Date.parse(a.expiresAtUtc) > now,
    );
    const ids = new Set(store.applications.map((a) => a.id));
    for (const id of this.polls.keys()) {
      if (!ids.has(id)) {
        this.polls.delete(id);
      }
    }
    return JSON.stringify(store) !== original;
  }
  private capacity(store: RegistrationLedger) {
    if (
      store.applications.filter((a) => a.state === 'pending').length >=
        CAP.maxPendingApplications ||
      store.applications.length >= 11000 ||
      store.challenges.length >= CAP.maxOutstandingChallenges ||
      store.credentials.length >= CAP.maxCredentialsPerInstance
    ) {
      fail('CAPACITY');
    }
  }
  async begin(
    input: unknown,
    context: RegistrationRequestContext,
  ): Promise<DeviceRegistrationBeginResponseV1> {
    const d = this.enabled();
    assertDeviceRegistrationBeginRequest(input);
    if (input.instanceId !== d.instanceId) {
      fail('INSTANCE_MISMATCH');
    }
    if (input.deploymentDescriptorSha256 !== d.deploymentDescriptorSha256) {
      fail('CONFLICT');
    }
    const available = this.registry.readRegistrationStorage();
    this.reclaim(available, this.time());
    this.capacity(available);
    const registrationId = randomUUID(),
      challengeId = randomUUID(),
      handle = randomBytes(32);
    const secret = randomBytes(32),
      challenge = randomBytes(32);
    const epoch = this.registry.status().accessEpoch;
    const options = await generateRegistrationOptions({
      rpName: 'ModelDB',
      rpID: d.rpId,
      userID: handle,
      userName: registrationId,
      userDisplayName: input.displayName,
      challenge,
      timeout: 60000,
      attestationType: 'none',
      supportedAlgorithmIDs: [-7, -257],
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    });
    context.recheck();
    this.enabled();
    if (epoch !== this.registry.status().accessEpoch) {
      fail('CONFLICT');
    }
    const now = this.time(),
      store = this.registry.readRegistrationStorage();
    const reclaimed = this.reclaim(store, now);
    this.capacity(store);
    store.applications.push({
      id: registrationId,
      instanceId: d.instanceId,
      serverOrigin: d.serverOrigin,
      rpId: d.rpId,
      deploymentDescriptorSha256: d.deploymentDescriptorSha256,
      displayName: input.displayName,
      userHandle: handle.toString('base64url'),
      continuationSecretHash: digest(secret),
      createdAtUtc: utc(now),
      expiresAtUtc: utc(now + CAP.applicationTtlSeconds * 1000),
      state: 'pending',
    });
    store.challenges.push({
      id: challengeId,
      applicationId: registrationId,
      purpose: 'registration',
      challengeHash: digest(challenge),
      state: 'issued',
      createdAtUtc: utc(now),
      expiresAtUtc: utc(now + 60000),
    });
    const response: DeviceRegistrationBeginResponseV1 = {
      format: FORMAT,
      version: 1,
      registrationId,
      challengeId,
      instanceId: d.instanceId,
      deploymentDescriptorSha256: d.deploymentDescriptorSha256,
      continuationSecret: secret.toString('base64url'),
      challengeExpiresAtUtc: utc(now + 60000),
      publicKey: {
        rp: { id: d.rpId, name: 'ModelDB' },
        user: {
          id: handle.toString('base64url'),
          name: registrationId,
          displayName: input.displayName,
        },
        challenge: options.challenge,
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        timeout: 60000,
        attestation: 'none',
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      },
    };
    assertDeviceRegistrationBeginResponse(response);
    this.save(
      store,
      'registration.begin',
      context,
      undefined,
      undefined,
      reclaimed ? this.event('registration.expire', context) : undefined,
    );
    handle.fill(0);
    secret.fill(0);
    challenge.fill(0);
    return response;
  }
  private find(
    store: RegistrationLedger,
    input: { instanceId: string; registrationId: string; continuationSecret: string },
  ) {
    const app = store.applications.find((a) => a.id === input.registrationId);
    const hash = digest(Buffer.from(input.continuationSecret, 'base64url'));
    if (
      !app ||
      input.instanceId !== this.registry.status().instanceId ||
      !sameHash(app.continuationSecretHash, hash)
    ) {
      fail('NOT_FOUND');
    }
    return app;
  }
  private statusProjection(app: RegistrationApplication): DeviceRegistrationStatusResponseV1 {
    return {
      format: FORMAT,
      version: 1,
      registrationId: app.id,
      instanceId: app.instanceId,
      state: app.state,
      createdAtUtc: app.createdAtUtc,
      expiresAtUtc: app.expiresAtUtc,
      ...(app.state === 'approved' ? { approvedAtUtc: app.decidedAtUtc } : {}),
      ...(app.state === 'rejected'
        ? { rejectedAtUtc: app.decidedAtUtc, reasonCode: 'SECURITY_REGISTRATION_REJECTED' as const }
        : {}),
      ...(app.state === 'expired' ? { reasonCode: 'SECURITY_REGISTRATION_EXPIRED' as const } : {}),
    };
  }
  status(input: unknown, context: RegistrationRequestContext) {
    assertDeviceRegistrationStatusRequest(input);
    if (this.registry.registrationStorageStatus().ledgerVersion < 2) {
      fail('NOT_FOUND');
    }
    let app = this.find(this.registry.readRegistrationStorage(), input);
    const now = this.time();
    if (now - (this.polls.get(app.id) ?? -Infinity) < CAP.minStatusPollIntervalSeconds * 1000) {
      fail('RATE_LIMITED');
    }
    this.expire(context);
    const store = this.registry.readRegistrationStorage();
    app = this.find(store, input);
    this.polls.set(app.id, now);
    this.observe('status', context);
    return this.statusProjection(app);
  }
  async complete(input: unknown, context: RegistrationRequestContext) {
    const d = this.enabled();
    assertDeviceRegistrationCompleteRequest(input);
    if (input.deploymentDescriptorSha256 !== d.deploymentDescriptorSha256) {
      fail('CONFLICT');
    }
    const epoch = this.registry.status().accessEpoch;
    const release = await this.slots.acquire();
    let claimedId: string | undefined;
    try {
      context.recheck();
      this.enabled();
      this.expire(context);
      let store = this.registry.readRegistrationStorage();
      let app = this.find(store, input);
      if (
        app.serverOrigin !== d.serverOrigin ||
        app.rpId !== d.rpId ||
        app.deploymentDescriptorSha256 !== d.deploymentDescriptorSha256
      ) {
        fail('CONFLICT');
      }
      if (app.state !== 'pending' || app.candidate) {
        fail('CHALLENGE_REPLAYED');
      }
      const challenge = store.challenges.find(
        (c) => c.id === input.challengeId && c.applicationId === app.id,
      );
      if (!challenge) {
        fail('CHALLENGE_INVALID');
      }
      if (Date.parse(challenge.expiresAtUtc) <= this.time()) {
        fail('CHALLENGE_EXPIRED');
      }
      if (challenge.state !== 'issued') {
        fail('CHALLENGE_REPLAYED');
      }
      if (epoch !== this.registry.status().accessEpoch) {
        fail('CONFLICT');
      }
      challenge.state = 'consumed';
      challenge.finishedAtUtc = utc(this.time());
      this.save(store, 'registration.challenge.claim', context, 'started');
      claimedId = app.id;
      this.claims.add(app.id);
      let proof;
      try {
        const decoded = decodeAttestationObject(
          Buffer.from(input.credential.response.attestationObject, 'base64url'),
        );
        if (
          decoded.get('fmt') !== 'none' ||
          decoded.get('authData').byteLength > CAP.maxAuthenticatorDataBytes
        ) {
          fail('PROOF_INVALID');
        }
        proof = await this.verify({
          response: {
            ...input.credential,
            response: {
              ...input.credential.response,
              transports: input.credential.response.transports
                ? [...input.credential.response.transports]
                : undefined,
            },
          },
          expectedChallenge: (value) =>
            value.length === 43 &&
            /^[A-Za-z0-9_-]{43}$/.test(value) &&
            Buffer.from(value, 'base64url').toString('base64url') === value &&
            sameHash(challenge.challengeHash, digest(Buffer.from(value, 'base64url'))),
          expectedOrigin: d.serverOrigin,
          expectedRPID: d.rpId,
          expectedType: 'webauthn.create',
          requireUserPresence: true,
          requireUserVerification: true,
          supportedAlgorithmIDs: [-7, -257],
        });
        if (!proof.verified || !proof.registrationInfo.userVerified) {
          fail('PROOF_INVALID');
        }
      } catch {
        this.rejectClaim(app.id, context);
        fail('PROOF_INVALID');
      }
      context.recheck();
      this.enabled();
      const now = this.time();
      if (
        Date.parse(challenge.expiresAtUtc) <= now ||
        epoch !== this.registry.status().accessEpoch
      ) {
        this.rejectClaim(app.id, context);
        fail('CHALLENGE_EXPIRED');
      }
      store = this.registry.readRegistrationStorage();
      app = this.find(store, input);
      if (app.state !== 'pending' || app.candidate) {
        fail('CONFLICT');
      }
      const info = proof.registrationInfo,
        key = info.credential;
      if (
        key.id !== input.credential.rawId ||
        store.credentials.some((c) => c.rawId === key.id) ||
        store.applications.some(
          (a) => a.id !== app.id && a.state === 'pending' && a.candidate?.rawId === key.id,
        )
      ) {
        this.rejectClaim(app.id, context);
        fail('PROOF_INVALID');
      }
      const algorithm = decodeCredentialPublicKey(key.publicKey).get(3);
      if (algorithm !== -7 && algorithm !== -257) {
        this.rejectClaim(app.id, context);
        fail('PROOF_INVALID');
      }
      app.candidate = {
        rawId: key.id,
        publicKeyCose: Buffer.from(key.publicKey).toString('base64url'),
        algorithm,
        counter: key.counter,
        deviceType: info.credentialDeviceType,
        backedUp: info.credentialBackedUp,
      };
      app.verifiedAtUtc = utc(now);
      this.save(store, 'registration.complete', context);
      return this.statusProjection(app);
    } catch (error) {
      // A rejected post-verification policy/window check cannot leave a retryable proof.
      if (claimedId) {
        this.rejectClaim(claimedId, context);
      }
      throw error;
    } finally {
      if (claimedId) {
        this.claims.delete(claimedId);
      }
      release();
    }
  }
  private rejectClaim(id: string, context: RegistrationRequestContext) {
    const store = this.registry.readRegistrationStorage(),
      app = store.applications.find((a) => a.id === id);
    if (app?.state === 'pending' && !app.candidate) {
      app.state = Date.parse(app.expiresAtUtc) <= this.time() ? 'expired' : 'rejected';
      app.decidedAtUtc = utc(this.time());
      this.save(
        store,
        'registration.complete',
        context,
        'denied',
        'SECURITY_REGISTRATION_PROOF_INVALID',
      );
    }
  }
}

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import {
  DEVICE_AUTHENTICATION_CAPACITY_V1 as CAP,
  DEVICE_AUTHENTICATION_FORMAT as FORMAT,
  DeviceAuthenticationContractError,
  assertDeviceAuthenticationBeginRequest,
  assertDeviceAuthenticationBeginResponse,
  assertDeviceAuthenticationCompleteRequest,
  assertDeviceRegistrationConnectionDescriptor,
  type DeviceAuthenticationCapabilitiesV1,
  type DeviceAuthenticationErrorCode,
  type DeviceRegistrationConnectionDescriptorV1,
  type DataSecurityEvent,
} from '@mode-db/shared';
import type { SecurityRegistry } from './security-registry.js';
import type { RegistrationRequestContext } from './registration-service.js';
import type { NetworkSource } from './network-policy.js';
import { SecurityError } from './security-errors.js';
import { recordPublicRejection } from './public-rejection-audit.js';

export interface AuthenticationConfig {
  readonly enabled: boolean;
  readonly allowStorageMigration?: boolean;
}
const sha = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
function same(a: string, b: string) {
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
function fail(suffix: string): never {
  throw new DeviceAuthenticationContractError(
    `SECURITY_AUTHENTICATION_${suffix}` as DeviceAuthenticationErrorCode,
  );
}

/** Public proof work is bounded independently of the local management channel. */
export class AuthenticationService {
  readonly descriptor?: DeviceRegistrationConnectionDescriptorV1;
  private closed = false;
  private clock = 0;
  private active = 0;
  private waiting: Array<{ start: () => void; reject: () => void }> = [];
  private readonly budgets = new Map<string, { window: number; count: number }>();
  constructor(
    private readonly registry: SecurityRegistry,
    config?: AuthenticationConfig,
    descriptor?: DeviceRegistrationConnectionDescriptorV1,
    private readonly now: () => number = Date.now,
    /** Trusted embedding/test seam; never loaded from JSON. */
    private readonly verify = verifyAuthenticationResponse,
  ) {
    if (
      config !== undefined &&
      (!config ||
        Object.keys(config).some((k) => !['enabled', 'allowStorageMigration'].includes(k)) ||
        typeof config.enabled !== 'boolean' ||
        (config.allowStorageMigration !== undefined &&
          typeof config.allowStorageMigration !== 'boolean'))
    ) {
      throw new SecurityError('SECURITY_INVALID_CONFIG');
    }
    if (descriptor) {
      try {
        assertDeviceRegistrationConnectionDescriptor(descriptor);
        const copy = structuredClone(descriptor);
        Object.freeze(copy.tls);
        this.descriptor = Object.freeze(copy);
      } catch {
        throw new SecurityError('SECURITY_INVALID_CONFIG');
      }
    }
    if (config?.enabled) {
      if (
        !descriptor ||
        descriptor.instanceId !== registry.status().instanceId ||
        Number(process.versions.node.split('.')[0]) < 22
      ) {
        throw new SecurityError('SECURITY_INVALID_CONFIG');
      }
      if (registry.registrationStorageStatus().ledgerVersion < 4) {
        if (config.allowStorageMigration !== true) {
          throw new SecurityError('SECURITY_INVALID_CONFIG');
        }
        registry.migrateAuthenticationStorage(registry.status().revision);
      }
    }
    this.configured = config?.enabled === true;
    // A restarted service cannot continue any unfinished browser ceremony.
    registry.recoverAuthenticationChallenges();
  }
  private readonly configured: boolean;
  private time() {
    this.clock = Math.max(this.clock, this.now());
    return this.clock;
  }
  close() {
    this.closed = true;
    for (const item of this.waiting.splice(0)) {
      item.reject();
    }
  }
  metrics() {
    return {
      activeProofs: this.active,
      queuedProofs: this.waiting.length,
      budgetRows: this.budgets.size,
    };
  }
  capabilities(): DeviceAuthenticationCapabilitiesV1 {
    return {
      format: FORMAT,
      version: 1,
      instanceId: this.registry.status().instanceId,
      mode: this.configured && !this.closed ? 'enabled' : 'disabled',
      userVerification: 'required',
      capacity: CAP,
      ...(this.descriptor
        ? {
            deployment: {
              serverOrigin: this.descriptor.serverOrigin,
              rpId: this.descriptor.rpId,
              deploymentDescriptorSha256: this.descriptor.deploymentDescriptorSha256,
            },
          }
        : {}),
    };
  }
  private enabled() {
    if (!this.configured || this.closed || !this.descriptor) {
      fail('DISABLED');
    }
    return this.descriptor;
  }
  admit(action: 'capabilities' | 'begin' | 'complete', source: NetworkSource) {
    const window = Math.floor(this.time() / 60000);
    for (const [key, row] of this.budgets) {
      if (row.window !== window) {
        this.budgets.delete(key);
      }
    }
    const sourceLimit =
      action === 'complete' ? CAP.completePerSourcePerMinute : CAP.beginPerSourcePerMinute;
    const totalLimit =
      action === 'complete' ? CAP.completePerInstancePerMinute : CAP.beginPerInstancePerMinute;
    for (const [key, limit] of [
      [action + ':global', totalLimit],
      [action + ':' + source.clientIp, sourceLimit],
    ] as const) {
      let row = this.budgets.get(key);
      if (!row) {
        if (this.budgets.size >= 10000) {
          fail('RATE_LIMITED');
        }
        row = { window, count: 0 };
        this.budgets.set(key, row);
      }
      if (row.count >= limit) {
        fail('RATE_LIMITED');
      }
      row.count++;
    }
  }
  event(
    context: RegistrationRequestContext,
    action: string,
    result: DataSecurityEvent['result'] = 'succeeded',
    code?: string,
  ): DataSecurityEvent {
    const s = context.source;
    return {
      version: 1,
      eventId: randomUUID(),
      timestampUtc: new Date(this.time()).toISOString(),
      category: 'authentication',
      plane: 'data',
      action,
      result,
      ...(code ? { reasonCode: code } : {}),
      requestId: context.requestId,
      actor: { identityTrust: 'unverified' },
      source: {
        transport: 'http',
        peerIp: s.peerIp,
        clientIp: s.clientIp,
        clientIpBasis: s.clientIpBasis,
      },
      policyVersion: this.registry.status().policyVersion,
    };
  }
  deny(context: RegistrationRequestContext, code: string) {
    return recordPublicRejection(
      this.registry,
      this.event(context, 'authentication.reject', 'denied', code),
    );
  }
  private binding(input: { instanceId: string; deploymentDescriptorSha256: string }) {
    const d = this.enabled();
    if (input.instanceId !== d.instanceId) {
      fail('INSTANCE_MISMATCH');
    }
    if (input.deploymentDescriptorSha256 !== d.deploymentDescriptorSha256) {
      fail('DEPLOYMENT_MISMATCH');
    }
    return d;
  }
  async begin(input: unknown, context: RegistrationRequestContext) {
    assertDeviceAuthenticationBeginRequest(input);
    const d = this.binding(input);
    context.recheck();
    const challenge = randomBytes(32),
      secret = randomBytes(32).toString('base64url');
    const options = await generateAuthenticationOptions({
      rpID: d.rpId,
      challenge,
      timeout: 60000,
      userVerification: 'required',
      allowCredentials: input.rawId ? [{ id: input.rawId }] : [],
    });
    const publicKey = {
      challenge: options.challenge,
      rpId: d.rpId,
      timeout: 60000 as const,
      userVerification: 'required' as const,
      allowCredentials: options.allowCredentials ?? [],
    };
    context.recheck();
    this.binding(input);
    const at = this.time();
    const response = {
      format: FORMAT,
      version: 1 as const,
      instanceId: d.instanceId,
      deploymentDescriptorSha256: d.deploymentDescriptorSha256,
      challengeId: randomUUID(),
      expiresAtUtc: new Date(at + 60000).toISOString(),
      publicKey,
    };
    assertDeviceAuthenticationBeginResponse(response);
    this.registry.issueAuthenticationChallenge(
      {
        id: response.challengeId,
        instanceId: d.instanceId,
        serverOrigin: d.serverOrigin,
        rpId: d.rpId,
        deploymentDescriptorSha256: d.deploymentDescriptorSha256,
        accessEpoch: this.registry.status().accessEpoch,
        challengeHash: sha(challenge),
        browserHash: sha(secret),
        ...(input.rawId ? { rawIdHash: sha(input.rawId) } : {}),
        state: 'issued',
        createdAtUtc: new Date(at).toISOString(),
        expiresAtUtc: response.expiresAtUtc,
      },
      this.event(context, 'authentication.begin'),
    );
    return { response, ceremonySecret: secret };
  }
  private acquire(): Promise<() => void> {
    if (this.active >= CAP.maxConcurrentProofs && this.waiting.length >= CAP.maxQueuedProofs) {
      fail('CAPACITY');
    }
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const item = {
        start: () => {
          clearTimeout(timer);
          this.active++;
          let done = false;
          resolve(() => {
            if (done) {
              return;
            }
            done = true;
            this.active--;
            this.waiting.shift()?.start();
          });
        },
        reject: () => {
          clearTimeout(timer);
          reject(new DeviceAuthenticationContractError('SECURITY_AUTHENTICATION_CAPACITY'));
        },
      };
      if (this.active < CAP.maxConcurrentProofs) {
        item.start();
      } else {
        this.waiting.push(item);
        timer = setTimeout(() => {
          this.waiting = this.waiting.filter((i) => i !== item);
          item.reject();
        }, 60000);
        timer.unref();
      }
    });
  }
  private async verifyBeforeExpiry(
    options: Parameters<typeof verifyAuthenticationResponse>[0],
    expiresAt: string,
  ) {
    const remaining = Date.parse(expiresAt) - this.time();
    if (remaining <= 0) {
      fail('CHALLENGE_EXPIRED');
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.verify(options),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new DeviceAuthenticationContractError('SECURITY_AUTHENTICATION_CHALLENGE_EXPIRED'),
              ),
            Math.min(remaining, 60000),
          );
          timer.unref();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async complete(
    input: unknown,
    ceremonySecret: string | undefined,
    context: RegistrationRequestContext,
  ) {
    assertDeviceAuthenticationCompleteRequest(input);
    const d = this.binding(input);
    context.recheck();
    const c = this.registry.readAuthenticationChallenge(input.challengeId);
    if (
      !c ||
      !ceremonySecret ||
      !/^[A-Za-z0-9_-]{43}$/.test(ceremonySecret) ||
      !same(c.browserHash, sha(ceremonySecret))
    ) {
      fail('PROOF_INVALID');
    }
    if (c.state !== 'issued') {
      fail('CHALLENGE_REPLAYED');
    }
    if (
      Date.parse(c.expiresAtUtc) <= this.time() ||
      c.accessEpoch !== this.registry.status().accessEpoch
    ) {
      fail('CHALLENGE_EXPIRED');
    }
    if (
      c.serverOrigin !== d.serverOrigin ||
      c.rpId !== d.rpId ||
      c.deploymentDescriptorSha256 !== d.deploymentDescriptorSha256
    ) {
      fail('DEPLOYMENT_MISMATCH');
    }
    // Claim durably before waiting or performing asynchronous signature work.
    this.registry.claimAuthenticationChallenge(c.id, this.event(context, 'authentication.claim'));
    let release: (() => void) | undefined;
    let unsubscribe: (() => void) | undefined;
    let invalidated = false;
    try {
      const { key, app } = this.registry.authenticationKey(input.credential.rawId);
      // Observe before the queue's first await. Disable/enable must not revive an in-flight proof.
      // Reductions keep the identity active; the final transaction resolves its latest grants.
      unsubscribe = this.registry.onInvalidation(() => {
        try {
          this.registry.authenticationKey(key.rawId);
        } catch {
          invalidated = true;
        }
      }, key.id);
      release = await this.acquire();
      if (invalidated) {
        fail('PROOF_INVALID');
      }
      context.recheck();
      this.binding(input);
      const userHandle = input.credential.response.userHandle;
      if (
        app.serverOrigin !== d.serverOrigin ||
        app.rpId !== d.rpId ||
        (c.rawIdHash && !same(c.rawIdHash, sha(key.rawId))) ||
        (!c.rawIdHash && !userHandle) ||
        (userHandle && userHandle !== app.userHandle)
      ) {
        fail('PROOF_INVALID');
      }
      const client = JSON.parse(
        Buffer.from(input.credential.response.clientDataJSON, 'base64url').toString('utf8'),
      );
      if (
        !client ||
        (client.crossOrigin !== undefined && client.crossOrigin !== false) ||
        client.topOrigin !== undefined
      ) {
        fail('PROOF_INVALID');
      }
      const proof = await this.verifyBeforeExpiry(
        {
          response: {
            ...input.credential,
            clientExtensionResults: {},
            response: { ...input.credential.response, userHandle: userHandle ?? undefined },
          },
          expectedChallenge: (value) =>
            value.length === 43 &&
            Buffer.from(value, 'base64url').toString('base64url') === value &&
            same(sha(Buffer.from(value, 'base64url')), c.challengeHash),
          expectedOrigin: d.serverOrigin,
          expectedRPID: d.rpId,
          expectedType: 'webauthn.get',
          requireUserVerification: true,
          credential: {
            id: key.rawId,
            publicKey: Buffer.from(key.publicKeyCose, 'base64url'),
            counter: key.deviceType === 'multiDevice' ? 0 : key.counter,
          },
        },
        c.expiresAtUtc,
      );
      if (
        invalidated ||
        !proof.verified ||
        !proof.authenticationInfo.userVerified ||
        proof.authenticationInfo.credentialDeviceType !== key.deviceType ||
        (key.deviceType === 'singleDevice' && proof.authenticationInfo.credentialBackedUp)
      ) {
        fail('PROOF_INVALID');
      }
      context.recheck();
      this.binding(input);
      if (Date.parse(c.expiresAtUtc) <= this.time()) {
        fail('CHALLENGE_EXPIRED');
      }
      return this.registry.completeAuthentication(
        c.id,
        key.rawId,
        proof.authenticationInfo.newCounter,
        proof.authenticationInfo.credentialBackedUp,
        this.event(context, 'authentication.login'),
      );
    } catch (error) {
      try {
        this.registry.rejectAuthenticationChallenge(
          c.id,
          this.event(
            context,
            'authentication.finish',
            'denied',
            'SECURITY_AUTHENTICATION_PROOF_INVALID',
          ),
        );
      } catch {
        throw error;
      }
      if (error instanceof DeviceAuthenticationContractError || error instanceof SecurityError) {
        throw error;
      }
      fail('PROOF_INVALID');
    } finally {
      unsubscribe?.();
      release?.();
    }
  }
}

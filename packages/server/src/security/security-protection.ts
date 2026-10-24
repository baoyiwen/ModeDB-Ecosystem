import { randomUUID } from 'node:crypto';
import type {
  DataSecurityEvent,
  SecurityActor,
  SecurityPlane,
  SecurityProtectionConfig,
  SecurityProtectionPreview,
  SecurityProtectionState,
  SecuritySourcePolicy,
} from '@mode-db/shared';
import type { SecurityRegistry } from './security-registry.js';
import type { SecurityNetworkPolicy } from './network-policy.js';
import { sourceMatches, validateSourcePolicy, type NetworkSource } from './network-policy.js';
import { SecurityError } from './security-errors.js';

export const DEFAULT_SECURITY_RATE: SecurityProtectionConfig['rate'] = {
  windowSeconds: 60,
  dataRequests: 1000,
  managementRequests: 240,
  principalRequests: 1000,
  authenticationFailures: 20,
  autoBan: false,
  banSeconds: 600,
  exemptManagementSources: [],
};

function requireValid(condition: unknown): asserts condition {
  if (!condition) {
    throw new SecurityError('SECURITY_INVALID_REQUEST');
  }
}

export function validateProtectionConfig(value: SecurityProtectionConfig): void {
  requireValid(value && typeof value === 'object' && !Array.isArray(value));
  requireValid(Object.keys(value).every((key) => ['data', 'management', 'rate'].includes(key)));
  validateSourcePolicy(value.data);
  validateSourcePolicy(value.management);
  const r = value.rate;
  requireValid(r && typeof r === 'object' && !Array.isArray(r));
  requireValid(
    Object.keys(r).length === 8 && Object.keys(r).every((key) => key in DEFAULT_SECURITY_RATE),
  );
  for (const key of [
    'dataRequests',
    'managementRequests',
    'principalRequests',
    'authenticationFailures',
  ] as const) {
    requireValid(Number.isSafeInteger(r[key]) && r[key] >= 1 && r[key] <= 100000);
  }
  requireValid(
    Number.isSafeInteger(r.windowSeconds) && r.windowSeconds >= 1 && r.windowSeconds <= 3600,
  );
  requireValid(Number.isSafeInteger(r.banSeconds) && r.banSeconds >= 1 && r.banSeconds <= 3600);
  requireValid(typeof r.autoBan === 'boolean');
  requireValid(Array.isArray(r.exemptManagementSources) && r.exemptManagementSources.length <= 100);
  for (const source of r.exemptManagementSources) {
    sourceMatches(source, '127.0.0.1');
  }
}

function allowed(policy: SecuritySourcePolicy, ip: string, now: number): boolean {
  const active = (rule: NonNullable<SecuritySourcePolicy['allow']>[number]) =>
    (rule.expiresAt === undefined || Date.parse(rule.expiresAt) > now) &&
    sourceMatches(rule.source, ip);
  return (
    !(policy.deny ?? []).some(active) &&
    (policy.allowListEnabled === false || (policy.allow ?? []).some(active))
  );
}

/** One durable policy authority for HTTP, WS and OS-local repair. Windows are bounded and volatile. */
export class SecurityProtection {
  private state: SecurityProtectionState;
  private readonly windows = new Map<string, { start: number; count: number }>();
  private readonly timer: ReturnType<typeof setInterval>;
  private clock: number;
  private sweeping = false;
  private readonly previews = new Map<
    string,
    { config: string; revision: number; expires: number; actor: string }
  >();

  constructor(
    private readonly registry: SecurityRegistry,
    private readonly network: SecurityNetworkPolicy,
    private readonly now: () => number = Date.now,
  ) {
    const stored = registry.protectionState();
    this.state = stored ?? {
      version: 1,
      revision: 1,
      clockUtc: new Date(now()).toISOString(),
      config: { ...network.sourcePolicies(), rate: DEFAULT_SECURITY_RATE },
      bans: [],
    };
    this.validateState();
    this.clock = Math.max(now(), Date.parse(this.state.clockUtc));
    if (!stored) {
      registry.saveProtection('network.initialize', this.state);
    }
    network.setSourcePolicies(this.state.config);
    network.setProtectionCheck((source, plane) => this.check(source, plane));
    this.sweep();
    this.timer = setInterval(() => {
      try {
        this.sweep();
      } catch {
        /* Failed durable maintenance remains fail-closed at the next boundary. */
      }
    }, 1000);
    this.timer.unref();
  }

  close(): void {
    clearInterval(this.timer);
  }

  snapshot(): SecurityProtectionState {
    this.sweep();
    return structuredClone(this.state);
  }

  preview(config: SecurityProtectionConfig, current?: NetworkSource): SecurityProtectionPreview {
    this.sweep();
    validateProtectionConfig(config);
    for (const [id, preview] of this.previews) {
      if (preview.expires <= this.time()) {
        this.previews.delete(id);
      }
    }
    requireValid(this.previews.size < 100);
    const id = randomUUID();
    const expires = this.time() + 120000;
    this.previews.set(id, {
      config: JSON.stringify(config),
      revision: this.state.revision,
      expires,
      actor: this.registry.managementActorId(),
    });
    const connections = [
      ...this.network.activeConnections(),
      ...(current ? [{ clientIp: current.clientIp, plane: 'management' as const }] : []),
    ];
    return {
      id,
      expiresAt: new Date(expires).toISOString(),
      revision: this.state.revision,
      connections: connections.map((entry) => ({
        ...entry,
        allowed: allowed(config[entry.plane], entry.clientIp, this.time()),
      })),
    };
  }

  apply(
    config: SecurityProtectionConfig,
    revision: number,
    previewId: string,
  ): SecurityProtectionState {
    this.sweep();
    validateProtectionConfig(config);
    requireValid(Number.isSafeInteger(revision));
    const preview = this.previews.get(previewId);
    if (
      !preview ||
      preview.expires <= this.time() ||
      preview.revision !== revision ||
      preview.actor !== this.registry.managementActorId() ||
      preview.config !== JSON.stringify(config)
    ) {
      throw new SecurityError('SECURITY_POLICY_CONFLICT');
    }
    if (revision !== this.state.revision || this.state.pending) {
      throw new SecurityError('SECURITY_POLICY_CONFLICT');
    }
    // Never accept caller-supplied provenance as verified metadata.
    const normalized = (policy: SecuritySourcePolicy): SecuritySourcePolicy => ({
      allowListEnabled: policy.allowListEnabled !== false,
      allow: (policy.allow ?? []).map(({ id, source, expiresAt, reason }) => ({
        id,
        source,
        expiresAt,
        reason,
        createdAt: new Date(this.time()).toISOString(),
        createdBy: this.registry.managementActorId(),
      })),
      deny: (policy.deny ?? []).map(({ id, source, expiresAt, reason }) => ({
        id,
        source,
        expiresAt,
        reason,
        createdAt: new Date(this.time()).toISOString(),
        createdBy: this.registry.managementActorId(),
      })),
    });
    this.previews.delete(previewId);
    this.save('network.apply', {
      ...this.state,
      config: {
        data: normalized(config.data),
        management: normalized(config.management),
        rate: config.rate,
      },
      pending: {
        id: randomUUID(),
        expiresAt: new Date(this.time() + 120000).toISOString(),
        previous: this.state.config,
      },
    });
    return this.snapshot();
  }

  confirm(id: string): SecurityProtectionState {
    this.sweep();
    if (!this.state.pending || id !== this.state.pending.id) {
      throw new SecurityError('SECURITY_POLICY_CONFLICT');
    }
    const { pending, ...rest } = this.state;
    this.save('network.confirm', { ...rest, previous: pending.previous });
    return this.snapshot();
  }

  rollback(revision: number): SecurityProtectionState {
    this.sweep();
    requireValid(Number.isSafeInteger(revision));
    if (revision !== this.state.revision) {
      throw new SecurityError('SECURITY_POLICY_CONFLICT');
    }
    const config = this.state.pending?.previous ?? this.state.previous;
    if (!config) {
      throw new SecurityError('SECURITY_NOT_FOUND');
    }
    const { pending: _pending, previous: _previous, ...rest } = this.state;
    this.save('network.rollback', { ...rest, config });
    return this.snapshot();
  }

  unban(id: string): SecurityProtectionState {
    this.sweep();
    requireValid(this.state.bans.some((ban) => ban.id === id));
    this.save('network.unban', {
      ...this.state,
      bans: this.state.bans.filter((ban) => ban.id !== id),
    });
    return this.snapshot();
  }

  /** Called repeatedly at queued execution boundaries, without charging the same request twice. */
  check(source: NetworkSource, plane: SecurityPlane): void {
    this.sweep();
    if (this.state.bans.some((ban) => ban.plane === plane && ban.source === source.clientIp)) {
      throw new SecurityError('SECURITY_TEMPORARILY_BANNED');
    }
  }

  consume(source: NetworkSource, plane: SecurityPlane, principalId?: string): void {
    this.sweep();
    const limit = principalId
      ? this.state.config.rate.principalRequests
      : plane === 'data'
        ? this.state.config.rate.dataRequests
        : this.state.config.rate.managementRequests;
    const key = `${principalId ? 'principal' : 'source'}|${plane}|${principalId ?? source.clientIp}`;
    if (this.count(key) > limit) {
      throw new SecurityError('SECURITY_RATE_LIMITED');
    }
  }

  authenticationFailed(source: NetworkSource, plane: SecurityPlane): void {
    this.sweep();
    const rate = this.state.config.rate;
    const count = this.count(`authentication|${plane}|${source.clientIp}`);
    // One observation at the threshold, never a permanent user/account lock.
    if (count !== rate.authenticationFailures) {
      return;
    }
    if (
      !rate.autoBan ||
      (plane === 'management' &&
        rate.exemptManagementSources.some((ip) => sourceMatches(ip, source.clientIp)))
    ) {
      this.event(
        'network.authentication.threshold',
        'denied',
        source,
        undefined,
        count,
        undefined,
        plane,
      );
      return;
    }
    if (this.state.bans.length >= 1000) {
      throw new SecurityError('SECURITY_RATE_LIMITED');
    }
    this.save(
      'network.ban',
      {
        ...this.state,
        bans: [
          ...this.state.bans,
          {
            id: randomUUID(),
            source: source.clientIp,
            plane,
            createdAt: new Date(this.time()).toISOString(),
            expiresAt: new Date(this.time() + rate.banSeconds * 1000).toISOString(),
            reason: 'authentication-failures',
          },
        ],
      },
      source,
    );
  }

  event(
    action: string,
    result: DataSecurityEvent['result'],
    source: NetworkSource,
    reasonCode?: string,
    affectedCount?: number,
    actor?: SecurityActor,
    plane: SecurityPlane = 'data',
    transport: 'http' | 'websocket' = 'http',
    requestId = randomUUID(),
  ): void {
    this.registry.recordSecurityEvent({
      version: 1,
      eventId: randomUUID(),
      timestampUtc: new Date(this.time()).toISOString(),
      category: action.startsWith('authentication.') ? 'authentication' : 'network',
      plane,
      requestId,
      action,
      result,
      reasonCode,
      affectedCount,
      ruleId: this.network.matchedRule(source, plane),
      actor: actor ?? { identityTrust: 'unverified' },
      source: {
        transport,
        peerIp: source.peerIp,
        clientIp: source.clientIp,
        clientIpBasis: source.clientIpBasis,
      },
      policyVersion: this.registry.status().policyVersion,
    });
  }

  retryAfter(source?: NetworkSource, plane?: SecurityPlane): number {
    const expiry = this.state.bans.find(
      (ban) => ban.plane === plane && ban.source === source?.clientIp,
    )?.expiresAt;
    return expiry
      ? Math.max(1, Math.ceil((Date.parse(expiry) - this.time()) / 1000))
      : this.state.config.rate.windowSeconds;
  }

  private count(key: string): number {
    const now = this.time();
    const window = this.state.config.rate.windowSeconds * 1000;
    for (const [id, entry] of this.windows) {
      if (now - entry.start >= window) {
        this.windows.delete(id);
      }
    }
    let entry = this.windows.get(key);
    if (!entry) {
      if (this.windows.size >= 10000) {
        throw new SecurityError('SECURITY_RATE_LIMITED');
      }
      entry = { start: now, count: 0 };
      this.windows.set(key, entry);
    }
    entry.count = Math.min(entry.count + 1, 100001);
    return entry.count;
  }

  private time(): number {
    this.clock = Math.max(this.clock, this.now());
    return this.clock;
  }

  private sweep(): void {
    if (this.sweeping) {
      return;
    }
    this.sweeping = true;
    try {
      const now = this.time();
      const clockBackwards = this.now() < Date.parse(this.state.clockUtc);
      if (
        this.state.pending &&
        (clockBackwards || Date.parse(this.state.pending.expiresAt) <= now)
      ) {
        const { pending, ...rest } = this.state;
        this.save('network.timeout.rollback', { ...rest, config: pending.previous });
      }
      const prune = (policy: SecuritySourcePolicy): SecuritySourcePolicy => ({
        ...policy,
        allow: (policy.allow ?? []).filter(
          (rule) => !rule.expiresAt || Date.parse(rule.expiresAt) > now,
        ),
        deny: (policy.deny ?? []).filter(
          (rule) => !rule.expiresAt || Date.parse(rule.expiresAt) > now,
        ),
      });
      const config = {
        ...this.state.config,
        data: prune(this.state.config.data),
        management: prune(this.state.config.management),
      };
      const bans = this.state.bans.filter((ban) => Date.parse(ban.expiresAt) > now);
      if (
        JSON.stringify(config) !== JSON.stringify(this.state.config) ||
        bans.length !== this.state.bans.length
      ) {
        this.save('network.expire', { ...this.state, config, bans });
      }
    } finally {
      this.sweeping = false;
    }
  }

  private save(action: string, next: SecurityProtectionState, source?: NetworkSource): void {
    const updated = {
      ...structuredClone(next),
      revision: this.state.revision + 1,
      clockUtc: new Date(this.time()).toISOString(),
    };
    const commit = () => this.registry.saveProtection(action, updated);
    if (source) {
      this.registry.withManagementActor(
        {
          actor: { identityTrust: 'unverified' },
          source: {
            transport: 'http',
            peerIp: source.peerIp,
            clientIp: source.clientIp,
            clientIpBasis: source.clientIpBasis,
          },
        },
        commit,
      );
    } else {
      commit();
    }
    this.state = updated;
    this.network.setSourcePolicies(updated.config);
  }

  private validateState(): void {
    requireValid(
      this.state.version === 1 &&
        Number.isSafeInteger(this.state.revision) &&
        this.state.revision > 0,
    );
    requireValid(Number.isFinite(Date.parse(this.state.clockUtc)));
    validateProtectionConfig(this.state.config);
    if (this.state.previous) {
      validateProtectionConfig(this.state.previous);
    }
    if (this.state.pending) {
      requireValid(
        /^[a-f0-9-]{36}$/.test(this.state.pending.id) &&
          Number.isFinite(Date.parse(this.state.pending.expiresAt)),
      );
      validateProtectionConfig(this.state.pending.previous);
    }
    requireValid(Array.isArray(this.state.bans) && this.state.bans.length <= 1000);
    for (const ban of this.state.bans) {
      requireValid(
        /^[a-f0-9-]{36}$/.test(ban.id) &&
          ['data', 'management'].includes(ban.plane) &&
          Number.isFinite(Date.parse(ban.createdAt)) &&
          Number.isFinite(Date.parse(ban.expiresAt)),
      );
      sourceMatches(ban.source, ban.source);
    }
  }
}

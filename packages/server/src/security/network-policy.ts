import { BlockList, isIP } from 'node:net';
import type { IncomingHttpHeaders } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SecurityError } from './security-errors.js';
import type {
  SecurityPlane,
  SecurityProtectionConfig,
  SecuritySourcePolicy,
} from '@mode-db/shared';

/** A persisted source rule; expiry is evaluated for every HTTP request and WS message. */
export type SourceRule = NonNullable<SecuritySourcePolicy['allow']>[number];

/** Disabled allow-lists impose no allow constraint; enabled empty lists deny everyone. */
export type SourcePolicy = SecuritySourcePolicy;

/** Transport and source configuration for registry mode, independent of business backups. */
export interface SecurityNetworkConfig {
  readonly transport?:
    | { readonly mode: 'loopback' }
    | { readonly mode: 'tls'; readonly certificateFile: string; readonly privateKeyFile: string }
    | { readonly mode: 'proxy'; readonly trustedProxies: readonly string[] };
  readonly allowedOrigins?: readonly string[];
  readonly data?: SourcePolicy;
  readonly management?: SourcePolicy;
}

/** Canonical client address and the evidence used to resolve it. */
export interface NetworkSource {
  readonly peerIp: string;
  readonly clientIp: string;
  readonly clientIpBasis: 'socket' | 'trusted-proxy';
  readonly secure: boolean;
}

interface CompiledRule {
  readonly id: string;
  readonly block: BlockList;
  readonly expiresAt: number;
}

const loopback: SourcePolicy = {
  allowListEnabled: true,
  allow: [
    { id: 'loopback-v4', source: '127.0.0.0/8' },
    { id: 'loopback-v6', source: '::1/128' },
  ],
};

function invalid(): never {
  throw new SecurityError('SECURITY_INVALID_CONFIG');
}

/** Validate an exact HTTP(S) origin; wildcards, credentials and paths are rejected. */
export function securityOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      url.origin === 'null'
    ) {
      invalid();
    }
    return url.origin;
  } catch {
    return invalid();
  }
}

/** Normalize IPv4-mapped IPv6 before rule matching and audit attribution. */
export function networkAddress(value: string): string {
  const raw = value.replace(/^\[|\]$/g, '');
  const family = isIP(raw);
  if (!family) {
    throw new SecurityError('SECURITY_SOURCE_DENIED');
  }
  if (family === 4) {
    return raw;
  }
  const canonical = new URL(`http://[${raw}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(canonical);
  if (!mapped) {
    return canonical;
  }
  const bytes = (BigInt(`0x${mapped[1]}`) << 16n) | BigInt(`0x${mapped[2]}`);
  return [24n, 16n, 8n, 0n].map((n) => Number((bytes >> n) & 255n)).join('.');
}

function compileSource(value: string): BlockList {
  if (typeof value !== 'string' || value.length > 128) {
    invalid();
  }
  const [raw, prefix, extra] = value.split('/');
  if (extra !== undefined || !raw || !isIP(raw) || raw.includes('%')) {
    invalid();
  }
  const family = isIP(raw) === 4 ? 'ipv4' : 'ipv6';
  const block = new BlockList();
  try {
    if (prefix === undefined) {
      block.addAddress(raw, family);
    } else {
      if (!/^\d{1,3}$/.test(prefix)) {
        invalid();
      }
      block.addSubnet(raw, Number(prefix), family);
    }
  } catch {
    invalid();
  }
  return block;
}

function matches(block: BlockList, ip: string): boolean {
  return block.check(ip, isIP(ip) === 4 ? 'ipv4' : 'ipv6');
}

export function sourceMatches(source: string, ip: string): boolean {
  return matches(compileSource(source), networkAddress(ip));
}

export function validateSourcePolicy(raw: SourcePolicy): void {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).some((key) => !['allowListEnabled', 'allow', 'deny'].includes(key))
  ) {
    invalid();
  }
  compilePolicy(raw);
  const all = [...(raw.allow ?? []), ...(raw.deny ?? [])];
  if (new Set(all.map((rule) => rule.id)).size !== all.length) {
    invalid();
  }
  for (const rule of all) {
    if (
      Object.keys(rule).some(
        (key) => !['id', 'source', 'expiresAt', 'reason', 'createdAt', 'createdBy'].includes(key),
      )
    ) {
      invalid();
    }
    if (
      rule.reason !== undefined &&
      (typeof rule.reason !== 'string' ||
        rule.reason.length > 240 ||
        /[\x00-\x1f]/.test(rule.reason))
    ) {
      invalid();
    }
    if (rule.createdAt !== undefined && !Number.isFinite(Date.parse(rule.createdAt))) {
      invalid();
    }
    if (rule.createdBy !== undefined && !/^[a-zA-Z0-9_-]{1,184}$/.test(rule.createdBy)) {
      invalid();
    }
  }
}

/** True only for literal loopback addresses or the reserved localhost hostname. */
export function isLoopbackAddress(host: string): boolean {
  if (host.toLowerCase() === 'localhost') {
    return true;
  }
  try {
    const ip = networkAddress(host);
    return matches(compileSource('127.0.0.0/8'), ip) || ip === '::1';
  } catch {
    return false;
  }
}

function rules(raw: readonly SourceRule[] | undefined): CompiledRule[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw) || raw.length > 1000) {
    invalid();
  }
  const ids = new Set<string>();
  return raw.map((rule) => {
    if (!rule || !/^[a-zA-Z0-9_-]{1,96}$/.test(rule.id) || ids.has(rule.id)) {
      invalid();
    }
    ids.add(rule.id);
    const expiresAt = rule.expiresAt === undefined ? Infinity : Date.parse(rule.expiresAt);
    if (Number.isNaN(expiresAt)) {
      invalid();
    }
    return { id: rule.id, block: compileSource(rule.source), expiresAt };
  });
}

function compilePolicy(raw: SourcePolicy | undefined): {
  allowListEnabled: boolean;
  allow: CompiledRule[];
  deny: CompiledRule[];
} {
  const policy = raw ?? loopback;
  if (policy.allowListEnabled !== undefined && typeof policy.allowListEnabled !== 'boolean') {
    invalid();
  }
  return {
    allowListEnabled: policy.allowListEnabled !== false,
    allow: rules(policy.allow),
    deny: rules(policy.deny),
  };
}

/** Registry transport/source boundary. Call again at every queued execution boundary. */
export class SecurityNetworkPolicy {
  readonly mode: 'loopback' | 'tls' | 'proxy';
  readonly allowedOrigins: ReadonlySet<string>;
  private pairedOrigin?: (origin: string) => boolean;

  setPairedOriginVerifier(verify: (origin: string) => boolean): void {
    this.pairedOrigin = verify;
  }
  allowsOrigin(origin: string): boolean {
    return this.allowedOrigins.has(origin) || this.pairedOrigin?.(origin) === true;
  }
  private readonly proxies: BlockList[];
  private data;
  private management;
  private sources: { data: SourcePolicy; management: SourcePolicy };
  private protectionCheck?: (source: NetworkSource, plane: SecurityPlane) => void;
  private readonly connections = new Map<
    object,
    { clientIp: string; plane: SecurityPlane; recheck?: () => void }
  >();
  private readonly tlsFiles?: { certificateFile: string; privateKeyFile: string };

  constructor(
    raw: SecurityNetworkConfig = {},
    endpoint: { host: string; port: number; publicBaseUrl?: string; directory: string },
    private readonly now: () => number = Date.now,
  ) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      invalid();
    }
    this.mode = raw.transport?.mode ?? 'loopback';
    if (!['loopback', 'tls', 'proxy'].includes(this.mode)) {
      invalid();
    }
    if (this.mode === 'loopback' && !isLoopbackAddress(endpoint.host)) {
      invalid();
    }
    if (
      raw.allowedOrigins !== undefined &&
      (!Array.isArray(raw.allowedOrigins) || raw.allowedOrigins.length > 100)
    ) {
      invalid();
    }
    const origins = new Set((raw.allowedOrigins ?? []).map(securityOrigin));
    const transport = raw.transport;
    if (
      transport?.mode === 'proxy' &&
      (!Array.isArray(transport.trustedProxies) || transport.trustedProxies.length > 1000)
    ) {
      invalid();
    }
    this.proxies = transport?.mode === 'proxy' ? transport.trustedProxies.map(compileSource) : [];
    if (
      this.mode === 'proxy' &&
      (!this.proxies.length || !endpoint.publicBaseUrl?.startsWith('https://'))
    ) {
      invalid();
    }
    if (
      this.mode !== 'loopback' &&
      endpoint.publicBaseUrl &&
      !endpoint.publicBaseUrl.startsWith('https://')
    ) {
      invalid();
    }
    if (endpoint.publicBaseUrl) {
      origins.add(securityOrigin(endpoint.publicBaseUrl));
    } else if (this.mode !== 'proxy') {
      const host = endpoint.host.includes(':')
        ? `[${endpoint.host.replace(/^\[|\]$/g, '')}]`
        : endpoint.host;
      if (!['0.0.0.0', '::', '[::]'].includes(endpoint.host)) {
        origins.add(
          securityOrigin(`${this.mode === 'tls' ? 'https' : 'http'}://${host}:${endpoint.port}`),
        );
      }
    }
    this.allowedOrigins = origins;
    for (const origin of origins) {
      const url = new URL(origin);
      if (url.protocol !== 'https:' && !isLoopbackAddress(url.hostname)) {
        invalid();
      }
    }
    if (transport?.mode === 'tls') {
      if (!transport.certificateFile || !transport.privateKeyFile) {
        invalid();
      }
      this.tlsFiles = {
        certificateFile: resolve(endpoint.directory, transport.certificateFile),
        privateKeyFile: resolve(endpoint.directory, transport.privateKeyFile),
      };
    }
    this.data = compilePolicy(raw.data);
    this.management = compilePolicy(raw.management);
    this.sources = structuredClone({
      data: raw.data ?? loopback,
      management: raw.management ?? loopback,
    });
  }

  sourcePolicies(): { data: SourcePolicy; management: SourcePolicy } {
    return structuredClone(this.sources);
  }

  setSourcePolicies(config: Pick<SecurityProtectionConfig, 'data' | 'management'>): void {
    validateSourcePolicy(config.data);
    validateSourcePolicy(config.management);
    const data = compilePolicy(config.data);
    const management = compilePolicy(config.management);
    this.data = data;
    this.management = management;
    this.sources = structuredClone({ data: config.data, management: config.management });
    for (const connection of this.connections.values()) {
      connection.recheck?.();
    }
  }

  setProtectionCheck(check: (source: NetworkSource, plane: SecurityPlane) => void): void {
    this.protectionCheck = check;
  }

  trackConnection(
    key: object,
    clientIp: string,
    plane: SecurityPlane,
    recheck?: () => void,
  ): () => void {
    if (this.connections.size >= 10000) {
      throw new SecurityError('SECURITY_RATE_LIMITED');
    }
    this.connections.set(key, { clientIp, plane, recheck });
    return () => {
      this.connections.delete(key);
    };
  }

  activeConnections(): readonly { clientIp: string; plane: SecurityPlane }[] {
    return [...this.connections.values()].map(({ clientIp, plane }) => ({ clientIp, plane }));
  }

  matchedRule(source: NetworkSource, plane: SecurityPlane): string | undefined {
    const policy = plane === 'data' ? this.data : this.management;
    const active = (rule: CompiledRule) =>
      rule.expiresAt > this.now() && matches(rule.block, source.clientIp);
    return policy.deny.find(active)?.id ?? policy.allow.find(active)?.id;
  }

  /** Non-sensitive effective policy summary for the OS-authenticated security center. */
  status(): {
    mode: 'loopback' | 'tls' | 'proxy';
    allowedOriginCount: number;
    trustedProxyCount: number;
    data: { allowListEnabled: boolean; allowRules: number; denyRules: number };
    management: { allowListEnabled: boolean; allowRules: number; denyRules: number };
  } {
    const summary = (policy: typeof this.data) => ({
      allowListEnabled: policy.allowListEnabled,
      allowRules: policy.allow.length,
      denyRules: policy.deny.length,
    });
    return {
      mode: this.mode,
      allowedOriginCount: this.allowedOrigins.size,
      trustedProxyCount: this.proxies.length,
      data: summary(this.data),
      management: summary(this.management),
    };
  }

  /** Load PEM material at startup only; never return it in status or error messages. */
  tlsOptions(): { cert: Buffer; key: Buffer; minVersion: 'TLSv1.2' } | undefined {
    if (!this.tlsFiles) {
      return undefined;
    }
    try {
      return {
        cert: readFileSync(this.tlsFiles.certificateFile),
        key: readFileSync(this.tlsFiles.privateKeyFile),
        minVersion: 'TLSv1.2',
      };
    } catch {
      return invalid();
    }
  }

  /** Resolve forwarded chains only from configured peers, walking toward the first untrusted hop. */
  source(peer: string, headers: IncomingHttpHeaders, encrypted: boolean): NetworkSource {
    const peerIp = networkAddress(peer);
    if (this.mode === 'loopback') {
      if (!isLoopbackAddress(peerIp)) {
        throw new SecurityError('SECURITY_SOURCE_DENIED');
      }
      return { peerIp, clientIp: peerIp, clientIpBasis: 'socket', secure: false };
    }
    if (this.mode === 'tls') {
      if (!encrypted) {
        throw new SecurityError('SECURITY_TLS_REQUIRED');
      }
      return { peerIp, clientIp: peerIp, clientIpBasis: 'socket', secure: true };
    }
    if (!this.proxies.some((p) => matches(p, peerIp)) || headers['x-forwarded-proto'] !== 'https') {
      throw new SecurityError('SECURITY_PROXY_UNTRUSTED');
    }
    const forwarded = headers['x-forwarded-for'];
    if (typeof forwarded !== 'string' || forwarded.length > 2048) {
      throw new SecurityError('SECURITY_PROXY_UNTRUSTED');
    }
    const chain = forwarded.split(',').map((v) => networkAddress(v.trim()));
    if (!chain.length || chain.length > 32) {
      throw new SecurityError('SECURITY_PROXY_UNTRUSTED');
    }
    let clientIp = peerIp;
    for (let i = chain.length - 1; i >= 0 && this.proxies.some((p) => matches(p, clientIp)); i--) {
      clientIp = chain[i]!;
    }
    return { peerIp, clientIp, clientIpBasis: 'trusted-proxy', secure: true };
  }

  /** Enforce deny precedence, expiry, and an explicit allow constraint for each entry plane. */
  check(source: NetworkSource, plane: 'data' | 'management', origin?: string): void {
    this.protectionCheck?.(source, plane);
    if (origin !== undefined && !this.allowsOrigin(origin)) {
      throw new SecurityError('SECURITY_ORIGIN_DENIED');
    }
    const policy = plane === 'data' ? this.data : this.management;
    const active = (r: CompiledRule): boolean =>
      r.expiresAt > this.now() && matches(r.block, source.clientIp);
    if (policy.deny.some(active) || (policy.allowListEnabled && !policy.allow.some(active))) {
      throw new SecurityError('SECURITY_SOURCE_DENIED');
    }
  }
}

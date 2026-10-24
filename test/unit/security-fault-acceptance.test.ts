import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import type { DataSecurityEvent } from '@mode-db/shared';
import Fastify from '../../packages/server/node_modules/fastify/fastify.js';
import { SecurityRegistry } from '../../packages/server/src/security/security-registry.js';
import { SecurityNetworkPolicy } from '../../packages/server/src/security/network-policy.js';
import { SecurityProtection } from '../../packages/server/src/security/security-protection.js';
import { installSecurityNetworkBoundary } from '../../packages/server/src/security/network-boundary.js';

const protector = {
  id: 'synthetic-fault-only',
  ensureDirectory(path: string) {
    mkdirSync(path, { recursive: true });
  },
  protect(bytes: Uint8Array) {
    return Buffer.from(bytes).toString('base64');
  },
  unprotect(text: string) {
    return Buffer.from(text, 'base64');
  },
};
function fixture(limit = 10000) {
  const root = mkdtempSync(join(tmpdir(), 'modedb-fault-acceptance-'));
  const directory = join(root, 'security');
  let clock = Date.parse('2026-10-24T00:00:10Z'),
    fail = false;
  let registry = SecurityRegistry.open(directory, {
    protector,
    now: () => clock,
    auditLimit: limit,
    onCommitPoint(point) {
      if (fail && point === 'staged')
        throw Object.assign(new Error('synthetic ENOSPC'), { code: 'ENOSPC' });
    },
  });
  const network = new SecurityNetworkPolicy(
    {},
    { host: '127.0.0.1', port: 0, directory },
    () => clock,
  );
  let protection = new SecurityProtection(registry, network, () => clock);
  return {
    directory,
    network,
    get registry() {
      return registry;
    },
    get protection() {
      return protection;
    },
    advance(ms: number) {
      clock += ms;
    },
    fail() {
      fail = true;
    },
    event(patch: Partial<DataSecurityEvent> = {}) {
      const event: DataSecurityEvent = {
        version: 1,
        eventId: randomUUID(),
        timestampUtc: new Date(clock).toISOString(),
        category: 'network',
        plane: 'data',
        action: 'network.reject',
        result: 'denied',
        reasonCode: 'SECURITY_SOURCE_DENIED',
        actor: { identityTrust: 'unverified' },
        requestId: randomUUID(),
        policyVersion: registry.status().policyVersion,
        source: {
          transport: 'http',
          peerIp: '127.0.0.1',
          clientIp: '127.0.0.1',
          clientIpBasis: 'socket',
        },
        ...patch,
      };
      registry.recordSecurityEvent(event);
      return event;
    },
    reopen() {
      protection.close();
      registry.close();
      registry = SecurityRegistry.open(directory, {
        protector,
        now: () => clock,
        auditLimit: limit,
      });
      protection = new SecurityProtection(registry, network, () => clock);
    },
    close() {
      protection.close();
      registry.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
it('durably aggregates anonymous rejection floods with accurate counts, bounded samples and restart continuity', () => {
  const f = fixture();
  try {
    const events = Array.from({ length: 200 }, () => f.event());
    let page = f.registry.auditPage({ action: 'network.reject' });
    assert.equal(page.total, 1);
    assert.equal(page.summary.observedCount, 200);
    assert.equal(page.summary.savedDetails, 1);
    assert.equal(page.summary.suppressedDetails, 199);
    assert.equal(page.summary.byResult.denied, 200);
    assert.equal(page.summary.byCategory.network, 200);
    assert.deepEqual(
      page.events[0].aggregation?.sampleRequestIds,
      events.slice(0, 3).map((e) => e.requestId),
    );
    assert.equal(page.events[0].requestId, events[0].requestId);
    assert.equal(f.registry.auditPage({ requestId: events[1].requestId }).total, 1);
    f.reopen();
    f.event();
    page = f.registry.auditPage({ action: 'network.reject' });
    assert.equal(page.total, 1);
    assert.equal(page.summary.observedCount, 201);
    const exported = JSON.parse(f.registry.auditNdjson({ action: 'network.reject' }));
    assert.equal(exported.aggregation.suppressedDetails, 200);
    assert.equal('secretHash' in exported, false);
  } finally {
    f.close();
  }
});
it('separates sources, reasons, planes, protocols, policy versions and windows, without sampling verified or management events', () => {
  const f = fixture();
  try {
    const initial = f.event();
    f.event({ source: { ...initial.source, clientIp: '192.0.2.4' } });
    f.event({ reasonCode: 'SECURITY_RATE_LIMITED' });
    f.event({ plane: 'management' });
    f.event({ source: { ...initial.source, transport: 'websocket' } });
    f.event({ policyVersion: initial.policyVersion! + 1 });
    f.advance(-5000);
    f.event();
    f.reopen();
    const first = f.registry.auditPage({ requestId: initial.requestId }).events[0];
    assert.equal(first.aggregation?.firstSeenUtc, '2026-10-24T00:00:05.000Z');
    assert.equal(first.aggregation?.lastSeenUtc, '2026-10-24T00:00:10.000Z');
    assert.equal(f.registry.auditPage({ action: 'network.reject' }).total, 6);
    f.advance(60000);
    f.event();
    for (let i = 0; i < 3; i++)
      f.event({ actor: { identityTrust: 'verified', principalId: 'verified' } });
    for (let i = 0; i < 3; i++) f.registry.createPrincipal('retained-admin-' + i);
    assert.equal(f.registry.auditPage({ action: 'network.reject' }).total, 10);
    assert.equal(f.registry.auditPage({ action: 'principal.create' }).total, 3);
    assert.ok(
      f.registry.auditPage({ principalId: 'verified' }).events.every((e) => !e.aggregation),
    );
  } finally {
    f.close();
  }
});
it('caps distinct anonymous keys and reserves durable audit capacity for local repair', () => {
  const f = fixture(20);
  try {
    for (let i = 0; i < 5; i++) f.event({ reasonCode: 'reason-' + i });
    assert.throws(() => f.event({ reasonCode: 'sixth-key' }), { code: 'SECURITY_AUDIT_CAPACITY' });
    f.event({ reasonCode: 'reason-0' });
    f.registry.createPrincipal('local-repair');
    f.advance(60000);
    for (let i = 0; i < 5; i++) f.event({ reasonCode: 'next-' + i });
    f.advance(60000);
    while (f.registry.status().auditEvents < 16)
      f.event({ reasonCode: 'third-' + f.registry.status().auditEvents });
    assert.throws(() => f.event({ reasonCode: 'reserved' }), { code: 'SECURITY_AUDIT_CAPACITY' });
    assert.doesNotThrow(() => f.registry.createPrincipal('still-can-repair'));
    assert.equal(f.registry.auditPage({ action: 'network.reject' }).summary.suppressedDetails, 1);
  } finally {
    f.close();
  }
});
it('rejects requests when durable aggregation encounters injected ENOSPC, preserving the prior count on reopen', () => {
  const f = fixture();
  try {
    f.event();
    f.fail();
    assert.throws(() => f.event());
    f.reopen();
    assert.equal(f.registry.auditPage({ action: 'network.reject' }).summary.observedCount, 1);
    f.event();
    assert.equal(f.registry.auditPage({ action: 'network.reject' }).summary.observedCount, 2);
  } finally {
    f.close();
  }
});
it('attributes HTTP header floods to their socket and returns 503 on failed durable audit', async () => {
  const f = fixture(),
    app = Fastify();
  try {
    const proxy = new SecurityNetworkPolicy(
      { transport: { mode: 'proxy', trustedProxies: ['10.0.0.1'] } },
      {
        host: '127.0.0.1',
        port: 0,
        directory: f.directory,
        publicBaseUrl: 'https://synthetic.invalid',
      },
    );
    installSecurityNetworkBoundary(app, proxy, f.protection);
    app.get('/api/v1/rpc', async () => ({ unexpected: true }));
    for (let i = 0; i < 75; i++) {
      const response = await app.inject({
        url: '/api/v1/rpc',
        remoteAddress: '127.0.0.1',
        headers: {
          'x-forwarded-for': `192.0.2.${i}`,
          'x-forwarded-proto': 'https',
          authorization: 'Bearer synthetic-sensitive-token',
        },
      });
      assert.equal(response.statusCode, 403);
      assert.equal(response.body.includes('synthetic-sensitive-token'), false);
    }
    const page = f.registry.auditPage({ action: 'network.reject' });
    assert.equal(page.total, 1);
    assert.equal(page.summary.observedCount, 75);
    assert.equal(page.summary.uniqueClientIps, 1);
    assert.equal(page.events[0].source.clientIp, '127.0.0.1');
    assert.equal(page.events[0].source.clientIpBasis, 'socket');
    assert.equal(f.registry.auditNdjson().includes('synthetic-sensitive-token'), false);
    f.fail();
    const response = await app.inject({
      url: '/api/v1/rpc',
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '192.0.2.99' },
    });
    assert.equal(response.statusCode, 503);
    f.reopen();
    assert.equal(f.registry.auditPage({ action: 'network.reject' }).summary.observedCount, 75);
  } finally {
    await app.close();
    f.close();
  }
});
it(
  'bounds volatile source windows and rejects a full ban list, then recovers capacity after expiry',
  { timeout: 60000 },
  () => {
    const f = fixture();
    try {
      const source = {
        peerIp: '127.0.0.1',
        clientIp: '127.0.0.1',
        clientIpBasis: 'socket' as const,
        secure: false,
      };
      for (let i = 0; i < 10000; i++)
        f.protection.consume(
          { ...source, clientIp: `192.0.${Math.floor(i / 256)}.${i % 256}` },
          'data',
        );
      assert.throws(() => f.protection.consume(source, 'data'), { code: 'SECURITY_RATE_LIMITED' });
      f.advance(60001);
      assert.doesNotThrow(() => f.protection.consume(source, 'data'));
      const state = f.protection.snapshot();
      f.protection.close();
      f.registry.saveProtection('network.ban', {
        ...state,
        config: {
          ...state.config,
          rate: { ...state.config.rate, autoBan: true, authenticationFailures: 1 },
        },
        bans: Array.from({ length: 1000 }, () => ({
          id: randomUUID(),
          source: '192.0.2.1',
          plane: 'data' as const,
          createdAt: '2026-10-24T00:01:00Z',
          expiresAt: '2026-10-24T00:02:00Z',
          reason: 'authentication-failures',
        })),
      });
      f.reopen();
      assert.throws(() => f.protection.authenticationFailed(source, 'data'), {
        code: 'SECURITY_RATE_LIMITED',
      });
      f.advance(60001);
      assert.equal(f.protection.snapshot().bans.length, 0);
      assert.doesNotThrow(() => f.protection.authenticationFailed(source, 'data'));
      assert.equal(f.protection.snapshot().bans.length, 1);
    } finally {
      f.close();
    }
  },
);

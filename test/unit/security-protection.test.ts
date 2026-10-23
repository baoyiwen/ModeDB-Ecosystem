import assert from 'node:assert/strict';
import { createDecipheriv } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import type { SecurityProtectionConfig } from '@mode-db/shared';
import { SecurityRegistry } from '../../packages/server/src/security/security-registry.js';
import { SecurityNetworkPolicy, sourceMatches, type NetworkSource } from '../../packages/server/src/security/network-policy.js';
import { SecurityProtection } from '../../packages/server/src/security/security-protection.js';
import { SecurityMaintenance } from '../../packages/server/src/security/security-maintenance.js';
import { LocalVaultKeyProvider } from '../../packages/server/src/security/local-vault-key-provider.js';
import { dispatchLocalSecurity } from '../../packages/server/src/security/local-management-channel.js';
import { dispatchSecurityControl, requireRecentSecurityPairing } from '../../packages/server/src/security/security-control.js';
import Fastify from '../../packages/server/node_modules/fastify/fastify.js';
import { installSecurityNetworkBoundary } from '../../packages/server/src/security/network-boundary.js';

const protector = {
  id: 'synthetic-only-protector',
  ensureDirectory(path: string) { mkdirSync(path, { recursive: true }); },
  protect(bytes: Uint8Array) { return Buffer.from(bytes).toString('base64'); },
  unprotect(text: string) { return Buffer.from(text, 'base64'); },
};
const source: NetworkSource = { peerIp: '127.0.0.1', clientIp: '127.0.0.1', clientIpBasis: 'socket', secure: false };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'modedb-protection-'));
  const directory = join(root, 'security');
  const workspace = join(root, 'data');
  mkdirSync(workspace);
  let clock = Date.parse('2026-10-21T00:00:00Z');
  let fail = false;
  let registry = SecurityRegistry.open(directory, { protector, now: () => clock,
    onCommitPoint: (point) => { if (fail && point === 'staged') throw new Error('synthetic disk failure'); } });
  const network = new SecurityNetworkPolicy({}, { host: '127.0.0.1', port: 0, directory }, () => clock);
  let protection = new SecurityProtection(registry, network, () => clock);
  const keys = new LocalVaultKeyProvider(directory, protector);
  const maintenance = new SecurityMaintenance(registry, keys, directory, workspace, protector);
  return {
    root, directory, workspace, network, keys, maintenance,
    get registry() { return registry; }, get protection() { return protection; },
    config: () => structuredClone(protection.snapshot().config),
    apply(config: SecurityProtectionConfig) { const preview = protection.preview(config, source); return protection.apply(config, preview.revision, preview.id); },
    advance(ms: number) { clock += ms; }, fail() { fail = true; },
    reopen() { protection.close(); registry.close(); registry = SecurityRegistry.open(directory, { protector, now: () => clock }); protection = new SecurityProtection(registry, network, () => clock); },
    close() { protection.close(); registry.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

it('separates planes, gives deny precedence and preserves an enabled empty allow list', () => {
  const f = fixture();
  try {
    assert.equal(sourceMatches('2001:db8::/32', '2001:db8::42'), true);
    assert.equal(sourceMatches('127.0.0.0/8', '::ffff:127.0.0.1'), true);
    const config = { ...f.config(), data: { allowListEnabled: true, allow: [], deny: [] } };
    const state = f.apply(config);
    assert.throws(() => f.network.check(source, 'data'), { code: 'SECURITY_SOURCE_DENIED' });
    assert.doesNotThrow(() => f.network.check(source, 'management'));
    f.protection.confirm(state.pending!.id);
    f.reopen();
    assert.throws(() => f.network.check(source, 'data'), { code: 'SECURITY_SOURCE_DENIED' });
    f.apply({ ...config, data: { allowListEnabled: false, allow: [{ id: 'yes', source: '127.0.0.1' }], deny: [{ id: 'no', source: '127.0.0.0/8' }] } });
    assert.throws(() => f.network.check(source, 'data'), { code: 'SECURITY_SOURCE_DENIED' });
    assert.equal(f.network.matchedRule(source, 'data'), 'no');
  } finally { f.close(); }
});

it('binds preview to config, revision, actor and expiry, with strict input validation', () => {
  const f = fixture();
  try {
    const config = f.config();
    const preview = f.protection.preview(config, source);
    assert.equal(preview.connections[0]?.allowed, true);
    assert.throws(() => f.protection.apply({ ...config, data: { allowListEnabled: false } }, preview.revision, preview.id), { code: 'SECURITY_POLICY_CONFLICT' });
    assert.throws(() => f.registry.withManagementActor({ actor: { identityTrust: 'verified', principalId: 'other' }, source: { transport: 'local-ipc' } }, () => f.protection.apply(config, preview.revision, preview.id)), { code: 'SECURITY_POLICY_CONFLICT' });
    f.advance(120001);
    assert.throws(() => f.protection.apply(config, preview.revision, preview.id), { code: 'SECURITY_POLICY_CONFLICT' });
    for (const data of [{ allowListEnabled: true, allow: [{ id: 'bad', source: 'example.com' }] }, { allowListEnabled: true, allow: [{ id: 'same', source: '::1' }], deny: [{ id: 'same', source: '127.0.0.1' }] }])
      assert.throws(() => f.protection.preview({ ...config, data }));
    assert.throws(() => dispatchSecurityControl({ protection: f.protection }, { action: 'network.status', extra: true }), { code: 'SECURITY_INVALID_REQUEST' });
    assert.throws(() => dispatchSecurityControl({ protection: f.protection }, { action: 'network.rollback', revision: '1' }), { code: 'SECURITY_INVALID_REQUEST' });
  } finally { f.close(); }
});

it('rolls back unconfirmed lockout after timeout/restart/clock reversal, and supports OS-local repair', () => {
  const f = fixture();
  try {
    const deny = { ...f.config(), management: { allowListEnabled: true, allow: [] } };
    f.apply(deny);
    assert.throws(() => f.network.check(source, 'management'), { code: 'SECURITY_SOURCE_DENIED' });
    f.reopen();
    assert.ok(f.protection.snapshot().pending);
    f.advance(120001);
    assert.equal(f.protection.snapshot().pending, undefined);
    assert.doesNotThrow(() => f.network.check(source, 'management'));
    const second = f.apply(deny);
    dispatchLocalSecurity(f.registry, { action: 'network.rollback', revision: second.revision }, [], { protection: f.protection });
    assert.doesNotThrow(() => f.network.check(source, 'management'));
    f.apply(deny);
    f.advance(-1000);
    f.reopen();
    assert.equal(f.protection.snapshot().pending, undefined);
    assert.doesNotThrow(() => f.network.check(source, 'management'));
  } finally { f.close(); }
});

it('expires rules durably and rechecks established connections immediately after policy changes', () => {
  const f = fixture();
  try {
    let rejected = 0;
    f.network.trackConnection({}, source.clientIp, 'data', () => { try { f.network.check(source, 'data'); } catch { rejected++; } });
    const config = { ...f.config(), data: { allowListEnabled: false, deny: [{ id: 'temporary', source: '127.0.0.1', expiresAt: '2026-10-21T00:00:05Z' }] } };
    const state = f.apply(config);
    assert.equal(rejected, 1);
    f.protection.confirm(state.pending!.id);
    f.advance(5001);
    assert.doesNotThrow(() => f.network.check(source, 'data'));
    assert.equal(f.protection.snapshot().config.data.deny?.length, 0);
    f.reopen(); f.advance(-1000);
    assert.doesNotThrow(() => f.network.check(source, 'data'));
    assert.ok(f.registry.auditEvents().some((event) => event.action === 'network.expire'));
  } finally { f.close(); }
});

it('limits sources and authenticated principals independently and resets bounded windows', () => {
  const f = fixture();
  try {
    const config = f.config();
    const next = f.apply({ ...config, rate: { ...config.rate, dataRequests: 1, principalRequests: 1, windowSeconds: 2 } });
    f.protection.confirm(next.pending!.id);
    f.protection.consume(source, 'data');
    assert.throws(() => f.protection.consume(source, 'data'), { code: 'SECURITY_RATE_LIMITED' });
    assert.doesNotThrow(() => f.protection.consume(source, 'management'));
    f.protection.consume(source, 'data', 'actor');
    assert.throws(() => f.protection.consume({ ...source, clientIp: '127.0.0.2' }, 'data', 'actor'), { code: 'SECURITY_RATE_LIMITED' });
    f.advance(2001);
    assert.doesNotThrow(() => f.protection.consume(source, 'data'));
    assert.equal(f.protection.retryAfter(), 2);
  } finally { f.close(); }
});

it('observes failures by default; opt-in bans persist without extending expiry and exemptions do not bypass manual denies', () => {
  const f = fixture();
  try {
    let config = f.config();
    let state = f.apply({ ...config, rate: { ...config.rate, authenticationFailures: 1 } });
    f.protection.confirm(state.pending!.id);
    f.protection.authenticationFailed(source, 'data');
    assert.equal(f.protection.snapshot().bans.length, 0);
    assert.ok(f.registry.auditEvents().some((event) => event.action === 'network.authentication.threshold'));
    config = f.config();
    state = f.apply({ ...config, rate: { ...config.rate, autoBan: true, exemptManagementSources: ['127.0.0.0/8'] } });
    f.protection.confirm(state.pending!.id);
    f.advance(60001);
    f.protection.authenticationFailed(source, 'management');
    assert.equal(f.protection.snapshot().bans.length, 0);
    f.protection.authenticationFailed(source, 'data');
    const ban = f.protection.snapshot().bans[0]!;
    f.advance(1250);
    assert.equal(f.protection.retryAfter(source, 'data'), 599);
    assert.throws(() => f.network.check(source, 'data'), { code: 'SECURITY_TEMPORARILY_BANNED' });
    f.reopen();
    assert.equal(f.protection.snapshot().bans[0]?.expiresAt, ban.expiresAt);
    f.protection.unban(ban.id);
    assert.doesNotThrow(() => f.network.check(source, 'data'));
    f.protection.authenticationFailed(source, 'data');
    f.advance(600001); f.reopen();
    assert.equal(f.protection.snapshot().bans.length, 0);
    f.apply({ ...f.config(), management: { allowListEnabled: false, deny: [{ id: 'manual', source: '127.0.0.1' }] } });
    assert.throws(() => f.network.check(source, 'management'), { code: 'SECURITY_SOURCE_DENIED' });
  } finally { f.close(); }
});

it('requires recent pairing for key rotation even after session refresh', () => {
  const createdAt = '2026-10-21T00:00:00Z';
  const now = Date.parse(createdAt);
  assert.doesNotThrow(() => requireRecentSecurityPairing(createdAt, now + 300000));
  for (const at of [now - 1, now + 300001]) {
    assert.throws(() => requireRecentSecurityPairing(createdAt, at), { code: 'SECURITY_REAUTH_REQUIRED' });
  }
  assert.throws(() => requireRecentSecurityPairing('invalid', now), { code: 'SECURITY_REAUTH_REQUIRED' });
});

it('attributes rejected proxy headers to the socket, persists anonymous events, and fails closed on audit failure', async () => {
  const f = fixture();
  const app = Fastify();
  try {
    const proxy = new SecurityNetworkPolicy({ transport: { mode: 'proxy', trustedProxies: ['10.0.0.1'] } }, { host: '127.0.0.1', port: 0, directory: f.directory, publicBaseUrl: 'https://synthetic.invalid' });
    installSecurityNetworkBoundary(app, proxy, f.protection);
    app.get('/api/v1/rpc', async () => ({ unexpected: true }));
    const response = await app.inject({ url: '/api/v1/rpc', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '192.0.2.77', 'x-forwarded-proto': 'https' } });
    assert.equal(response.statusCode, 403);
    const event = [...f.registry.auditEvents()].reverse().find((entry) => entry.action === 'network.reject')!;
    assert.equal(event.source.clientIp, '127.0.0.1');
    assert.equal(event.source.clientIpBasis, 'socket');
    assert.equal(event.requestId, response.json().requestId);
    f.fail();
    const failed = await app.inject({ url: '/api/v1/rpc', remoteAddress: '127.0.0.1' });
    assert.equal(failed.statusCode, 503);
    f.reopen();
    assert.ok(f.registry.auditEvents().some((entry) => entry.eventId === event.eventId));
  } finally { await app.close(); f.close(); }
});

it('records management authentication thresholds on the management plane', () => {
  const f = fixture();
  try {
    const config = f.config();
    const state = f.apply({ ...config, rate: { ...config.rate, authenticationFailures: 1 } });
    f.protection.confirm(state.pending!.id);
    f.protection.authenticationFailed(source, 'management');
    const event = [...f.registry.auditEvents()].reverse().find((entry) => entry.action === 'network.authentication.threshold')!;
    assert.equal(event.plane, 'management');
    assert.ok(event.requestId);
    f.reopen();
    assert.ok(f.registry.auditEvents().some((entry) => entry.eventId === event.eventId));
  } finally { f.close(); }
});

it('fails closed when policy/audit durability fails and preserves the last effective policy', () => {
  const f = fixture();
  try {
    const config = { ...f.config(), management: { allowListEnabled: false } };
    const preview = f.protection.preview(config);
    f.fail();
    assert.throws(() => f.protection.apply(config, preview.revision, preview.id));
    f.reopen();
    assert.equal(f.protection.snapshot().config.management.allowListEnabled, true);
  } finally { f.close(); }
});

for (const point of ['promoted', 'rewrapped'] as const) it(`resumes master rotation after ${point}, keeps old DEKs and Vault bytes readable`, () => {
  const f = fixture();
  try {
    const one = f.keys.resolveKey('one');
    const two = f.keys.resolveKey('two');
    const other = new LocalVaultKeyProvider(f.directory, protector);
    other.getIdentity(true);
    const original = readFileSync(join(f.directory, `${one.reference.keyId}.dek`));
    const vault = join(f.workspace, 'synthetic.vault');
    writeFileSync(vault, 'synthetic encrypted Vault bytes');
    const before = readFileSync(vault);
    const oldId = f.keys.getIdentity().masterKeyId;
    assert.throws(() => f.keys.rotateMaster((at) => { if (at === point) throw new Error('synthetic crash'); }));
    const promoted = other.getIdentity(true).masterKeyId;
    assert.notEqual(promoted, oldId);
    assert.deepEqual(other.resolveKey('one', one.reference).key, one.key);
    f.maintenance.resumeRotation();
    assert.equal(f.keys.maintenanceStatus().rotation?.phase, 'completed');
    assert.equal(f.keys.getIdentity().masterKeyId, promoted);
    assert.deepEqual(f.keys.resolveKey('two', two.reference).key, two.key);
    assert.equal(JSON.parse(readFileSync(join(f.directory, `${two.reference.keyId}.dek`), 'utf8')).masterKeyId, promoted);
    writeFileSync(join(f.directory, `${one.reference.keyId}.dek`), original);
    assert.deepEqual(other.resolveKey('historical-backup', one.reference).key, one.key);
    assert.equal(f.keys.maintenanceStatus().retainedMasterKeys, 1);
    assert.deepEqual(readFileSync(vault), before);
    one.key.fill(0); two.key.fill(0);
  } finally { f.close(); }
});

it('rejects rotation when the durable master cannot be replaced, leaving DEKs usable', () => {
  const f = fixture();
  try {
    const key = f.keys.resolveKey('one');
    mkdirSync(join(f.directory, 'instance.key.pending'));
    assert.throws(() => f.keys.rotateMaster());
    rmSync(join(f.directory, 'instance.key.pending'), { recursive: true });
    assert.deepEqual(f.keys.resolveKey('one', key.reference).key, key.key);
    key.key.fill(0);
  } finally { f.close(); }
});

it('requires exact reset confirmation, exclusive ownership and a verified backup; rejects junctions and overlapping targets', () => {
  const f = fixture();
  try {
    const input = { instanceId: f.registry.status().instanceId, target: realpathSync(f.workspace), yes: true };
    const file = join(f.workspace, 'synthetic.txt'); writeFileSync(file, 'must survive rejected reset');
    for (const invalid of [{ ...input, yes: false }, { ...input, instanceId: 'wrong-instance' }, { ...input, target: f.root }])
      assert.throws(() => f.maintenance.factoryReset(invalid), { code: 'SECURITY_CONFIRMATION_REQUIRED' });
    assert.throws(() => SecurityRegistry.open(f.directory, { protector }), { code: 'SECURITY_INSTANCE_BUSY' });
    symlinkSync(f.directory, join(f.workspace, 'alias'), 'junction');
    assert.throws(() => f.maintenance.factoryReset(input), { code: 'SECURITY_INVALID_REQUEST' });
    rmSync(join(f.workspace, 'alias'));
    const overlapping = new SecurityMaintenance(f.registry, f.keys, f.directory, f.root, protector);
    assert.throws(() => overlapping.factoryReset({ ...input, target: realpathSync(f.root) }), { code: 'SECURITY_CONFIRMATION_REQUIRED' });
    const broken = new SecurityMaintenance(f.registry, f.keys, f.directory, f.workspace, { ...protector, protect() { throw new Error('synthetic protection failure'); } });
    assert.throws(() => broken.factoryReset(input), { code: 'SECURITY_MAINTENANCE_FAILED' });
    assert.equal(readFileSync(file, 'utf8'), 'must survive rejected reset');
    assert.ok(existsSync(join(f.directory, 'registry.mds')));
  } finally { f.close(); }
});

it('creates a decryptable encrypted reset backup and removes only the selected synthetic instance', () => {
  const f = fixture();
  try {
    const file = join(f.workspace, 'synthetic.txt'); writeFileSync(file, 'synthetic confidential content');
    const outside = join(f.root, 'untouched.config'); writeFileSync(outside, 'outside target');
    const instanceId = f.registry.status().instanceId;
    const result = f.maintenance.factoryReset({ instanceId, target: realpathSync(f.workspace), yes: true });
    assert.equal(existsSync(f.workspace), false); assert.equal(existsSync(f.directory), false);
    assert.equal(readFileSync(outside, 'utf8'), 'outside target');
    const raw = readFileSync(result.backup, 'utf8');
    assert.equal(raw.includes('synthetic confidential content'), false);
    const archive = JSON.parse(raw);
    const decipher = createDecipheriv('aes-256-gcm', protector.unprotect(archive.key), Buffer.from(archive.iv, 'base64'));
    decipher.setAAD(Buffer.from(`modeldb-reset-v1:${instanceId}`)); decipher.setAuthTag(Buffer.from(archive.tag, 'base64'));
    const restored = JSON.parse(Buffer.concat([decipher.update(Buffer.from(archive.ciphertext, 'base64')), decipher.final()]).toString());
    assert.equal(Buffer.from(restored.content.find((entry: { relative: string }) => entry.relative === 'synthetic.txt').data, 'base64').toString(), 'synthetic confidential content');
    assert.ok(existsSync(`${result.backup}.receipt`));
    assert.equal(existsSync(join(f.root, 'security-reset.pending')), false);
  } finally { f.close(); }
});

it('blocks restart after interrupted reset and retains the verified external archive', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.workspace, 'synthetic.txt'), 'synthetic');
    assert.throws(() => f.maintenance.factoryReset({ instanceId: f.registry.status().instanceId, target: realpathSync(f.workspace), yes: true }, (at) => {
      if (at === 'deleted') {
        assert.ok(existsSync(join(f.directory, 'instance-owner.lock')));
        assert.ok(existsSync(join(f.directory, 'key-maintenance.lock')));
        throw new Error('synthetic interruption');
      }
    }));
    assert.ok(existsSync(join(f.root, 'security-reset.pending')));
    assert.ok(readdirSync(join(f.root, 'reset-backups')).some((name) => name.endsWith('.mdreset')));
    assert.throws(() => SecurityRegistry.open(f.directory, { protector }), { code: 'SECURITY_MAINTENANCE_FAILED' });
  } finally { f.close(); }
});

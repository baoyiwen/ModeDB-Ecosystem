import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  symlinkSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { SecurityRegistry } from '../../packages/server/src/security/security-registry.js';
import {
  callLocalSecurity,
  localManagementPipe,
  startLocalSecurityChannel,
} from '../../packages/server/src/security/local-management-channel.js';
import { WindowsSecretProtector } from '../../packages/server/src/security/windows-secret-protector.js';
import { LocalVaultKeyProvider } from '../../packages/server/src/security/local-vault-key-provider.js';
import { ensureModelDbLayoutAtRoot } from '../../packages/server/src/modeldb-default-home.js';
import { loadModelDBServerConfig } from '../../packages/server/src/config-loader.js';
import { AuthoringEngine, readAtlasVaultKeyReference } from '@mode-db/core';
import { buildDualTrackFastify } from '../../packages/server/src/dual-track-app.js';
import { resolveAuditExportPath } from '../../packages/server/src/cli-security.js';

const windows = { skip: process.platform !== 'win32' };

const testProtector = {
  id: 'test-only-base64-protector',
  ensureDirectory(path: string): void {
    mkdirSync(path, { recursive: true });
  },
  protect(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64');
  },
  unprotect(ciphertext: string): Buffer {
    return Buffer.from(ciphertext, 'base64');
  },
};

it('keeps audit exports outside the registry even when a directory junction is used', () => {
  const root = mkdtempSync(join(tmpdir(), 'modedb-audit-export-path-'));
  const registryDir = join(root, 'security');
  const outsideDir = join(root, 'exports');
  try {
    mkdirSync(registryDir);
    mkdirSync(outsideDir);
    assert.equal(
      resolveAuditExportPath(registryDir, join(outsideDir, 'audit.jsonl')),
      join(outsideDir, 'audit.jsonl'),
    );
    assert.throws(() => resolveAuditExportPath(registryDir, join(registryDir, 'audit.jsonl')), {
      code: 'SECURITY_INVALID_REQUEST',
    });
    const junction = join(outsideDir, 'registry-alias');
    symlinkSync(registryDir, junction, 'junction');
    assert.throws(
      () => resolveAuditExportPath(registryDir, join(junction, 'audit.jsonl')),
      { code: 'SECURITY_INVALID_REQUEST' },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('prunes expired audit events and reports capacity health; JSONL excludes its own export event', () => {
  const root = mkdtempSync(join(tmpdir(), 'modedb-security-audit-retention-'));
  const dir = join(root, 'security');
  let now = Date.UTC(2026, 0, 1);
  let registry: SecurityRegistry | undefined;
  try {
    registry = SecurityRegistry.open(dir, {
      protector: testProtector,
      now: () => now,
      auditRetentionDays: 1,
      auditLimit: 100,
    });
    const actor = { principalId: 'test-operator', identityTrust: 'verified' as const };
    registry.recordAccess(actor, 'graph', 'succeeded', 'http', randomUUID());
    registry.close();
    registry = undefined;

    now += 2 * 86400000;
    registry = SecurityRegistry.open(dir, {
      protector: testProtector,
      now: () => now,
      auditRetentionDays: 1,
      auditLimit: 100,
    });
    assert.equal(registry.auditEvents().length, 1);
    assert.equal(registry.auditEvents()[0]?.action, 'audit.retention.prune');
    assert.equal(registry.auditEvents()[0]?.affectedCount, 2);
    registry.close();

    const capacityDir = join(root, 'capacity');
    registry = SecurityRegistry.open(capacityDir, {
      protector: testProtector,
      now: () => now,
      auditLimit: 100,
    });
    for (let index = 0; index < 79; index++) {
      registry.recordAccess(actor, 'graph', 'succeeded', 'http', randomUUID());
    }
    assert.equal(registry.status().auditHealth.usagePercent, 80);
    assert.equal(registry.status().auditHealth.status, 'warning');
    for (let index = 0; index < 15; index++) {
      registry.recordAccess(actor, 'graph', 'succeeded', 'http', randomUUID());
    }
    assert.equal(registry.status().auditHealth.usagePercent, 95);
    assert.equal(registry.status().auditHealth.status, 'critical');

    const snapshot = registry.auditNdjson();
    const eventCountBeforeExport = snapshot.trim().split('\n').length;
    registry.recordAuditExport({ transport: 'local-ipc' });
    assert.equal(registry.status().auditEvents, eventCountBeforeExport + 1);
    assert.equal(
      snapshot
        .trim()
        .split('\n')
        .some((line) => (JSON.parse(line) as { action: string }).action === 'audit.export'),
      false,
    );
    assert.throws(() => registry!.auditPage({ offset: 1.25 }), {
      code: 'SECURITY_INVALID_REQUEST',
    });
    registry.close();
    assert.throws(() => registry!.recordAuditExport(), { code: 'SECURITY_CLOSED' });
  } finally {
    registry?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('returns bounded newest-first audit pages with source attribution and aggregates', windows, () => {
  const root = mkdtempSync(join(tmpdir(), 'modedb-security-audit-page-'));
  const registry = SecurityRegistry.open(join(root, 'security'));
  try {
    const actor = { principalId: 'operator', identityTrust: 'verified' as const };
    registry.recordAccess(actor, 'graph', 'succeeded', 'http', randomUUID(), 'data.execute', {
      peerIp: '127.0.0.1',
      clientIp: '192.168.0.20',
      clientIpBasis: 'trusted-proxy',
      secure: true,
    });
    registry.recordAccess(actor, 'graph', 'denied', 'http', randomUUID(), 'data.execute', {
      peerIp: '127.0.0.1',
      clientIp: '192.168.0.20',
      clientIpBasis: 'trusted-proxy',
      secure: true,
    });
    const page = registry.auditPage({ category: 'data', clientIp: '192.168.0.20', limit: 1 });
    assert.equal(page.total, 2);
    assert.equal(page.events.length, 1);
    assert.equal(page.hasMore, true);
    assert.equal(page.summary.uniqueClientIps, 1);
    assert.equal(page.summary.byResult.denied, 1);
    assert.equal(page.events[0]?.source.clientIp, '192.168.0.20');
  } finally {
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it(
  'persists scoped credentials, rotation grace, expiry, revoked sessions and audited reset without changing data keys',
  windows,
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'modedb-security-ledger-'));
    const dir = join(root, 'security');
    let now = Date.now();
    let registry: SecurityRegistry | undefined;
    try {
      registry = SecurityRegistry.open(dir, { now: () => now });
      assert.throws(() => SecurityRegistry.open(dir), { code: 'SECURITY_INSTANCE_BUSY' });
      const first = registry.status();
      const principal = registry.createPrincipal('app');
      const created = registry.createCredential(principal.id, 'query', [
        { database: 'graph', resource: 'List', actions: ['callable.query'] },
      ]);
      const noAccess = registry.createCredential(principal.id, 'no-access');
      assert.deepEqual(registry.authenticate(noAccess.token).credential.grants, []);
      assert.deepEqual(registry.authenticate(created.token).credential.grants[0].actions, [
        'callable.query',
      ]);
      assert.throws(() => registry!.authenticate(created.token.slice(0, -1) + '!'), {
        code: 'SECURITY_CREDENTIAL_INVALID',
      });
      const session = registry.createSession(created.token);
      assert.equal(registry.verifySession(session.session).actor.applicationId, principal.id);
      const notified: string[] = [];
      registry.onInvalidation((e) => {
        notified.push(...e.credentialIds);
      });
      const rotated = registry.rotateCredential(created.credential.id, 10);
      assert.equal(registry.authenticate(created.token).credential.id, created.credential.id);
      assert.equal(
        registry.authenticate(rotated.token).credential.expiresAt,
        created.credential.expiresAt,
      );
      assert.throws(() => registry!.verifySession(session.session), {
        code: 'SECURITY_CREDENTIAL_REVOKED',
      });
      now += 600001;
      assert.throws(() => registry!.authenticate(created.token), {
        code: 'SECURITY_CREDENTIAL_EXPIRED',
      });
      const currentSession = registry.createSession(rotated.token);
      registry.revokeCredential(rotated.credential.id);
      assert.throws(() => registry!.authenticate(rotated.token), {
        code: 'SECURITY_CREDENTIAL_REVOKED',
      });
      assert.throws(() => registry!.verifySession(currentSession.session), {
        code: 'SECURITY_CREDENTIAL_REVOKED',
      });
      assert.ok(notified.includes(rotated.credential.id));
      const short = registry.createCredential(principal.id, 'short', [], 1 / 86400);
      now += 1001;
      assert.throws(() => registry!.authenticate(short.token), {
        code: 'SECURITY_CREDENTIAL_EXPIRED',
      });
      const engine = new AuthoringEngine({
        atlas: 'business',
        storageRoot: root,
        keyProvider: new LocalVaultKeyProvider(dir),
      });
      engine.registerModel('Item', { name: 'String' });
      await engine.insert('Item', { name: 'retained' }, { sync: true });
      await engine.close();
      const data = readFileSync(join(root, 'business', 'atlas.mld'));
      const keyFiles = new Map(
        readdirSync(dir)
          .filter((f) => f === 'instance.key' || f.endsWith('.dek'))
          .map((f) => [f, readFileSync(join(dir, f))]),
      );
      const reference = readAtlasVaultKeyReference(join(root, 'business', 'atlas.mld'));
      assert.ok(reference);
      registry.registerKeyReference(reference);
      const referencedRevision = registry.status().revision;
      registry.registerKeyReference(reference);
      assert.equal(registry.status().revision, referencedRevision);
      assert.ok(registry.auditEvents().some((e) => e.action === 'key.reference.register'));
      registry.resetAccess();
      assert.throws(() => registry!.authenticate(noAccess.token), {
        code: 'SECURITY_CREDENTIAL_REVOKED',
      });
      assert.deepEqual(readFileSync(join(root, 'business', 'atlas.mld')), data);
      for (const [f, bytes] of keyFiles) assert.deepEqual(readFileSync(join(dir, f)), bytes);
      const metadata = JSON.stringify(registry.listCredentials());
      assert.equal(metadata.includes('secretHash'), false);
      assert.equal(metadata.includes(created.token), false);
      const audit = JSON.stringify(registry.auditEvents());
      assert.equal(audit.includes(rotated.token), false);
      assert.ok(audit.includes('credential.revoke') && audit.includes('access.reset'));
      assert.ok(registry.auditEvents().every((e) => e.actor.principalId?.startsWith('S-1-')));
      registry.close();
      registry = SecurityRegistry.open(dir, { now: () => now });
      assert.equal(registry.status().instanceId, first.instanceId);
      assert.ok(registry.status().policyVersion > first.policyVersion);
      assert.throws(() => registry!.authenticate(rotated.token), {
        code: 'SECURITY_CREDENTIAL_REVOKED',
      });
      assert.throws(() => registry!.verifySession(currentSession.session), {
        code: 'SECURITY_CREDENTIAL_REVOKED',
      });
      for (const f of readdirSync(dir))
        assert.equal(readFileSync(join(dir, f)).includes(Buffer.from(rotated.token)), false);
    } finally {
      registry?.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it('fails closed on audit capacity and damaged or missing security material', windows, () => {
  const root = mkdtempSync(join(tmpdir(), 'modedb-security-corrupt-'));
  const dir = join(root, 'security');
  let registry: SecurityRegistry | undefined;
  try {
    registry = SecurityRegistry.open(dir, { auditLimit: 2 });
    const p = registry.createPrincipal('app');
    const before = readFileSync(join(dir, 'registry.mds'));
    assert.throws(() => registry!.createCredential(p.id, 'denied'), {
      code: 'SECURITY_AUDIT_CAPACITY',
    });
    assert.deepEqual(readFileSync(join(dir, 'registry.mds')), before);
    assert.equal(registry.listCredentials().length, 0);
    registry.close();
    writeFileSync(join(dir, 'registry.mds'), 'corrupt');
    assert.throws(() => SecurityRegistry.open(dir), { code: 'SECURITY_STORE_INVALID' });
    assert.equal(readFileSync(join(dir, 'registry.mds'), 'utf8'), 'corrupt');
    writeFileSync(join(dir, 'registry.mds'), before);
    unlinkSync(join(dir, 'registry.mds'));
    assert.throws(() => SecurityRegistry.open(dir), { code: 'SECURITY_STORE_INVALID' });
    assert.equal(existsSync(join(dir, 'registry.mds')), false);
    writeFileSync(join(dir, 'registry.mds'), before);
    unlinkSync(join(dir, 'instance.key'));
    assert.throws(() => SecurityRegistry.open(dir), { code: 'SECURITY_STORE_INVALID' });
    assert.equal(existsSync(join(dir, 'instance.key')), false);
  } finally {
    registry?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it(
  'critical audit persistence failure refuses mutations and retains the last committed ledger',
  windows,
  () => {
    const root = mkdtempSync(join(tmpdir(), 'modedb-security-write-'));
    const dir = join(root, 'security');
    const windowsProtector = new WindowsSecretProtector();
    let fail = false;
    const protector = {
      id: windowsProtector.id,
      ensureDirectory: (path: string) => windowsProtector.ensureDirectory(path),
      protect: (bytes: Uint8Array, purpose: string) => {
        if (fail) throw new Error('simulated ENOSPC');
        return windowsProtector.protect(bytes, purpose);
      },
      unprotect: (bytes: string, purpose: string) => windowsProtector.unprotect(bytes, purpose),
    };
    let registry: SecurityRegistry | undefined;
    try {
      registry = SecurityRegistry.open(dir, { protector });
      const p = registry.createPrincipal('app');
      const original = readFileSync(join(dir, 'registry.mds'));
      fail = true;
      assert.throws(() => registry!.createCredential(p.id, 'not-created'), {
        code: 'SECURITY_STORE_WRITE_FAILED',
      });
      assert.deepEqual(readFileSync(join(dir, 'registry.mds')), original);
      assert.throws(() => registry!.status(), { code: 'SECURITY_CLOSED' });
      fail = false;
      registry = SecurityRegistry.open(dir);
      assert.equal(registry.listCredentials().length, 0);
      assert.equal(
        registry.auditEvents().filter((e) => e.action === 'credential.create').length,
        0,
      );
    } finally {
      registry?.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it(
  'recovers the same initialized identity and audit commit after a separate process exits',
  windows,
  () => {
    const root = mkdtempSync(join(tmpdir(), 'modedb-security-crash-'));
    const dir = join(root, 'security');
    try {
      const child = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '--eval',
          `
      import {SecurityRegistry} from './packages/server/src/security/security-registry.ts';
      SecurityRegistry.open(process.env.SECURITY_TEST_DIR, {onCommitPoint(p) {if(p==='journaled') process.exit(73);}});
    `,
        ],
        {
          env: { ...process.env, SECURITY_TEST_DIR: dir },
          encoding: 'utf8',
          windowsHide: true,
          timeout: 30000,
        },
      );
      assert.equal(child.status, 73, child.stderr);
      const instance = JSON.parse(readFileSync(join(dir, 'instance.key'), 'utf8')).instanceId;
      const registry = SecurityRegistry.open(dir);
      try {
        assert.equal(registry.status().instanceId, instance);
        assert.equal(registry.auditEvents()[0]?.action, 'instance.initialize');
      } finally {
        registry.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it(
  'concurrent processes cannot own or independently initialize the same security registry',
  windows,
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'modedb-security-concurrency-'));
    const dir = join(root, 'security');
    const worker = `
    import {SecurityRegistry} from './packages/server/src/security/security-registry.ts';
    try { const r=SecurityRegistry.open(process.env.SECURITY_TEST_DIR); console.log(JSON.stringify({owner:true,id:r.status().instanceId}));
      process.stdin.resume(); process.stdin.once('data',()=>{r.close();process.exit(0);});
    } catch(e) { console.log(JSON.stringify({owner:false,code:e.code})); process.exit(0); }
  `;
    const children = [0, 1].map(() =>
      spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', worker], {
        env: { ...process.env, SECURITY_TEST_DIR: dir },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    );
    try {
      const states = await Promise.all(
        children.map(
          (child) =>
            new Promise<{ owner: boolean; id?: string; code?: string }>((done, reject) => {
              let text = '';
              const timer = setTimeout(
                () => reject(new Error('concurrent startup timed out')),
                30000,
              );
              child.stdout.on('data', (b) => {
                text += b;
                if (text.includes('\n')) {
                  clearTimeout(timer);
                  done(JSON.parse(text.trim()));
                }
              });
              child.once('error', (e) => {
                clearTimeout(timer);
                reject(e);
              });
            }),
        ),
      );
      assert.equal(states.filter((s) => s.owner).length, 1);
      assert.equal(states.find((s) => !s.owner)?.code, 'SECURITY_INSTANCE_BUSY');
      const owner = states.find((s) => s.owner)!;
      await Promise.all(
        children.map((child) =>
          child.exitCode !== null
            ? Promise.resolve()
            : new Promise<void>((done) => {
                child.once('close', () => done());
                child.stdin.write('close');
              }),
        ),
      );
      const registry = SecurityRegistry.open(dir);
      try {
        assert.equal(registry.status().instanceId, owner.id);
      } finally {
        registry.close();
      }
    } finally {
      children.forEach((c) => c.kill());
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it(
  'registry-mode servers reject unauthenticated management and legacy WebSocket upgrades',
  windows,
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'modedb-security-server-'));
    try {
      const config = ensureModelDbLayoutAtRoot(root);
      const cfg = await loadModelDBServerConfig(config, { port: 0 });
      const blockedPath = join(root, 'not-a-directory');
      writeFileSync(blockedPath, 'test');
      await assert.rejects(
        buildDualTrackFastify({ ...cfg, storageRoot: blockedPath, workspace: blockedPath }),
      );
      const afterFailure = SecurityRegistry.open(join(root, 'security'));
      afterFailure.close();
      const app = await buildDualTrackFastify(cfg);
      try {
        assert.equal((await app.inject({ method: 'GET', url: '/health' })).statusCode, 200);
        for (const url of [
          '/api/v1/management/status',
          '/api/v1/security/reset-access',
          '/api/v1/management/databases',
        ]) {
          const result = await app.inject({ method: 'GET', url });
          assert.equal(result.statusCode, 401);
          assert.equal(result.json().error, 'SECURITY_CREDENTIAL_INVALID');
        }
        const address = app.server.address();
        assert.ok(address && typeof address === 'object');
        await new Promise<void>((done, reject) => {
          const upgrade = httpRequest(`http://127.0.0.1:${address.port}/v2/stream`, {
            headers: {
              Connection: 'Upgrade',
              Upgrade: 'websocket',
              'Sec-WebSocket-Version': '13',
              'Sec-WebSocket-Key': Buffer.alloc(16).toString('base64'),
            },
          });
          const timer = setTimeout(() => {
            upgrade.destroy();
            reject(new Error('WS gate timed out'));
          }, 5000);
          upgrade.once('upgrade', (_response, socket) => {
            clearTimeout(timer);
            socket.destroy();
            reject(new Error('WS gate bypassed'));
          });
          upgrade.once('response', (response) => {
            clearTimeout(timer);
            response.resume();
            try {
              assert.equal(response.statusCode, 426);
              done();
            } catch (error) {
              reject(error);
            }
          });
          upgrade.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
          });
          upgrade.end();
        });
        const status = await callLocalSecurity(join(root, 'security'), { action: 'status' });
        assert.ok(status);
      } finally {
        await app.close();
      }
      const registry = SecurityRegistry.open(join(root, 'security'));
      registry.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it(
  'uses a Windows-authenticated local pipe and CLI one-time protected delivery',
  windows,
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'modedb-security-pipe-中文-'));
    const dir = join(root, 'security');
    let now = Date.now();
    let registry: SecurityRegistry | undefined;
    let channel: Awaited<ReturnType<typeof startLocalSecurityChannel>> | undefined;
    try {
      const config = ensureModelDbLayoutAtRoot(root);
      const cfg = await loadModelDBServerConfig(config, {});
      assert.equal(cfg.securityMode, 'registry');
      assert.equal(cfg.connectToken, '');
      assert.equal('connectToken' in JSON.parse(readFileSync(config, 'utf8')), false);
      registry = SecurityRegistry.open(dir, { now: () => now });
      channel = await startLocalSecurityChannel(dir, registry);
      const status = (await callLocalSecurity(dir, { action: 'status' })) as { instanceId: string };
      assert.equal(status.instanceId, registry.status().instanceId);
      const principal = (await callLocalSecurity(dir, {
        action: 'principal.create',
        name: '测试应用 cli-app',
      })) as { id: string; name: string };
      assert.equal(principal.name, '测试应用 cli-app');
      const delivery = join(root, 'delivery');
      new WindowsSecretProtector().ensureDirectory(delivery);
      const output = join(delivery, 'issued.json');
      // Asynchronous child: the parent event loop must serve the pipe while CLI runs.
      const cli = (args: string[]): Promise<{ code: number | null; output: string }> =>
        new Promise((done) => {
          const child = spawn(
            process.execPath,
            ['--import', 'tsx', 'packages/server/src/cli.ts', 'security', ...args, '-c', config],
            { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
          );
          let out = '';
          child.stdout.on('data', (b) => {
            out += b;
          });
          child.stderr.on('data', (b) => {
            out += b;
          });
          child.on('close', (code) => done({ code, output: out }));
        });
      const created = await cli([
        'token-create',
        '--principal',
        principal.id,
        '--name',
        'token',
        '--days',
        '1',
        '--output',
        output,
      ]);
      assert.equal(created.code, 0, created.output);
      const issued = JSON.parse(readFileSync(output, 'utf8')) as {
        token: string;
        credential: { id: string };
      };
      assert.equal(created.output.includes(issued.token), false);
      assert.equal(registry.authenticate(issued.token).credential.id, issued.credential.id);
      const auditOutput = join(delivery, 'audit.jsonl');
      const auditExport = await cli([
        'audit-export',
        '--output',
        auditOutput,
        '--category',
        'management',
      ]);
      assert.equal(auditExport.code, 0, auditExport.output);
      const exportedEvents = readFileSync(auditOutput, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { action: string });
      assert.ok(exportedEvents.length > 0);
      assert.equal(exportedEvents.some((event) => event.action === 'audit.export'), false);
      assert.ok(registry.auditEvents().some((event) => event.action === 'audit.export'));
      const forbiddenExport = await cli([
        'audit-export',
        '--output',
        join(dir, 'plaintext.jsonl'),
      ]);
      assert.notEqual(forbiddenExport.code, 0);
      assert.equal(existsSync(join(dir, 'plaintext.jsonl')), false);
      const oldSession = registry.createSession(issued.token);
      const rotatedFile = join(delivery, 'rotated.json');
      const rotation = await cli([
        'token-rotate',
        '--id',
        issued.credential.id,
        '--grace-minutes',
        '10',
        '--output',
        rotatedFile,
      ]);
      assert.equal(rotation.code, 0, rotation.output);
      const rotated = JSON.parse(readFileSync(rotatedFile, 'utf8')) as typeof issued;
      assert.equal(rotation.output.includes(rotated.token), false);
      assert.equal(registry.authenticate(issued.token).credential.id, issued.credential.id);
      assert.throws(() => registry!.verifySession(oldSession.session), {
        code: 'SECURITY_CREDENTIAL_REVOKED',
      });
      now += 600001;
      assert.throws(() => registry!.authenticate(issued.token), {
        code: 'SECURITY_CREDENTIAL_EXPIRED',
      });
      assert.equal(registry.authenticate(rotated.token).credential.id, rotated.credential.id);
      const listed = await cli(['credentials', '--limit', '1']);
      assert.equal(listed.code, 0, listed.output);
      const page = JSON.parse(listed.output);
      assert.equal(page.credentials.length, 1);
      assert.equal(page.total, 2);
      assert.equal(page.nextOffset, 1);
      assert.equal(listed.output.includes(issued.token), false);
      assert.equal(listed.output.includes('secretHash'), false);
      const duplicate = await cli([
        'token-create',
        '--principal',
        principal.id,
        '--name',
        'other',
        '--output',
        output,
      ]);
      assert.notEqual(duplicate.code, 0);
      assert.equal(registry.listCredentials().length, 2);
      const denied = await cli(['reset-access']);
      assert.notEqual(denied.code, 0);
      const revoke = await cli(['token-revoke', '--id', rotated.credential.id]);
      assert.equal(revoke.code, 0, revoke.output);
      assert.throws(() => registry!.authenticate(rotated.token), {
        code: 'SECURITY_CREDENTIAL_REVOKED',
      });
      const resetFile = join(delivery, 'reset.json');
      const beforeReset = await cli([
        'token-create',
        '--principal',
        principal.id,
        '--name',
        'reset',
        '--output',
        resetFile,
      ]);
      assert.equal(beforeReset.code, 0, beforeReset.output);
      const resetToken = JSON.parse(readFileSync(resetFile, 'utf8')).token as string;
      const resetSession = registry.createSession(resetToken);
      const reset = await cli(['reset-access', '--yes']);
      assert.equal(reset.code, 0, reset.output);
      assert.throws(() => registry!.authenticate(resetToken), {
        code: 'SECURITY_CREDENTIAL_REVOKED',
      });
      assert.throws(() => registry!.verifySession(resetSession.session), {
        code: 'SECURITY_CREDENTIAL_REVOKED',
      });
      const expiryFile = join(delivery, 'expiry.json');
      const expires = await cli([
        'token-create',
        '--principal',
        principal.id,
        '--name',
        'expiry',
        '--days',
        String(1 / 86400),
        '--output',
        expiryFile,
      ]);
      assert.equal(expires.code, 0, expires.output);
      const expiresToken = JSON.parse(readFileSync(expiryFile, 'utf8')).token as string;
      now += 1001;
      assert.throws(() => registry!.authenticate(expiresToken), {
        code: 'SECURITY_CREDENTIAL_EXPIRED',
      });
      // An anonymous OS identity cannot even open this named pipe.
      const probe = spawnSync(
        join(
          process.env.SystemRoot ?? 'C:\\Windows',
          'System32',
          'WindowsPowerShell',
          'v1.0',
          'powershell.exe',
        ),
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `
      $ErrorActionPreference='Stop'
      Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.IO.Pipes;
public static class PipeProbe {
 [DllImport("advapi32.dll")] public static extern bool ImpersonateAnonymousToken(IntPtr thread);
 [DllImport("advapi32.dll")] public static extern bool RevertToSelf();
 [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentThread();
 public static int Run(string name) {
   if (!ImpersonateAnonymousToken(GetCurrentThread())) return 91;
   try { using(var p=new NamedPipeClientStream(".",name,PipeDirection.InOut)) { p.Connect(2000); } return 92; }
   catch(UnauthorizedAccessException) { return 0; }
   finally { RevertToSelf(); }
 }
}
'@
      exit [PipeProbe]::Run($env:SECURITY_PIPE_NAME)
    `,
        ],
        {
          env: { ...process.env, SECURITY_PIPE_NAME: localManagementPipe(dir).split('\\').at(-1) },
          encoding: 'utf8',
          timeout: 20000,
          windowsHide: true,
        },
      );
      assert.equal(probe.status, 0, `Anonymous pipe test: ${probe.status}`);
      await assert.rejects(callLocalSecurity(dir, { action: 'engine.execute', command: 'reset' }), {
        code: 'SECURITY_INVALID_REQUEST',
      });
      assert.equal(registry.auditEvents().at(-1)?.action, 'maintenance.reject');
      assert.equal(registry.auditEvents().at(-1)?.result, 'denied');
      const largeGrants = Array.from({ length: 100 }, () => ({
        database: 'd'.repeat(96),
        resource: 'r'.repeat(96),
        actions: ['model.read'] as const,
      }));
      for (let i = 0; i < 5; i++)
        registry.createCredential(principal.id, `large-${i}`, largeGrants);
      await assert.rejects(callLocalSecurity(dir, { action: 'credentials.list' }), {
        code: 'SECURITY_RESPONSE_LIMIT',
      });
      const smallPage = (await callLocalSecurity(dir, {
        action: 'credentials.list',
        offset: 4,
        limit: 1,
      })) as { credentials: unknown[] };
      assert.equal(smallPage.credentials.length, 1);
      assert.ok(await callLocalSecurity(dir, { action: 'status' }));
      await assert.rejects(
        callLocalSecurity(dir, { action: 'status', padding: 'x'.repeat(65536) }),
        { code: 'SECURITY_INVALID_REQUEST' },
      );
    } finally {
      await channel?.close();
      registry?.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

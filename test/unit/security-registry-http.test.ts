import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { it } from 'node:test';
import { once } from 'node:events';
import { request as httpsRequest } from 'node:https';
import { fileURLToPath } from 'node:url';
import type { SecurityProtectionConfig, SecurityProtectionState, SecurityProtectionPreview, SecurityMaintenanceStatus } from '@mode-db/shared';
import { RemoteModelDBClient } from '@mode-db/sdk';
import { ensureModelDbLayoutAtRoot } from '../../packages/server/src/modeldb-default-home.js';
import { loadModelDBServerConfig } from '../../packages/server/src/config-loader.js';
import { SecurityRegistry } from '../../packages/server/src/security/security-registry.js';
import { buildDualTrackFastify } from '../../packages/server/src/dual-track-app.js';
import { callLocalSecurity } from '../../packages/server/src/security/local-management-channel.js';

const { WebSocket } = await import(new URL('../../packages/server/node_modules/ws/wrapper.mjs', import.meta.url).href) as typeof import('ws');

it(
  'real registry/DPAPI HTTPS server authorizes management and data through the native TLS listener',
  { skip: process.platform !== 'win32', timeout: 240000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'modedb-registry-tls-'));
    let app: Awaited<ReturnType<typeof buildDualTrackFastify>> | undefined;
    try {
      const config = ensureModelDbLayoutAtRoot(root);
      const cfg = await loadModelDBServerConfig(config, { port: 0 });
      const registry = SecurityRegistry.open(join(root, 'security'));
      let token: string;
      try {
        const principal = registry.createPrincipal('tls-operator', 'operator');
        token = registry.createCredential(principal.id, 'tls fixture', [
          {
            database: 'graph',
            resource: '*',
            actions: ['database.manage', 'schema.manage', 'model.read', 'model.write'],
          },
        ]).token;
      } finally {
        registry.close();
      }
      const certificateFile = fileURLToPath(
        new URL('../fixtures/security-tls/localhost.crt', import.meta.url),
      );
      app = await buildDualTrackFastify({
        ...cfg,
        securityNetwork: {
          transport: {
            mode: 'tls',
            certificateFile,
            privateKeyFile: fileURLToPath(
              new URL('../fixtures/security-tls/localhost.key', import.meta.url),
            ),
          },
        },
      });
      const address = app.server.address();
      assert.ok(address && typeof address === 'object');
      const port = address.port;
      const call = (
        path: string,
        payload?: unknown,
        extraHeaders: Record<string, string> = {},
        browser = false,
      ): Promise<{ status: number; body: Record<string, unknown>; cookies?: string[]; retryAfter?: string }> =>
        new Promise((resolve, reject) => {
          const req = httpsRequest(
            {
              hostname: '127.0.0.1',
              port,
              path,
              method: payload === undefined ? 'GET' : 'POST',
              ca: readFileSync(certificateFile),
              headers: {
                ...(browser ? {} : { authorization: `Bearer ${token}` }),
                'content-type': 'application/json',
                ...extraHeaders,
              },
            },
            (res) => {
              let body = '';
              res.setEncoding('utf8');
              res.on('data', (chunk) => {
                body += chunk;
              });
              res.on('end', () => {
                try {
                  resolve({
                    status: res.statusCode ?? 0,
                    body: (() => {
                      try {
                        return JSON.parse(body) as Record<string, unknown>;
                      } catch {
                        return { raw: body };
                      }
                    })(),
                    cookies: res.headers['set-cookie'],
                    retryAfter: res.headers['retry-after'],
                  });
                } catch (error) {
                  reject(error);
                }
              });
            },
          );
          req.once('error', reject);
          req.end(payload === undefined ? undefined : JSON.stringify(payload));
        });
      assert.equal(
        (
          await call('/api/v1/management/databases/graph/catalog', undefined, {
            origin: 'https://untrusted.example.com',
          })
        ).status,
        403,
      );
      assert.equal((await call('/api/v1/management/databases', { name: 'graph' })).status, 200);
      assert.equal((await call('/api/v1/security/context?database=graph')).status, 200);
      const frontend = 'https://localhost:5175';
      const pairing = await callLocalSecurity(join(root, 'security'), { action: 'session.pair', credentialId: (await callLocalSecurity(join(root, 'security'), { action: 'credentials.list' }) as { credentials: { id: string }[] }).credentials[0].id, lifetimeMinutes: 5, origin: frontend }) as { code: string };
      const paired = await call('/api/v1/security/pair', { code: pairing.code }, { origin: frontend }, true);
      assert.equal(paired.status, 200, JSON.stringify(paired.body));
      const cookies = paired.cookies;
      assert.ok(Array.isArray(cookies));
      assert.match(cookies[0], /HttpOnly; SameSite=Strict; Secure/);
      const cookie = cookies[0].split(';')[0];
      const sessionInfo = await call('/api/v1/security/session', undefined, { cookie, origin: frontend }, true);
      assert.equal(sessionInfo.status, 200, JSON.stringify(sessionInfo.body));
      const browserCatalog = await call('/api/v1/management/databases/graph/catalog', undefined, { cookie, origin: frontend }, true);
      assert.equal(browserCatalog.status, 200, JSON.stringify(browserCatalog.body));
      assert.equal((await call('/api/v1/security/admin/overview')).status, 401);
      assert.equal((await call('/api/v1/security/admin/overview', undefined, { cookie, origin: frontend }, true)).status, 403);
      const browserAudit = await call(
        '/api/v1/security/admin/audit',
        undefined,
        { cookie, origin: frontend },
        true,
      );
      assert.equal(browserAudit.status, 403, JSON.stringify(browserAudit.body));
      assert.equal(
        (
          await call(
            '/api/v1/security/admin/audit/export',
            undefined,
            { cookie, origin: frontend },
            true,
          )
        ).status,
        403,
      );

      const adminPairing = (await callLocalSecurity(join(root, 'security'), {
        action: 'browser.security.launch',
        origin: frontend,
        databases: [],
      })) as { code: string };
      const adminPaired = await call('/api/v1/security/pair', { code: adminPairing.code }, { origin: frontend }, true);
      assert.equal(adminPaired.status, 200, JSON.stringify(adminPaired.body));
      assert.equal(adminPaired.body.securityAdmin, true);
      const adminCookie = adminPaired.cookies?.[0]?.split(';')[0];
      assert.ok(adminCookie);
      const adminOverview = await call('/api/v1/security/admin/overview', undefined, { cookie: adminCookie, origin: frontend }, true);
      assert.equal(adminOverview.status, 200, JSON.stringify(adminOverview.body));
      const adminAudit = await call(
        '/api/v1/security/admin/audit?limit=10',
        undefined,
        { cookie: adminCookie, origin: frontend },
        true,
      );
      assert.equal(adminAudit.status, 200, JSON.stringify(adminAudit.body));
      assert.equal(adminAudit.body.version, 1);
      assert.ok(Array.isArray(adminAudit.body.events));
      assert.equal(JSON.stringify(adminAudit.body).includes(token), false);
      assert.equal(
        (
          await call(
            '/api/v1/security/admin/audit?category=data&category=network',
            undefined,
            { cookie: adminCookie, origin: frontend },
            true,
          )
        ).status,
        400,
      );
      assert.equal(
        (
          await call(
            '/api/v1/security/admin/audit/export?unexpected=true',
            undefined,
            { cookie: adminCookie, origin: frontend },
            true,
          )
        ).status,
        400,
      );
      const auditExport = await call(
        '/api/v1/security/admin/audit/export',
        undefined,
        { cookie: adminCookie, origin: frontend },
        true,
      );
      assert.equal(auditExport.status, 200, JSON.stringify(auditExport.body));
      const exportedAuditEvents = String(auditExport.body.raw)
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { action: string });
      assert.ok(exportedAuditEvents.length > 0);
      assert.equal(exportedAuditEvents.some((event) => event.action === 'audit.export'), false);
      assert.equal((await call('/api/v1/management/databases/graph/catalog', undefined, { cookie: adminCookie, origin: frontend }, true)).status, 403);
      const overviewText = JSON.stringify(adminOverview.body);
      assert.equal(overviewText.includes('secretHash'), false);
      assert.equal(overviewText.includes(token), false);
      assert.equal(overviewText.includes(adminCookie), false);

      const adminSession = await call('/api/v1/security/session', undefined, { cookie: adminCookie, origin: frontend }, true);
      assert.equal(adminSession.status, 200, JSON.stringify(adminSession.body));
      assert.equal(adminSession.body.securityAdmin, true);
      const adminRefresh = await call('/api/v1/security/session/refresh', {}, {
        cookie: adminCookie,
        origin: frontend,
        'x-modeldb-csrf': adminSession.body.csrf as string,
      }, true);
      assert.equal(adminRefresh.status, 200, JSON.stringify(adminRefresh.body));
      const refreshedAdminCookie = adminRefresh.cookies?.[0]?.split(';')[0];
      assert.ok(refreshedAdminCookie);
      const refreshedAdminSession = await call('/api/v1/security/session', undefined, {
        cookie: refreshedAdminCookie,
        origin: frontend,
      }, true);
      assert.equal(refreshedAdminSession.body.securityAdmin, true);
      assert.equal((await call('/api/v1/security/admin/overview', undefined, {
        cookie: refreshedAdminCookie,
        origin: frontend,
      }, true)).status, 200);
      assert.equal((await call('/api/v1/security/admin/control', { action: 'network.status' }, { cookie, origin: frontend, 'x-modeldb-csrf': paired.body.csrf as string }, true)).status, 403);
      const logout = await call('/api/v1/security/session/logout', {}, { cookie, origin: frontend, 'x-modeldb-csrf': paired.body.csrf as string }, true);
      assert.equal(logout.status, 200, JSON.stringify(logout.body));
      const ddl = await call('/api/v1/rpc', {
        version: 1,
        database: 'graph',
        operation: { op: 'registerModel', model: 'Item', schema: { name: 'String' } },
      });
      assert.equal(ddl.status, 200, JSON.stringify(ddl.body));
      const insert = await call('/api/v1/rpc', {
        version: 1,
        database: 'graph',
        operation: { op: 'insert', model: 'Item', data: { name: 'TLS row' }, sync: true },
      });
      assert.equal(insert.status, 200, JSON.stringify(insert.body));
      assert.equal((await call('/api/v1/management/databases/graph/catalog')).status, 200);
      assert.equal(
        (await call('/api/v1/security/context?database=graph', undefined, { authorization: '' }))
          .status,
        401,
      );

      const controlPath = '/api/v1/security/admin/control';
      const adminHeaders = { cookie: refreshedAdminCookie, origin: frontend, 'x-modeldb-csrf': refreshedAdminSession.body.csrf as string };
      const control = async <T>(body: unknown): Promise<T> => {
        const response = await call(controlPath, body, adminHeaders, true);
        assert.equal(response.status, 200, JSON.stringify(response.body));
        return response.body as T;
      };
      assert.equal((await call(controlPath, { action: 'network.status' })).status, 401);
      assert.equal((await call(controlPath, { action: 'network.status' }, { cookie: refreshedAdminCookie, origin: frontend }, true)).status, 403);
      assert.equal((await call(controlPath, { action: 'network.status' }, { cookie, origin: frontend, 'x-modeldb-csrf': paired.body.csrf as string }, true)).status, 401);
      assert.equal((await call(controlPath, { action: 'factory.reset', confirm: true }, adminHeaders, true)).status, 400);
      const originalPolicy = await control<SecurityProtectionState>({ action: 'network.status' });
      const apply = async (config: SecurityProtectionConfig) => {
        const preview = await control<SecurityProtectionPreview>({ action: 'network.preview', config });
        return control<SecurityProtectionState>({ action: 'network.apply', config, revision: preview.revision, previewId: preview.id });
      };
      const stream = new WebSocket(`wss://127.0.0.1:${port}/api/v1/stream`, { ca: readFileSync(certificateFile) });
      try {
        await once(stream, 'open', { signal: AbortSignal.timeout(15000) });
        const ready = once(stream, 'message', { signal: AbortSignal.timeout(15000) });
        stream.send(JSON.stringify({ type: 'security.hello', version: 1, database: 'graph', token }));
        assert.equal(JSON.parse((await ready)[0].toString()).type, 'security.ready');
        const closed = once(stream, 'close', { signal: AbortSignal.timeout(30000) });
        const denied = await apply({ ...originalPolicy.config, data: { allowListEnabled: false, deny: [{ id: 'integration-deny', source: '127.0.0.1', reason: 'synthetic integration check' }] } });
        assert.equal((await closed)[0], 1008, 'established authenticated WS closes after a rule change');
        assert.equal((await call('/api/v1/security/context?database=graph')).status, 403);
        await control({ action: 'network.confirm', id: denied.pending!.id });
        const confirmed = await control<SecurityProtectionState>({ action: 'network.status' });
        await control({ action: 'network.rollback', revision: confirmed.revision });
        assert.equal((await call('/api/v1/security/context?database=graph')).status, 200);
      } finally { stream.terminate(); }
      console.log('[security-protection] TLS/WS policy preview, apply, confirm and rollback passed');
      const lockout = await apply({ ...originalPolicy.config, management: { allowListEnabled: true, allow: [] } });
      assert.equal((await call(controlPath, { action: 'network.status' }, adminHeaders, true)).status, 403);
      await callLocalSecurity(join(root, 'security'), { action: 'network.rollback', revision: lockout.revision });
      assert.equal((await call(controlPath, { action: 'network.status' }, adminHeaders, true)).status, 200, 'OS pipe repairs an HTTP management lockout');
      console.log('[security-protection] OS pipe repaired management lockout');
      const limited = await apply({ ...originalPolicy.config, rate: { ...originalPolicy.config.rate, windowSeconds: 1, dataRequests: 2 } });
      await control({ action: 'network.confirm', id: limited.pending!.id });
      await new Promise((done) => setTimeout(done, 1100));
      assert.equal((await call('/api/v1/security/context?database=graph')).status, 200);
      assert.equal((await call('/api/v1/security/context?database=graph')).status, 200);
      const throttled = await call('/api/v1/security/context?database=graph');
      assert.equal(throttled.status, 429);
      assert.equal(throttled.retryAfter, '1');
      const current = await control<SecurityProtectionState>({ action: 'network.status' });
      await control({ action: 'network.rollback', revision: current.revision });
      const banning = await apply({ ...originalPolicy.config, rate: { ...originalPolicy.config.rate, authenticationFailures: 1, autoBan: true, windowSeconds: 1 } });
      await control({ action: 'network.confirm', id: banning.pending!.id });
      await new Promise((done) => setTimeout(done, 1100));
      assert.equal((await call('/api/v1/security/context?database=graph', undefined, { authorization: '' })).status, 401);
      assert.equal((await call('/api/v1/security/context?database=graph')).status, 429);
      const banned = await control<SecurityProtectionState>({ action: 'network.status' });
      assert.equal(banned.bans.length, 1);
      await control({ action: 'network.unban', id: banned.bans[0]!.id });
      assert.equal((await call('/api/v1/security/context?database=graph')).status, 200);
      await control({ action: 'network.rollback', revision: (await control<SecurityProtectionState>({ action: 'network.status' })).revision });
      console.log('[security-protection] HTTP rate limit and temporary ban/unban passed');
      const beforeKeys = await control<SecurityMaintenanceStatus>({ action: 'maintenance.status' });
      const vaultPath = join(cfg.workspace ?? cfg.storageRoot, 'graph', 'atlas.mld');
      const beforeVault = readFileSync(vaultPath);
      await control({ action: 'master.rotate', confirm: true });
      const afterKeys = await control<SecurityMaintenanceStatus>({ action: 'maintenance.status' });
      assert.notEqual(beforeKeys.keys.masterKeyId, afterKeys.keys.masterKeyId);
      assert.equal(afterKeys.keys.rotation?.phase, 'completed');
      assert.deepEqual(readFileSync(vaultPath), beforeVault);
      const events = await call('/api/v1/security/admin/audit?category=network', undefined, adminHeaders, true);
      assert.equal(events.status, 200);
      assert.ok((events.body.events as { ruleId?: string }[]).some((event) => event.ruleId === 'integration-deny'));
      const managementEvents = await call('/api/v1/security/admin/audit?action=network.apply', undefined, adminHeaders, true);
      assert.ok((managementEvents.body.events as { actor: { identityTrust: string }; source: { clientIp: string }; requestId?: string }[]).every((event) => event.actor.identityTrust === 'verified' && event.source.clientIp === '127.0.0.1' && event.requestId));
    } finally {
      await app?.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it(
  'real registry/DPAPI server gates scoped database management and reopens restored Vaults',
  { skip: process.platform !== 'win32' },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'modedb-registry-http-'));
    let app: Awaited<ReturnType<typeof buildDualTrackFastify>> | undefined;
    let client: RemoteModelDBClient | undefined;
    try {
      const config = ensureModelDbLayoutAtRoot(root);
      const cfg = await loadModelDBServerConfig(config, { port: 0 });
      const registry = SecurityRegistry.open(join(root, 'security'));
      let token: string;
      let reader: string;
      try {
        const principal = registry.createPrincipal('operator', 'operator');
        token = registry.createCredential(principal.id, 'graph management', [
          {
            database: 'graph',
            resource: '*',
            actions: [
              'database.manage',
              'schema.manage',
              'model.read',
              'model.write',
              'backup.manage',
              'transfer.import',
              'transfer.export',
            ],
          },
        ]).token;
        reader = registry.createCredential(principal.id, 'graph reader', [
          { database: 'graph', resource: '*', actions: ['model.read'] },
        ]).token;
      } finally {
        registry.close();
      }
      app = await buildDualTrackFastify(cfg);
      const headers = { authorization: `Bearer ${token}` };
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/management/databases',
            headers: { authorization: `Bearer ${reader}` },
            payload: { name: 'graph' },
          })
        ).statusCode,
        403,
      );
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/management/databases',
        headers,
        payload: { name: 'graph' },
      });
      assert.equal(created.statusCode, 200, created.body);
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/management/databases',
            headers,
            payload: { name: 'other' },
          })
        ).statusCode,
        403,
      );
      const address = app.server.address();
      assert.ok(address && typeof address === 'object');
      client = await RemoteModelDBClient.connect({
        url: `http://127.0.0.1:${address.port}`,
        dbName: 'graph',
        token,
        mode: 'short',
      });
      await client.apply({ op: 'registerModel', model: 'Item', schema: { name: 'String' } });
      await client.model('Item').insertOne({ name: 'before backup' }, { sync: true });
      const catalog = await app.inject({
        url: '/api/v1/management/databases/graph/catalog',
        headers,
      });
      assert.equal(catalog.statusCode, 200, catalog.body);
      assert.equal(catalog.json().models[0].name, 'Item');
      const backup = await app.inject({
        method: 'POST',
        url: '/api/v1/management/databases/graph/backup',
        headers,
        payload: { name: 'test snapshot' },
      });
      assert.equal(backup.statusCode, 200, backup.body);
      assert.equal(backup.json().backup.path, undefined);
      const clear = await app.inject({
        method: 'POST',
        url: '/api/v1/management/databases/graph/clear',
        headers,
        payload: {},
      });
      assert.equal(clear.statusCode, 200, clear.body);
      assert.equal(((await client.model('Item').query().execute()) as unknown[]).length, 0);
      const restored = await app.inject({
        method: 'POST',
        url: '/api/v1/management/databases/graph/restore',
        headers,
        payload: { backupFile: backup.json().backup.fileName },
      });
      assert.equal(restored.statusCode, 200, restored.body);
      assert.equal(((await client.model('Item').query().execute()) as unknown[]).length, 1);
      const reset = await app.inject({
        method: 'POST',
        url: '/api/v1/management/databases/graph/clear',
        headers,
        payload: { forceReset: true },
      });
      assert.equal(reset.statusCode, 403);
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/security/reset-access',
            headers,
            payload: {},
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject({
            method: 'DELETE',
            url: '/api/v1/management/databases/graph',
            headers: { authorization: `Bearer ${reader}` },
          })
        ).statusCode,
        403,
      );
      const dropped = await app.inject({
        method: 'DELETE',
        url: '/api/v1/management/databases/graph',
        headers,
      });
      assert.equal(dropped.statusCode, 200, dropped.body);
      const list = await app.inject({ url: '/api/v1/management/databases', headers });
      assert.deepEqual(list.json().databases, []);
    } finally {
      client?.close();
      await app?.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

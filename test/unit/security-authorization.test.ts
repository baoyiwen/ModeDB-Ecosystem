import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import Fastify from '../../packages/server/node_modules/fastify/fastify.js';
import type websocketType from '../../packages/server/node_modules/@fastify/websocket/types/index.js';
import { AuthoringEngine } from '@mode-db/core';
import { ModelDB, RemoteModelDBClient, ConnectionSecurityError, pairBrowserSession, getBrowserSession, refreshBrowserSession, logoutBrowserSession } from '@mode-db/sdk';
const { WebSocket } = await import(new URL('../../packages/server/node_modules/ws/wrapper.mjs', import.meta.url).href) as typeof import('ws');
import {
  securityReleaseDigest,
  interfaceParameterPlaceholder,
  type WireExecuteBody,
  type SecurityGrant,
  type PublishedOperationExecutionTemplate,
} from '@mode-db/shared';
import { SecurityRegistry } from '../../packages/server/src/security/security-registry.js';
import { SecurityError } from '../../packages/server/src/security/security-errors.js';
import { AuthorizationService } from '../../packages/server/src/security/authorization-service.js';
import { installRegistryEntrypoints } from '../../packages/server/src/security/registry-entrypoints.js';
import { WireRequestDispatcher } from '../../packages/server/src/request-dispatcher.js';
import { WriteSerializationGate } from '../../packages/server/src/write-serialization-gate.js';
import { fixtureVaultKeys } from '../vault-keys.js';
import {
  SecurityNetworkPolicy,
  type SecurityNetworkConfig,
} from '../../packages/server/src/security/network-policy.js';
import { installSecurityNetworkBoundary } from '../../packages/server/src/security/network-boundary.js';
import { buildInterfaceCallDocs } from '../../apps/model-designer/src/query-designer/interface-call-docs.js';
import type { QueryInterfaceRelease } from '../../apps/model-designer/src/query-designer/query-interface-publication.js';

const { default: websocket } = (await import(
  new URL('../../packages/server/node_modules/@fastify/websocket/index.js', import.meta.url).href
)) as { default: typeof websocketType };

const release = {
  version: '1.0.0',
  publishedAt: '2026-10-20T00:00:00.000Z',
  callableName: 'ListItems',
  signature: 'unchanged',
  queryInterface: {
    status: 'active',
    contract: { permissions: { mode: 'none' }, parameters: [] },
    query: { pagination: { mode: 'none' } },
  },
  executionTemplate: {
    format: 1,
    snapshot: {
      plan: {
        version: 2,
        originModel: 'Item',
        start: { kind: 'all' },
        hops: [],
        trailing: { type: 'atom', field: 'name', op: 'eq', value: 'visible' },
      },
      execute: {},
      analysis: { groupBy: null, compute: null },
    },
    parameters: [],
    resultAdapter: {
      kind: 'rows',
      rootNodeId: 'item',
      fieldsByNode: { item: [{ sourceField: 'name', outputName: 'label' }] },
      edgesBySource: {},
    },
    pagination: { mode: 'none' },
  },
};

async function fixture(
  run: (ctx: {
    app: Awaited<ReturnType<typeof Fastify>>;
    registry: SecurityRegistry;
    business: AuthoringEngine;
    designer: AuthoringEngine;
    releaseRowId: string;
    gate: WriteSerializationGate;
    dispatcher: WireRequestDispatcher;
    create: (grants: readonly SecurityGrant[]) => ReturnType<SecurityRegistry['createCredential']>;
    rpc: (
      token: string,
      operation: WireExecuteBody,
      database?: string,
      extraHeaders?: Record<string, string>,
    ) => ReturnType<Awaited<ReturnType<typeof Fastify>>['inject']>;
    origin: string;
  }) => Promise<void>,
  options: { failFirstHealth?: boolean; network?: SecurityNetworkConfig; now?: () => number; manage?: Parameters<typeof installRegistryEntrypoints>[0]['manage'] } = {},
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'modedb-authz-'));
  // In-process encrypted test protector; Windows/DPAPI is covered by the separate OS suite.
  const key = randomBytes(32);
  const protector = {
    id: 'test-aes-gcm',
    ensureDirectory: (path: string) => {
      mkdirSync(path, { recursive: true });
    },
    protect(bytes: Uint8Array, purpose: string): string {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(Buffer.from(purpose));
      const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64');
    },
    unprotect(value: string, purpose: string): Buffer {
      const bytes = Buffer.from(value, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      decipher.setAAD(Buffer.from(purpose));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
    },
  };
  const registry = SecurityRegistry.open(join(root, 'security'), { protector, now: options.now });
  const business = new AuthoringEngine({
    atlas: 'business',
    storageRoot: root,
    keyProvider: fixtureVaultKeys(root),
    engineLogger: false,
  });
  const designer = new AuthoringEngine({
    atlas: 'designer',
    storageRoot: root,
    keyProvider: fixtureVaultKeys(root),
    engineLogger: false,
  });
  const app = Fastify();
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  const network = options.network
    ? new SecurityNetworkPolicy(
        options.network,
        { host: '127.0.0.1', port: 9091, directory: root },
        options.now,
      )
    : undefined;
  if (network) installSecurityNetworkBoundary(app, network);
  try {
    business.registerModel('Item', { name: 'String', secret: 'String' });
    await business.insert(
      'Item',
      { name: 'visible', secret: 'hidden-business-value' },
      { sync: true },
    );
    designer.registerModel('sys_query_interface', {
      library_code: 'String',
      release_json: 'String',
      release_history_json: 'String',
    });
    const row = await designer.insert(
      'sys_query_interface',
      { library_code: 'business', release_json: JSON.stringify(release), release_history_json: '' },
      { sync: true },
    );
    const engines = new Map([
      ['business', business],
      ['designer', designer],
    ]);
    const getEngine = async (database: string): Promise<AuthoringEngine> => {
      const engine = engines.get(database);
      assert.ok(engine);
      return engine;
    };
    const gate = new WriteSerializationGate();
    const dispatcher = new WireRequestDispatcher({
      dev: false,
      getEngine,
      writeGate: gate,
      designerWorkspace: 'designer',
    });
    await app.register(websocket);
    let failHealth = options.failFirstHealth === true;
    app.get('/health', async (_request, reply) => {
      if (failHealth) {
        failHealth = false;
        return reply.code(503).send({ error: 'SECURITY_CONNECTION_UNAVAILABLE' });
      }
      return { ok: true, security: { mode: 'registry', protocol: 1 } };
    });
    // A legacy handler that must never be reached by an authenticated registry request.
    app.post('/v2/action', async () => {
      throw new Error('legacy bypass');
    });
    app.get('/api/v1/management/databases', async () => {
      throw new Error('legacy management bypass');
    });
    installRegistryEntrypoints({
      manage: options.manage,
      backupKeys: fixtureVaultKeys(root),
      app,
      registry,
      network,
      dispatcher,
      designerWorkspace: 'designer',
      workspace: root,
      writeGate: gate,
      getEngine,
      listDatabases: () => [
        { name: 'business', status: 'active' },
        { name: 'designer', status: 'active' },
        { name: 'other', status: 'active' },
      ],
      catalog: async (database) => ({
        database,
        models: [
          {
            name: 'Item',
            parentId: null,
            fields: ['name'],
            fieldLabels: { name: { zh: '名称', en: 'Name' } },
            fieldTypes: { name: 'String' },
          },
        ],
        relations: [],
      }),
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    const principal = registry.createPrincipal('test-app');
    const create = (
      grants: readonly SecurityGrant[],
    ): ReturnType<SecurityRegistry['createCredential']> =>
      registry.createCredential(principal.id, 'test', grants);
    await run({
      app,
      registry,
      business,
      designer,
      releaseRowId: row._id,
      gate,
      dispatcher,
      create,
      origin,
      rpc: (token, operation, database = 'business', extraHeaders = {}) =>
        app.inject({
          method: 'POST',
          url: '/api/v1/rpc',
          headers: { authorization: `Bearer ${token}`, ...extraHeaders },
          payload: { version: 1, database, operation },
        }),
    });
  } finally {
    for (const socket of app.websocketServer.clients) socket.terminate();
    await app.close();
    await Promise.all([business.close(), designer.close()]);
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
}

it(
  'source expiry affects existing WS messages and queued writes before any new mutation',
  { timeout: 15000 },
  async () => {
    let now = Date.now();
    const expiresAt = new Date(now + 1000).toISOString();
    await fixture(
      async ({ create, origin, rpc, gate, business }) => {
        const { token } = create([
          { database: 'business', resource: '*', actions: ['model.read', 'model.write'] },
        ]);
        const stream = await RemoteModelDBClient.connect({
          url: origin,
          dbName: 'business',
          token,
          mode: 'stream',
        });
        const run = gate.runExclusive.bind(gate);
        let release!: () => void;
        let entered!: () => void;
        const holding = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const block = run(
          'business',
          () =>
            new Promise<void>((resolve) => {
              release = resolve;
              entered();
            }),
        );
        await holding;
        let queued!: () => void;
        const waiting = new Promise<void>((resolve) => {
          queued = resolve;
        });
        gate.runExclusive = (atlas, work) => {
          const result = run(atlas, work);
          queued();
          return result;
        };
        try {
          const pending = Promise.resolve(
            rpc(token, { op: 'insert', model: 'Item', data: { name: 'must-not-appear' } }),
          );
          await waiting;
          now += 1000;
          release();
          await block;
          const result = await pending;
          assert.equal(result.statusCode, 403, result.body);
          assert.equal(result.json().error, 'SECURITY_SOURCE_DENIED');
          await assert.rejects(
            stream.model('Item').query().execute(),
            (error: unknown) =>
              error instanceof ConnectionSecurityError && error.code === 'SECURITY_SOURCE_DENIED',
          );
          assert.equal((await business.persistence.getMergedReader().getAll('Item')).length, 1);
        } finally {
          release();
          stream.close();
          gate.runExclusive = run;
        }
      },
      {
        now: () => now,
        network: {
          data: {
            allowListEnabled: true,
            allow: [{ id: 'temporary-local', source: '127.0.0.1', expiresAt }],
          },
        },
      },
    );
  },
);

it('browser pairing binds Origin, session CSRF, actual expiry and safe logout', async () => {
  await fixture(async ({ app, registry, create }) => {
    const credential = create([{ database: 'business', resource: '*', actions: ['model.read'] }]);
    const origin = 'http://127.0.0.1:5175';
    const pairing = registry.createPairingForCredential(credential.credential.id, 5, origin);
    const rejected = await app.inject({ method: 'POST', url: '/api/v1/security/pair', headers: { origin: 'https://evil.example' }, payload: { code: pairing.code } });
    assert.equal(rejected.statusCode, 403);
    const paired = await app.inject({ method: 'POST', url: '/api/v1/security/pair', headers: { origin }, payload: { code: pairing.code } });
    assert.equal(paired.statusCode, 200, paired.body);
    const setCookie = paired.headers['set-cookie'];
    assert.ok(Array.isArray(setCookie));
    assert.equal(setCookie.length, 1);
    assert.match(setCookie[0], /HttpOnly; SameSite=Strict/);
    const cookie = setCookie[0].split(';')[0];
    const csrf = paired.json().csrf as string;
    const otherOrigin = 'http://127.0.0.1:5176';
    const otherPairing = registry.createPairingForCredential(credential.credential.id, 5, otherOrigin);
    const otherPaired = await app.inject({ method: 'POST', url: '/api/v1/security/pair', headers: { origin: otherOrigin }, payload: { code: otherPairing.code } });
    const otherCookies = otherPaired.headers['set-cookie'];
    assert.ok(Array.isArray(otherCookies));
    assert.notEqual(otherCookies[0].split('=')[0], cookie.split('=')[0]);
    const combined = cookie + '; ' + otherCookies[0].split(';')[0];
    for (const activeOrigin of [origin, otherOrigin]) {
      assert.equal((await app.inject({ method: 'GET', url: '/api/v1/security/session', headers: { cookie: combined, origin: activeOrigin } })).statusCode, 200);
    }
    const session = await app.inject({ method: 'GET', url: '/api/v1/security/session', headers: { cookie, origin } });
    assert.equal(session.statusCode, 200, session.body);
    assert.equal(session.headers['cache-control'], 'no-store');
    assert.equal(session.json().expiresAt, paired.json().expiresAt);
    assert.equal(session.json().csrf, csrf);
    assert.ok(Date.parse(session.json().expiresAt) < Date.parse(credential.credential.expiresAt));
    for (const path of ['/api/v1/security/session/refresh', '/api/v1/security/session/logout']) {
      const missing = await app.inject({ method: 'POST', url: path, headers: { cookie, origin } });
      assert.equal(missing.statusCode, 403);
      assert.equal(missing.headers['set-cookie'], undefined);
      const forged = 'a'.repeat(64);
      const forgedResponse = await app.inject({ method: 'POST', url: path, headers: { cookie: cookie + '; mdbs_csrf=' + forged, origin, 'x-modeldb-csrf': forged } });
      assert.equal(forgedResponse.statusCode, 403);
    }
    const body = { version: 1, database: 'business', operation: { op: 'executeQuery', snapshot: release.executionTemplate.snapshot } };
    const rpc = await app.inject({ method: 'POST', url: '/api/v1/rpc', headers: { cookie, origin, 'x-modeldb-csrf': csrf }, payload: body });
    assert.equal(rpc.statusCode, 200, rpc.body);
    for (const headers of [
      { cookie, origin },
      { cookie, origin: 'https://evil.example', 'x-modeldb-csrf': csrf },
      { cookie: cookie + '; ' + cookie, origin, 'x-modeldb-csrf': csrf },
      { cookie, origin, authorization: 'Bearer invalid', 'x-modeldb-csrf': csrf },
    ]) {
      const denied = await app.inject({ method: 'POST', url: '/api/v1/rpc', headers, payload: body });
      assert.ok([401, 403].includes(denied.statusCode), denied.body);
    }
    const refreshed = await app.inject({ method: 'POST', url: '/api/v1/security/session/refresh', headers: { cookie, origin, 'x-modeldb-csrf': csrf } });
    assert.equal(refreshed.statusCode, 200, refreshed.body);
    const refreshedCookies = refreshed.headers['set-cookie'];
    assert.ok(Array.isArray(refreshedCookies));
    const refreshedCookie = refreshedCookies[0].split(';')[0];
    assert.notEqual(refreshed.json().csrf, csrf);
    const old = await app.inject({ method: 'GET', url: '/api/v1/security/session', headers: { cookie, origin } });
    assert.equal(old.statusCode, 401);
    const loggedOut = await app.inject({ method: 'POST', url: '/api/v1/security/session/logout', headers: { cookie: refreshedCookie, origin, 'x-modeldb-csrf': refreshed.json().csrf } });
    assert.equal(loggedOut.statusCode, 200, loggedOut.body);
    const afterLogout = await app.inject({ method: 'GET', url: '/api/v1/security/session', headers: { cookie: refreshedCookie, origin } });
    assert.equal(afterLogout.statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/security/pair', headers: { origin }, payload: { code: pairing.code } })).statusCode, 401);
    assert.ok(registry.auditEvents().some((e) => e.action === 'pairing.consume' && e.source.transport === 'http' && e.actor.credentialId === credential.credential.id));
  });
});

it('pins canonical releases, projects only published fields and denies cross-database/raw/sys/instance access', async () => {
  await fixture(async ({ app, create, rpc, registry, designer, releaseRowId, dispatcher }) => {
    const { token } = create([
      {
        database: 'business',
        resource: 'ListItems',
        actions: ['callable.query'],
        releaseDigest: securityReleaseDigest(release),
      },
    ]);
    assert.equal(securityReleaseDigest({ b: 2, a: 1 }), securityReleaseDigest({ a: 1, b: 2 }));
    const direct = await dispatcher.executeAuthorized(
      'business',
      { op: 'executeInterface', callableName: 'ListItems' },
      new AuthorizationService(() => registry.authenticate(token), 'designer'),
    );
    assert.equal(direct.kind, 'interface');
    const result = await rpc(
      token,
      { op: 'executeInterface', callableName: 'ListItems' },
      'business',
      {
        'x-modeldb-role': 'admin',
        'x-modeldb-user-subject': 'external-user',
        'x-modeldb-tenant': 'other',
      },
    );
    assert.equal(result.statusCode, 200, result.body);
    assert.deepEqual(result.json().result.rows, [{ label: 'visible' }]);
    assert.ok(!result.body.includes('hidden-business-value'));
    const directHttp = await app.inject({
      method: 'POST',
      url: '/api/v1/databases/business/query-interfaces/ListItems',
      headers: { authorization: `Bearer ${token}` },
      payload: { version: '1.0.0', parameters: {} },
    });
    assert.equal(directHttp.statusCode, 200, directHttp.body);
    assert.deepEqual(directHttp.json().rows, [{ label: 'visible' }]);
    const conflicting = await rpc(
      token,
      { op: 'executeInterface', callableName: 'ListItems' },
      'business',
      { 'x-modeldb-connect-token': 'legacy-token' },
    );
    assert.equal(conflicting.statusCode, 401);
    const list = await app.inject({
      url: '/api/v1/management/databases',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.deepEqual(
      list.json().databases.map((db: { name: string }) => db.name),
      ['business'],
    );
    for (const [database, body] of [
      ['other', { op: 'executeInterface', callableName: 'ListItems' }],
      ['business', { op: 'executeQuery', snapshot: release.executionTemplate.snapshot }],
      ['designer', { op: 'clearAllData' }],
      ['business', { op: 'bindPair', forward: 'any' }],
      ['business', { op: 'insertMany', model: 'Item', rows: [] }],
    ] as const)
      assert.equal((await rpc(token, body as WireExecuteBody, database)).statusCode, 403);
    for (const url of [
      '/api/v1/management/status',
      '/api/v1/security/reset-access',
      '/api/v1/management/databases/business/catalog',
      '/api/v1/management/backups?database=business',
    ]) {
      assert.equal(
        (await app.inject({ url, headers: { authorization: `Bearer ${token}` } })).statusCode,
        403,
      );
    }
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/v2/action',
          payload: {},
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
      426,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/rpc',
          payload: { version: 1, database: 'business', operation: { op: 'clearAllData' } },
        })
      ).statusCode,
      401,
    );
    const audit = registry.auditEvents();
    assert.ok(
      audit.some(
        (event) =>
          event.actor.userSubject === 'external-user' &&
          event.actor.userSubjectTrust === 'application-asserted' &&
          event.actor.identityTrust === 'verified',
      ),
    );
    assert.ok(
      !JSON.stringify(audit).includes(token) &&
        !JSON.stringify(audit).includes('hidden-business-value'),
    );
    const expanded = structuredClone(release);
    expanded.executionTemplate.resultAdapter.fieldsByNode.item.push({
      sourceField: 'secret',
      outputName: 'secret',
    });
    await designer.update(
      'sys_query_interface',
      releaseRowId,
      { release_json: JSON.stringify(expanded) },
      { sync: true },
    );
    const refused = await rpc(token, { op: 'executeInterface', callableName: 'ListItems' });
    assert.equal(refused.statusCode, 403);
    assert.equal(refused.json().error, 'SECURITY_RELEASE_SCOPE_CHANGED');
  });
});

it('generated Postman/HTTP and native curl match SDK calls and report expiry, revocation and protocol failures', { timeout: 30000 }, async () => {
  let now = Date.now();
  await fixture(async ({ app, create, registry, origin, designer, releaseRowId }) => {
    const docs = buildInterfaceCallDocs({
      release: release as unknown as QueryInterfaceRelease,
      libraryCode: 'business',
      baseUrl: origin,
      authMode: 'registry',
    });
    const { token } = create([docs.grant!]);
    const collection = JSON.parse(JSON.stringify(docs.postman));
    const request = collection.item[0].request;
    const url = request.url.replace('{{baseUrl}}', collection.variable[0].value);
    const http = (access: string) => fetch(url, {
      method: request.method,
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json', Authorization: `Bearer ${access}`,
        'X-ModelDB-User-Subject': 'postman-test-user',
      },
      body: request.body.raw,
    });
    const direct = await http(token);
    assert.equal(direct.status, 200);
    const result = await direct.json();
    assert.deepEqual(result.rows, [{ label: 'visible' }]);
    assert.ok(!JSON.stringify(result).includes('hidden-business-value'));
    assert.ok(registry.auditEvents().some((event) =>
      event.actor.userSubject === 'postman-test-user' &&
      event.actor.userSubjectTrust === 'application-asserted' &&
      event.actor.identityTrust === 'verified'));

    // Execute a native HTTP client with the generated URL/body and an in-memory credential.
    const curlBody = await new Promise<string>((done, fail) => {
      const child = spawn(process.platform === 'win32' ? 'curl.exe' : 'curl', [
        '--silent', '--show-error', '--fail-with-body', '--max-time', '10',
        '--request', request.method, url,
        '--header', 'Content-Type: application/json',
        '--header', `Authorization: Bearer ${token}`,
        '--data-binary', '@-',
      ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (data) => { output += String(data); });
      child.stderr.resume();
      child.once('error', () => fail(new Error('Native curl unavailable')));
      child.once('exit', (code) => code === 0 ? done(output) : fail(new Error(`Native curl failed: ${code}`)));
      child.stdin.end(request.body.raw);
    });
    assert.deepEqual(JSON.parse(curlBody), result);
    for (const mode of ['short', 'stream'] as const) {
      const client = await RemoteModelDBClient.connect({ url: origin, dbName: 'business', token, mode });
      try {
        assert.deepEqual(await client.invokeQueryInterface('ListItems', docs.body), result);
        await assert.rejects(client.model('Item').query().execute(), (error: unknown) =>
          error instanceof ConnectionSecurityError && error.code === 'SECURITY_FORBIDDEN');
      } finally { client.close(); }
    }
    const wrongVersion = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ...docs.body, version: '99.0.0' }),
    });
    assert.equal(wrongVersion.status, 400);
    assert.equal((await wrongVersion.json()).error, 'INTERFACE_RELEASE_NOT_FOUND');
    for (const headers of [{}, { 'x-modeldb-connect-token': token }]) {
      const denied = await app.inject({ method: 'POST', url: new URL(url).pathname, headers, payload: docs.body });
      assert.equal(denied.statusCode, 401);
      assert.equal(denied.json().error, 'SECURITY_CREDENTIAL_INVALID');
      assert.equal(typeof denied.json().requestId, 'string');
    }
    const unsupported = await app.inject({
      method: 'POST', url: '/api/v1/rpc',
      headers: { authorization: `Bearer ${token}` },
      payload: { version: 99, database: 'business', operation: { op: 'executeInterface', callableName: 'ListItems' } },
    });
    assert.equal(unsupported.statusCode, 426);
    assert.equal(unsupported.json().error, 'SECURITY_PROTOCOL_UNSUPPORTED');
    const legacy = await app.inject({ method: 'POST', url: '/v2/action', payload: {}, headers: { authorization: `Bearer ${token}` } });
    assert.equal(legacy.statusCode, 426);
    assert.equal(legacy.json().error, 'SECURITY_PROTOCOL_UNSUPPORTED');

    now += 31 * 86400000;
    const expired = await http(token);
    assert.equal(expired.status, 401);
    assert.equal((await expired.json()).error, 'SECURITY_CREDENTIAL_EXPIRED');
    await assert.rejects(RemoteModelDBClient.connect({ url: origin, dbName: 'business', token, mode: 'short' }),
      (error: unknown) => error instanceof ConnectionSecurityError && error.code === 'SECURITY_CREDENTIAL_EXPIRED');
    const replacement = create([docs.grant!]);
    registry.revokeCredential(replacement.credential.id);
    const revoked = await http(replacement.token);
    assert.equal(revoked.status, 401);
    assert.equal((await revoked.json()).error, 'SECURITY_CREDENTIAL_REVOKED');
    await assert.rejects(RemoteModelDBClient.connect({ url: origin, dbName: 'business', token: replacement.token, mode: 'short' }),
      (error: unknown) => error instanceof ConnectionSecurityError && error.code === 'SECURITY_CREDENTIAL_REVOKED');
    const current = create([docs.grant!]);
    const expanded = structuredClone(release);
    expanded.executionTemplate.resultAdapter.fieldsByNode.item.push({ sourceField: 'secret', outputName: 'secret' });
    await designer.update('sys_query_interface', releaseRowId, { release_json: JSON.stringify(expanded) }, { sync: true });
    const changed = await http(current.token);
    assert.equal(changed.status, 403);
    assert.equal((await changed.json()).error, 'SECURITY_RELEASE_SCOPE_CHANGED');
  }, { now: () => now });
});

it('SDK short and stream authenticate before exposure, preserve revived rows and revoke existing sessions', async () => {
  await fixture(async ({ create, registry, origin }) => {
    const { token, credential } = create([
      { database: 'business', resource: '*', actions: ['model.read', 'model.write'] },
    ]);
    const short = await RemoteModelDBClient.connect({
      url: origin,
      dbName: 'business',
      token,
      mode: 'short',
    });
    const stream = await RemoteModelDBClient.connect({
      url: origin,
      dbName: 'business',
      token,
      mode: 'stream',
    });
    try {
      const first = (await short.model('Item').query().execute()) as Array<{ getData(): unknown }>;
      assert.equal(first.length, 1);
      assert.equal(typeof first[0].getData, 'function');
      const both = await Promise.all([
        stream.model('Item').query().execute(),
        stream.model('Item').query().execute(),
      ]);
      assert.equal(both.length, 2);
      registry.revokeCredential(credential.id);
      await assert.rejects(
        short.model('Item').query().execute(),
        (error: unknown) => error instanceof ConnectionSecurityError && error.status === 401,
      );
      await assert.rejects(
        stream.model('Item').query().execute(),
        (error: unknown) => error instanceof ConnectionSecurityError,
      );
      await assert.rejects(
        RemoteModelDBClient.connect({ url: origin, dbName: 'business', token, mode: 'short' }),
        (error: unknown) => error instanceof ConnectionSecurityError && error.status === 401,
      );
      await assert.rejects(
        RemoteModelDBClient.connect({ url: origin, dbName: 'business', token: 'old-global-token' }),
        (error: unknown) =>
          error instanceof ConnectionSecurityError &&
          error.code === 'SECURITY_PROTOCOL_UNSUPPORTED',
      );
    } finally {
      short.close();
      stream.close();
    }
  });
});

it('browser SDK uses cookies for management, restored HTTP RPC and CSRF-protected WS with revocation', async () => {
  await fixture(async ({ registry, create, origin }) => {
    const frontend = 'http://127.0.0.1:5175';
    const credential = create([{ database: 'business', resource: '*', actions: ['model.read'] }]);
    const pairing = registry.createPairingForCredential(credential.credential.id, 5, frontend);
    const originalFetch = globalThis.fetch;
    let cookie = '';
    globalThis.fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      if (init?.credentials === 'include') {
        headers.set('origin', frontend);
        if (cookie) headers.set('cookie', cookie);
        assert.equal(headers.has('authorization'), false);
        assert.equal(headers.has('x-modeldb-connect-token'), false);
      }
      const response = await originalFetch(input, { ...init, headers });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      return response;
    };
    const endpoint = { host: origin, port: Number(new URL(origin).port) };
    const modelDB = new ModelDB({ ...endpoint, browserSession: true });
    let stream: RemoteModelDBClient | undefined;
    try {
      await pairBrowserSession(endpoint, pairing.code);
      assert.deepEqual(await modelDB.listDatabases(), ['business']);
      assert.equal((await modelDB.getDatabaseCatalog('business')).models[0].name, 'Item');
      const [first, second] = await Promise.all([modelDB.use('business'), modelDB.use('business')]);
      assert.equal(first, second);
      const rows = await first.model('Item').query().execute() as Array<{ getData(): unknown }>;
      assert.equal(rows.length, 1);
      assert.equal(typeof rows[0].getData, 'function');
      const info = await getBrowserSession(endpoint);
      // Cookie WS requires both the paired Origin and proof; no-Origin and forged proof fail.
      for (const [originHeader, csrf] of [[undefined, info.csrf], [frontend, 'f'.repeat(64)]] as const) {
        const ws = new WebSocket(origin.replace('http:', 'ws:') + '/api/v1/stream', { headers: { cookie, ...(originHeader ? { origin: originHeader } : {}) } });
        await new Promise<void>((done, reject) => { ws.once('open', done); ws.once('error', reject); });
        const reply = new Promise<Record<string, unknown>>((done) => ws.once('message', (data) => done(JSON.parse(data.toString()))));
        ws.send(JSON.stringify({ version: 1, type: 'security.hello', database: 'business', csrf }));
        assert.equal((await reply).type, 'security.error');
        ws.terminate();
      }
      const cookieSocket = class extends WebSocket {
        constructor(url: string) { super(url, { headers: { cookie, origin: frontend } }); }
      };
      stream = await RemoteModelDBClient.connect({ url: origin, dbName: 'business', browserSession: true, mode: 'stream', webSocketCtor: cookieSocket });
      assert.equal((await stream.model('Item').query().execute() as unknown[]).length, 1);
      await refreshBrowserSession(endpoint);
      await assert.rejects(stream.model('Item').query().execute(), (e: unknown) => e instanceof ConnectionSecurityError);
      assert.equal((await first.model('Item').query().execute() as unknown[]).length, 1);
      await logoutBrowserSession(endpoint);
      await assert.rejects(first.model('Item').query().execute(), (e: unknown) => e instanceof ConnectionSecurityError && e.status === 401);
      await assert.rejects(getBrowserSession(endpoint), (e: unknown) => e instanceof ConnectionSecurityError && e.status === 401);
    } finally {
      modelDB.releaseClient('business');
      stream?.close();
      globalThis.fetch = originalFetch;
    }
  });
});

it('SDK clients retry a failed handshake and share a successful concurrent ModelDB connection', async () => {
  for (const mode of ['short', 'stream'] as const) {
    for (const entry of ['modelDB', 'remote'] as const) {
      await fixture(
        async ({ create, origin }) => {
          const { token } = create([
            { database: 'business', resource: '*', actions: ['model.read'] },
          ]);
          const endpoint = new URL(origin);
          const modelDB = new ModelDB({
            host: endpoint.hostname,
            port: Number(endpoint.port),
            token,
            mode,
          });
          const remote = new RemoteModelDBClient({
            url: origin,
            dbName: 'business',
            token,
            mode,
          });
          try {
            await assert.rejects(
              entry === 'modelDB' ? modelDB.use('business') : remote.connect(),
              (error: unknown) => error instanceof ConnectionSecurityError && error.status === 503,
            );
            let connected: RemoteModelDBClient;
            if (entry === 'modelDB') {
              const [first, second] = await Promise.all([
                modelDB.use('business'),
                modelDB.use('business'),
              ]);
              assert.equal(first, second);
              connected = first;
            } else {
              await Promise.all([remote.connect(), remote.connect()]);
              connected = remote;
            }
            const rows = await connected.model('Item').query().execute();
            assert.ok(Array.isArray(rows));
            assert.equal(rows.length, 1);
          } finally {
            modelDB.releaseClient('business');
            remote.close();
          }
        },
        { failFirstHealth: true },
      );
    }
  }
});

it('rechecks queued writes and requires explicit schema/import capabilities before any mutation', async () => {
  await fixture(async ({ create, registry, rpc, gate, business }) => {
    const current = create([
      { database: 'business', resource: '*', actions: ['model.read', 'model.write'] },
    ]);
    for (const body of [
      { op: 'registerModel', name: 'Denied', fields: {} },
      { op: 'insertMany', model: 'Item', rows: [{ name: 'not-inserted' }] },
    ] as WireExecuteBody[])
      assert.equal((await rpc(current.token, body)).statusCode, 403);
    let releaseGate!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const block = gate.runExclusive(
      'business',
      () =>
        new Promise<void>((resolve) => {
          releaseGate = resolve;
          started();
        }),
    );
    await ready;
    const auth = new AuthorizationService(() => registry.authenticate(current.token), 'designer');
    auth.preflight('business', { op: 'insert', model: 'Item', data: { name: 'queued' } });
    // The dispatcher passes preflight synchronously and queues behind our held gate.
    const dispatcher = new WireRequestDispatcher({
      dev: false,
      getEngine: async () => business,
      writeGate: gate,
      designerWorkspace: 'designer',
    });
    const pending = dispatcher.executeAuthorized(
      'business',
      { op: 'insert', model: 'Item', data: { name: 'queued' } },
      auth,
    );
    const rejected = assert.rejects(pending, { code: 'SECURITY_CREDENTIAL_REVOKED' });
    registry.revokeCredential(current.credential.id);
    releaseGate();
    await block;
    await rejected;
    assert.equal((await business.persistence.getMergedReader().getAll('Item')).length, 1);
    assert.equal(business.registry.getModel('Denied'), undefined);
  });
});

it('checks publisher business permissions before changing any release row', async () => {
  await fixture(async ({ create, rpc, designer, releaseRowId }) => {
    const designerGrant: SecurityGrant = {
      database: 'designer',
      resource: '*',
      actions: ['model.read', 'model.write', 'schema.manage'],
    };
    const denied = create([designerGrant]);
    const body: WireExecuteBody = {
      op: 'update',
      model: 'sys_query_interface',
      id: releaseRowId,
      partial: { release_json: JSON.stringify({ ...release, version: '2.0.0' }) },
      sync: true,
    };
    assert.equal((await rpc(denied.token, body, 'designer')).statusCode, 403);
    assert.equal(
      JSON.parse(
        String(
          (await designer.persistence.getMergedReader().getAll('sys_query_interface'))[0]
            .release_json,
        ),
      ).version,
      '1.0.0',
    );
    const allowed = create([
      designerGrant,
      { database: 'business', resource: '*', actions: ['schema.manage', 'model.read'] },
    ]);
    assert.equal((await rpc(allowed.token, body, 'designer')).statusCode, 200);
  });
});

it('rechecks each published batch item after revocation and refuses unsupported atomic batches before writes', async () => {
  await fixture(async ({ create, registry, business, designer, rpc }) => {
    designer.registerModel('sys_operation_interface', {
      library_code: 'String',
      release_json: 'String',
      release_history_json: 'String',
    });
    const template: PublishedOperationExecutionTemplate = {
      format: 1,
      operation: {
        op: 'insert',
        model: 'Item',
        data: { name: interfaceParameterPlaceholder('name') },
        sync: true,
      },
      parameters: [{ id: 'name', name: 'name', type: 'string', required: true }],
      batch: { itemsParameter: 'items', maxItems: 10, failureMode: 'continue' },
      transaction: { mode: 'batch', rollbackOnFailure: false },
      result: { returns: 'summary', includeItemResults: true },
    };
    const stored = {
      version: '1.0.0',
      callableName: 'CreateBatch',
      signature: 'batch',
      operationInterface: { status: 'active', contract: { permissions: { mode: 'none' } } },
      executionTemplate: template,
    };
    await designer.insert(
      'sys_operation_interface',
      { library_code: 'business', release_json: JSON.stringify(stored), release_history_json: '' },
      { sync: true },
    );
    const credential = create([
      {
        database: 'business',
        resource: 'CreateBatch',
        actions: ['callable.operation'],
        releaseDigest: securityReleaseDigest(stored),
      },
    ]);
    const original = business.insert.bind(business);
    let count = 0;
    business.insert = async (...args) => {
      const row = await original(...args);
      if (++count === 1) registry.revokeCredential(credential.credential.id);
      return row;
    };
    const result = await rpc(credential.token, {
      op: 'executeOperationInterface',
      callableName: 'CreateBatch',
      parameters: { items: [{ name: 'first' }, { name: 'second' }, { name: 'third' }] },
    });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().result.output.status, 'partial');
    assert.equal(result.json().result.output.successCount, 1);
    assert.equal(result.json().result.output.failureCount, 2);
    assert.equal(result.json().result.output.items[1].error.code, 'SECURITY_CREDENTIAL_REVOKED');
    assert.equal((await business.persistence.getMergedReader().getAll('Item')).length, 2);
    const invalid = {
      ...stored,
      callableName: 'AtomicBatch',
      executionTemplate: { ...template, transaction: { mode: 'batch', rollbackOnFailure: true } },
    };
    await designer.insert(
      'sys_operation_interface',
      { library_code: 'business', release_json: JSON.stringify(invalid), release_history_json: '' },
      { sync: true },
    );
    const atomic = create([
      {
        database: 'business',
        resource: 'AtomicBatch',
        actions: ['callable.operation'],
        releaseDigest: securityReleaseDigest(invalid),
      },
    ]);
    assert.notEqual(
      (
        await rpc(atomic.token, {
          op: 'executeOperationInterface',
          callableName: 'AtomicBatch',
          parameters: { items: [{ name: 'must-not-exist' }] },
        })
      ).statusCode,
      200,
    );
    assert.equal((await business.persistence.getMergedReader().getAll('Item')).length, 2);
  });
});

it('a binding grant delegates neither child query nor child operation without separately pinned grants', async () => {
  await fixture(async ({ create, designer, rpc }) => {
    designer.registerModel('sys_binding_surface', {
      library_code: 'String',
      surface_id: 'String',
      release_json: 'String',
      release_history_json: 'String',
    });
    const surface = {
      version: '1.0.0',
      publishedAt: '2026-10-20T00:00:00.000Z',
      signature: 'surface',
      bindingSurface: { status: 'active' },
      contract: {
        format: 1,
        surfaceId: 'ListSurface',
        name: 'List',
        version: '1.0.0',
        parameters: [],
        query: {
          interfaceId: 'items',
          callableName: 'ListItems',
          version: '1.0.0',
          parameterBindings: [],
        },
        writeback: {
          mode: 'explicit',
          refresh: 'manual',
          mutations: [
            {
              id: 'Create',
              trigger: { kind: 'create', nodeId: 'item' },
              operation: {
                interfaceId: 'create',
                callableName: 'CreateItem',
                version: '1.0.0',
                operationType: 'create',
              },
              parameterBindings: [],
            },
          ],
        },
      },
    };
    await designer.insert(
      'sys_binding_surface',
      {
        library_code: 'business',
        surface_id: 'ListSurface',
        release_json: JSON.stringify(surface),
        release_history_json: '',
      },
      { sync: true },
    );
    const surfaceGrant: SecurityGrant = {
      database: 'business',
      resource: 'ListSurface',
      actions: ['callable.binding'],
      releaseDigest: securityReleaseDigest(surface),
    };
    const restricted = create([surfaceGrant]);
    const body: WireExecuteBody = {
      op: 'executeBindingSurface',
      surfaceId: 'ListSurface',
      action: { kind: 'read' },
    };
    assert.equal((await rpc(restricted.token, body)).statusCode, 403);
    const allowed = create([
      surfaceGrant,
      {
        database: 'business',
        resource: 'ListItems',
        actions: ['callable.query'],
        releaseDigest: securityReleaseDigest(release),
      },
    ]);
    const result = await rpc(allowed.token, body);
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().result.query.rows[0].label, 'visible');
    assert.equal(result.json().result.query.rows[0].$recordRef.model, 'Item');
    assert.ok(!result.body.includes('hidden-business-value'));
    designer.registerModel('sys_operation_interface', {
      library_code: 'String',
      release_json: 'String',
      release_history_json: 'String',
    });
    const storedOperation = {
      version: '1.0.0',
      callableName: 'CreateItem',
      signature: 'create',
      operationInterface: { status: 'active', contract: { permissions: { mode: 'none' } } },
      executionTemplate: {
        format: 1,
        operation: { op: 'insert', model: 'Item', data: { name: 'created' }, sync: true },
        parameters: [],
        result: { returns: 'summary' },
      },
    };
    await designer.insert(
      'sys_operation_interface',
      {
        library_code: 'business',
        release_json: JSON.stringify(storedOperation),
        release_history_json: '',
      },
      { sync: true },
    );
    const mutate: WireExecuteBody = {
      op: 'executeBindingSurface',
      surfaceId: 'ListSurface',
      action: { kind: 'mutate', mutationId: 'Create' },
    };
    assert.equal((await rpc(allowed.token, mutate)).statusCode, 403);
    const writer = create([
      surfaceGrant,
      {
        database: 'business',
        resource: 'CreateItem',
        actions: ['callable.operation'],
        releaseDigest: securityReleaseDigest(storedOperation),
      },
    ]);
    assert.equal((await rpc(writer.token, mutate)).statusCode, 200);
  });
});

it('backup creation/list/download have distinct scoped checks and ordinary readers cannot create backups', async () => {
  await fixture(async ({ app, create, registry }) => {
    const reader = create([{ database: 'business', resource: '*', actions: ['model.read'] }]);
    const owner = create([
      { database: 'business', resource: '*', actions: ['backup.manage', 'transfer.export'] },
    ]);
    const headers = { authorization: `Bearer ${owner.token}` };
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/management/databases/business/backup',
          payload: { name: 'no' },
          headers: { authorization: `Bearer ${reader.token}` },
        })
      ).statusCode,
      403,
    );
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/management/databases/business/backup',
      payload: { name: 'snapshot' },
      headers,
    });
    assert.equal(created.statusCode, 200, created.body);
    assert.equal(created.json().backup.path, undefined);
    const listed = await app.inject({
      url: '/api/v1/management/backups?database=business',
      headers,
    });
    assert.equal(listed.json().backups.length, 1);
    const download = `/api/v1/management/backups/${created.json().backup.fileName}/download`;
    const downloaded = await app.inject({ url: download, headers });
    assert.equal(downloaded.statusCode, 200);
    const backupOnly = create([
      { database: 'business', resource: '*', actions: ['backup.manage'] },
    ]);
    assert.equal(
      (
        await app.inject({
          url: download,
          headers: { authorization: `Bearer ${backupOnly.token}` },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await app.inject({ url: '/api/v1/management/backups?database=other', headers })).statusCode,
      403,
    );
    const upload = (token: string, payload = downloaded.rawPayload) => app.inject({ method: 'POST', url: '/api/v1/management/backups/import?fileName=ignored', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' }, payload });
    assert.equal((await upload(owner.token)).statusCode, 403);
    const importer = create([{ database: 'business', resource: '*', actions: ['backup.manage', 'transfer.import'] }]);
    const imported = await upload(importer.token);
    assert.equal(imported.statusCode, 200, imported.body);
    assert.equal(imported.json().backup.path, undefined);
    assert.notEqual(imported.json().backup.fileName, created.json().backup.fileName);
    const damaged = Buffer.from(downloaded.rawPayload); damaged[damaged.length - 3] ^= 1;
    assert.notEqual((await upload(importer.token, damaged)).statusCode, 200);
    registry.revokeCredential(importer.credential.id);
    assert.notEqual((await upload(importer.token)).statusCode, 200);
    assert.ok(
      registry
        .auditEvents()
        .some((event) => event.action === 'backup.create' && event.result === 'succeeded'),
    );
    for (const action of ['backup.download', 'backup.import']) assert.ok(registry.auditEvents().some(event => event.action === action && event.result === 'succeeded'));
  });
});

it('an authorized restore disconnects existing database streams and preserves the access credential', async () => {
  let restores = 0;
  await fixture(async ({ create, app, origin, registry }) => {
    const credential = create([{ database: 'business', resource: '*', actions: ['database.manage', 'schema.manage', 'model.read', 'model.write', 'backup.manage'] }]);
    const headers = { authorization: `Bearer ${credential.token}` };
    const created = await app.inject({ method: 'POST', url: '/api/v1/management/databases/business/backup', headers, payload: { name: 'stream snapshot' } });
    assert.equal(created.statusCode, 200, created.body);
    const socket = new WebSocket(origin.replace('http:', 'ws:') + '/api/v1/stream');
    try {
      await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
      const ready = new Promise<Record<string, unknown>>(resolve => socket.once('message', (data: { toString(): string }) => resolve(JSON.parse(data.toString()))));
      socket.send(JSON.stringify({ version: 1, type: 'security.hello', database: 'business', token: credential.token }));
      assert.equal((await ready).type, 'security.ready');
      const closed = new Promise<number>(resolve => socket.once('close', (code: number) => resolve(code)));
      const restored = await app.inject({ method: 'POST', url: '/api/v1/management/databases/business/restore', headers, payload: { backupFile: created.json().backup.fileName } });
      assert.equal(restored.statusCode, 200, restored.body); assert.equal(await closed, 1012); assert.equal(restores, 1);
      assert.equal(registry.authenticate(credential.token).credential.id, credential.credential.id);
    } finally { socket.terminate(); }
  }, { manage: {
    create: async () => { throw new SecurityError('SECURITY_FORBIDDEN'); },
    drop: async () => { throw new SecurityError('SECURITY_FORBIDDEN'); },
    clear: async () => { throw new SecurityError('SECURITY_FORBIDDEN'); },
    restore: async () => { restores++; return { ok: true }; },
  } });
});

it('audit failure before execution denies writes and outcome failure reports uncertainty after a committed write', async () => {
  await fixture(async ({ create, rpc, registry, business }) => {
    const credential = create([
      { database: 'business', resource: '*', actions: ['model.read', 'model.write'] },
    ]);
    const persist = registry.recordAccess.bind(registry);
    registry.recordAccess = () => {
      throw new SecurityError('SECURITY_AUDIT_CAPACITY');
    };
    const body: WireExecuteBody = {
      op: 'insert',
      model: 'Item',
      data: { name: 'committed' },
      sync: true,
    };
    assert.equal((await rpc(credential.token, body)).statusCode, 503);
    assert.equal((await business.persistence.getMergedReader().getAll('Item')).length, 1);
    registry.recordAccess = (...args) => {
      if (args[2] === 'succeeded') throw new SecurityError('SECURITY_STORE_WRITE_FAILED');
      persist(...args);
    };
    const unconfirmed = await rpc(credential.token, body);
    assert.equal(unconfirmed.statusCode, 503);
    assert.equal(unconfirmed.json().error, 'SECURITY_OUTCOME_UNCONFIRMED');
    assert.equal((await business.persistence.getMergedReader().getAll('Item')).length, 2);
    assert.deepEqual(
      registry
        .auditEvents()
        .filter((event) => event.requestId === unconfirmed.json().requestId)
        .map((event) => event.result),
      ['started'],
    );
    registry.recordAccess = persist;
  });
});

it('raw relation changes and indirect deletes require whole-database write scope', async () => {
  await fixture(async ({ create, rpc, business }) => {
    business.registerModel('Department', { name: 'String' });
    business.registerModel('Employee', { name: 'String' });
    business.registerRelation('Department', 'Employee', 'members', 'department', 'one-to-many');
    const department = await business.insert('Department', { name: 'Team' }, { sync: true });
    const first = await business.insert('Employee', { name: 'First' }, { sync: true });
    const second = await business.insert('Employee', { name: 'Second' }, { sync: true });
    const reader = create([{ database: 'business', resource: '*', actions: ['model.read'] }]);
    const writer = create([
      { database: 'business', resource: '*', actions: ['model.read', 'model.write'] },
    ]);
    const source = { model: 'Department', id: department._id };
    const target = { model: 'Employee', id: first._id };
    const next = { model: 'Employee', id: second._id };
    const operations: WireExecuteBody[] = [
      { op: 'bindPair', source, target, forward: 'members', reverse: 'department' },
      {
        op: 'rebindPair',
        source,
        previousTarget: target,
        nextTarget: next,
        forward: 'members',
        reverse: 'department',
      },
      { op: 'unlinkPair', source, target: next, forward: 'members', reverse: 'department' },
      { op: 'delete', model: 'Department', id: department._id, sync: true },
    ];
    for (const body of operations) {
      assert.equal((await rpc(reader.token, body)).statusCode, 403);
      const result = await rpc(writer.token, body);
      assert.equal(result.statusCode, 200, result.body);
    }
    assert.equal((await business.persistence.getMergedReader().getAll('Department')).length, 0);
    const modelOnly = create([
      { database: 'business', resource: 'Employee', actions: ['model.read', 'model.write'] },
    ]);
    assert.equal(
      (await rpc(modelOnly.token, { op: 'delete', model: 'Employee', id: first._id })).statusCode,
      403,
    );
  });
});

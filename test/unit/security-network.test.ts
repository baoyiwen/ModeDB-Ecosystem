import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import Fastify from '../../packages/server/node_modules/fastify/fastify.js';
import type websocketType from '../../packages/server/node_modules/@fastify/websocket/types/index.js';
import type corsType from '../../packages/server/node_modules/@fastify/cors/types/index.js';
import {
  SecurityNetworkPolicy,
  networkAddress,
  securityOrigin,
  type SecurityNetworkConfig,
} from '../../packages/server/src/security/network-policy.js';
import { installSecurityNetworkBoundary } from '../../packages/server/src/security/network-boundary.js';
import { connectionOrigin, RemoteModelDBClient } from '@mode-db/sdk';

const { default: websocket } = (await import(
  new URL('../../packages/server/node_modules/@fastify/websocket/index.js', import.meta.url).href
)) as { default: typeof websocketType };
const { default: cors } = (await import(
  new URL('../../packages/server/node_modules/@fastify/cors/index.js', import.meta.url).href
)) as { default: typeof corsType };
const endpoint = { host: '127.0.0.1', port: 9091, directory: '.' };
const certificateFile = fileURLToPath(
  new URL('../fixtures/security-tls/localhost.crt', import.meta.url),
);
const privateKeyFile = fileURLToPath(
  new URL('../fixtures/security-tls/localhost.key', import.meta.url),
);
const tlsConfig: SecurityNetworkConfig = {
  transport: { mode: 'tls', certificateFile, privateKeyFile },
};
const errorCode =
  (code: string) =>
  (error: unknown): boolean =>
    error instanceof Error && 'code' in error && error.code === code;

it('rejects unprotected remote binds, fake public TLS, bad proxy/origin/CIDR configuration', () => {
  for (const host of ['0.0.0.0', '::', '192.0.2.1', 'db.example.com'])
    assert.throws(
      () =>
        new SecurityNetworkPolicy(
          {},
          { ...endpoint, host, publicBaseUrl: 'https://db.example.com' },
        ),
      errorCode('SECURITY_INVALID_CONFIG'),
    );
  for (const config of [
    { transport: { mode: 'proxy', trustedProxies: [] } },
    { transport: { mode: 'proxy', trustedProxies: ['proxy.example.com'] } },
    { allowedOrigins: ['*'] },
    { allowedOrigins: ['https://app.example.com/path'] },
    { allowedOrigins: ['http://app.example.com'] },
    { data: { allow: [{ id: 'bad', source: '10.0.0.0/33' }] } },
  ] as SecurityNetworkConfig[])
    assert.throws(
      () => new SecurityNetworkPolicy(config, endpoint),
      errorCode('SECURITY_INVALID_CONFIG'),
    );
  assert.equal(securityOrigin('https://example.com:443/'), 'https://example.com');
  assert.equal(new SecurityNetworkPolicy({}, endpoint).mode, 'loopback');
});

it('normalizes IPv4/IPv6, enforces deny precedence, empty allow-lists, separate planes and expiry', () => {
  let now = Date.parse('2026-10-20T10:00:00Z');
  const config: SecurityNetworkConfig = {
    ...tlsConfig,
    allowedOrigins: ['https://app.example.com'],
    data: {
      allowListEnabled: true,
      allow: [
        { id: 'lan', source: '10.0.0.0/8' },
        { id: 'v6', source: '2001:db8::/32' },
      ],
      deny: [{ id: 'blocked', source: '10.0.0.7', expiresAt: new Date(now + 1000).toISOString() }],
    },
  };
  const policy = new SecurityNetworkPolicy(config, endpoint, () => now);
  assert.equal(networkAddress('::ffff:10.0.0.7'), '10.0.0.7');
  assert.equal(networkAddress('::ffff:a00:7'), '10.0.0.7');
  const blocked = policy.source('::ffff:10.0.0.7', {}, true);
  assert.throws(() => policy.check(blocked, 'data'), errorCode('SECURITY_SOURCE_DENIED'));
  now += 1000;
  policy.check(blocked, 'data', 'https://app.example.com');
  policy.check(policy.source('2001:0db8:0:0::1', {}, true), 'data');
  assert.throws(() => policy.check(blocked, 'management'), errorCode('SECURITY_SOURCE_DENIED'));
  assert.throws(() => policy.check(blocked, 'data', 'null'), errorCode('SECURITY_ORIGIN_DENIED'));
  assert.throws(() => policy.source('10.0.0.1', {}, false), errorCode('SECURITY_TLS_REQUIRED'));
  const empty = new SecurityNetworkPolicy(
    { ...tlsConfig, data: { allowListEnabled: true, allow: [] } },
    endpoint,
  );
  assert.throws(() => empty.check(blocked, 'data'), errorCode('SECURITY_SOURCE_DENIED'));
  const open = new SecurityNetworkPolicy(
    { ...tlsConfig, data: { allowListEnabled: false } },
    endpoint,
  );
  open.check(blocked, 'data');
});

it('ignores forged forwarded headers on direct sockets and stops at the first untrusted proxy hop', () => {
  const direct = new SecurityNetworkPolicy({}, endpoint);
  assert.equal(
    direct.source('127.0.0.1', { 'x-forwarded-for': '203.0.113.1' }, false).clientIp,
    '127.0.0.1',
  );
  const proxy = new SecurityNetworkPolicy(
    {
      transport: { mode: 'proxy', trustedProxies: ['127.0.0.1', '10.1.0.0/16'] },
      data: { allowListEnabled: true, allow: [{ id: 'client', source: '198.51.100.0/24' }] },
    },
    { ...endpoint, publicBaseUrl: 'https://db.example.com' },
  );
  const headers = {
    'x-forwarded-for': '127.0.0.1, 198.51.100.9, 10.1.0.2',
    'x-forwarded-proto': 'https',
  };
  const source = proxy.source('::ffff:127.0.0.1', headers, false);
  assert.deepEqual(source, {
    peerIp: '127.0.0.1',
    clientIp: '198.51.100.9',
    clientIpBasis: 'trusted-proxy',
    secure: true,
  });
  proxy.check(source, 'data');
  assert.throws(() => proxy.check(source, 'management'), errorCode('SECURITY_SOURCE_DENIED'));
  assert.throws(
    () => proxy.source('203.0.113.1', headers, false),
    errorCode('SECURITY_PROXY_UNTRUSTED'),
  );
  assert.throws(
    () => proxy.source('127.0.0.1', { ...headers, 'x-forwarded-proto': 'http' }, false),
    errorCode('SECURITY_PROXY_UNTRUSTED'),
  );
  assert.throws(
    () => proxy.source('127.0.0.1', { ...headers, 'x-forwarded-for': 'unknown' }, false),
    errorCode('SECURITY_SOURCE_DENIED'),
  );
});

it('rejects disallowed Origins before parsing bodies or executing handlers; CORS permits exact origins only', async () => {
  const policy = new SecurityNetworkPolicy({ allowedOrigins: ['http://localhost:5175'] }, endpoint);
  const app = Fastify();
  let writes = 0;
  installSecurityNetworkBoundary(app, policy);
  await app.register(cors, { origin: [...policy.allowedOrigins], credentials: true });
  app.post('/api/v1/rpc', async () => {
    writes++;
    return { ok: true };
  });
  try {
    const denied = await app.inject({
      method: 'POST',
      url: '/api/v1/rpc',
      headers: { origin: 'http://localhost:5176', 'content-type': 'application/json' },
      payload: '{bad',
    });
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.json().error, 'SECURITY_ORIGIN_DENIED');
    assert.equal(writes, 0);
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/rpc',
      headers: { origin: 'http://localhost:5175', 'access-control-request-method': 'POST' },
    });
    assert.equal(preflight.statusCode, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], 'http://localhost:5175');
    const allowed = await app.inject({
      method: 'POST',
      url: '/api/v1/rpc',
      headers: { origin: 'http://localhost:5175' },
      payload: {},
    });
    assert.equal(allowed.statusCode, 200);
    assert.equal(writes, 1);
    const urlCredential = await app.inject({
      method: 'POST',
      url: '/api/v1/rpc?token=never-in-a-url',
      payload: {},
    });
    assert.equal(urlCredential.statusCode, 400);
    assert.equal(writes, 1);
  } finally {
    await app.close();
  }
});

it('SDK endpoint handling preserves HTTPS/IPv6 and rejects remote plaintext before sending credentials', async () => {
  assert.equal(
    connectionOrigin({ host: 'db.example.com', port: 9443, secure: true }),
    'https://db.example.com:9443',
  );
  assert.equal(
    connectionOrigin({ host: 'https://db.example.com', port: 443 }),
    'https://db.example.com',
  );
  assert.equal(connectionOrigin({ host: '::1', port: 9091 }), 'http://[::1]:9091');
  for (const host of [
    'https://user:secret@example.com',
    'https://example.com/path',
    'https://example.com?token=x',
  ])
    assert.throws(() => connectionOrigin({ host, port: 443 }));
  const token = 'mdbt_v1_fixture_not_a_real_credential';
  await assert.rejects(
    RemoteModelDBClient.connectNetwork({ host: '192.0.2.1', port: 9091, token, database: 'graph' }),
    errorCode('SECURITY_TLS_REQUIRED'),
  );
  await assert.rejects(
    RemoteModelDBClient.listDatabases({ host: '192.0.2.1', port: 9091, token }),
    errorCode('SECURITY_TLS_REQUIRED'),
  );
});

async function runSdkChild(port: number, trusted: boolean): Promise<void> {
  const source = `
    import assert from 'node:assert/strict';
    import { ModelDB, RemoteModelDBClient } from '@mode-db/sdk';
    let input=''; for await (const part of process.stdin) input+=part;
    const {port,token,trusted}=JSON.parse(input);
    const options={host:'localhost',port,secure:true,token};
    if (!trusted) {
      await assert.rejects(RemoteModelDBClient.connectNetwork({...options,database:'graph',mode:'short'}));
    } else {
      const db=new ModelDB(options);
      assert.deepEqual(await db.listDatabases(), ['graph']);
      const client=await db.use('graph');
      assert.deepEqual(await client.model('Item').query().execute(), []);
      db.releaseClient('graph');
      for(const mode of ['short','stream']) {
        const c=await RemoteModelDBClient.connectNetwork({...options,database:'graph',mode});
        try { assert.deepEqual(await c.model('Item').query().execute(), []); }
        finally { c.close(); }
      }
    }
  `;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      env: {
        ...process.env,
        NODE_TLS_REJECT_UNAUTHORIZED: '1',
        NODE_EXTRA_CA_CERTS: trusted ? certificateFile : '',
      },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('TLS SDK child timed out'));
    }, 15000);
    child.stdout.on('data', (data) => {
      output += String(data);
    });
    child.stderr.on('data', (data) => {
      output += String(data);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(output));
    });
    child.stdin.end(
      JSON.stringify({ port, token: 'mdbt_v1_fixture_not_a_real_credential', trusted }),
    );
  });
}

it('real HTTPS/WSS SDK round trips require trusted certificates and reject mismatched certificate names', async () => {
  const policy = new SecurityNetworkPolicy(tlsConfig, endpoint);
  const app = Fastify({ https: policy.tlsOptions()! });
  installSecurityNetworkBoundary(app, policy);
  await app.register(websocket);
  const token = 'mdbt_v1_fixture_not_a_real_credential';
  app.get('/health', async () => ({ ok: true, security: { mode: 'registry', protocol: 1 } }));
  app.addHook('preHandler', async (request, reply) => {
    if (
      request.url.startsWith('/api/v1/') &&
      !request.url.startsWith('/api/v1/stream') &&
      request.headers.authorization !== `Bearer ${token}`
    )
      return reply.code(401).send({ error: 'SECURITY_CREDENTIAL_INVALID' });
  });
  app.get('/api/v1/security/context', async () => ({ version: 1, database: 'graph' }));
  app.get('/api/v1/management/databases', async () => ({
    databases: [{ name: 'graph', status: 'active' }],
  }));
  app.post('/api/v1/rpc', async () => ({ version: 1, result: { kind: 'rows', rows: [] } }));
  app.get('/api/v1/stream', { websocket: true }, (socket) => {
    socket.on('message', (data) => {
      const raw = JSON.parse(data.toString()) as { type: string; token?: string; id?: string };
      if (raw.type === 'security.hello') {
        assert.equal(raw.token, token);
        socket.send(JSON.stringify({ type: 'security.ready', version: 1, database: 'graph' }));
      } else
        socket.send(
          JSON.stringify({
            type: 'security.result',
            version: 1,
            id: raw.id,
            result: { kind: 'rows', rows: [] },
          }),
        );
    });
  });
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address === 'object');
    await runSdkChild(address.port, true);
    await runSdkChild(address.port, false);
    await assert.rejects(
      new Promise<void>((resolve, reject) => {
        const req = httpsRequest(
          {
            hostname: '127.0.0.1',
            port: address.port,
            path: '/health',
            ca: readFileSync(certificateFile),
            servername: 'wrong.example.com',
          },
          (res) => {
            res.resume();
            resolve();
          },
        );
        req.once('error', reject);
        req.end();
      }),
      errorCode('ERR_TLS_CERT_ALTNAME_INVALID'),
    );
  } finally {
    for (const socket of app.websocketServer.clients) socket.terminate();
    await app.close();
  }
});

it('SDK refuses redirects instead of following a secure request toward a different transport', async () => {
  const app = Fastify();
  let reached = false;
  app.get('/health', async (_request, reply) => reply.redirect('/redirected'));
  app.get('/redirected', async () => {
    reached = true;
    return { ok: true };
  });
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address === 'object');
    await assert.rejects(
      RemoteModelDBClient.connectNetwork({
        host: '127.0.0.1',
        port: address.port,
        token: 'mdbt_v1_fixture_not_a_real_credential',
        database: 'graph',
        mode: 'short',
      }),
    );
    assert.equal(reached, false);
  } finally {
    await app.close();
  }
});

/** Isolated workload/service subprocesses. Only generated temporary roots and public TLS fixtures. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  X509Certificate,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { request } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureModelDbLayoutAtRoot } from '../../packages/server/src/modeldb-default-home.ts';
import { loadModelDBServerConfig } from '../../packages/server/src/config-loader.ts';
import { buildDualTrackFastify } from '../../packages/server/src/dual-track-app.ts';
import { SecurityRegistry } from '../../packages/server/src/security/security-registry.ts';
import { WindowsSecretProtector } from '../../packages/server/src/security/windows-secret-protector.ts';
import { LocalVaultKeyProvider } from '../../packages/server/src/security/local-vault-key-provider.ts';
import { callLocalSecurity } from '../../packages/server/src/security/local-management-channel.ts';
import { RegistrationService } from '../../packages/server/src/security/registration-service.ts';
import { AuthenticationService } from '../../packages/server/src/security/authentication-service.ts';
import { AuthoringEngine } from '../../packages/core/authoring/engine.ts';
import { isoCBOR } from '../../packages/server/node_modules/@simplewebauthn/server/esm/helpers/index.js';
import {
  fillPendingCapacity,
  integrationFixture,
  syntheticProof,
} from './security-registration-integration.ts';
import { verifyRegistrationResponse } from '../../packages/server/node_modules/@simplewebauthn/server/esm/index.js';
const repository = fileURLToPath(new URL('../../', import.meta.url));
const tls = join(repository, 'test/fixtures/security-registration-tls');
const certificate = readFileSync(join(tls, 'modeldb-a.crt'));
const sha = (b) => createHash('sha256').update(b).digest();
const utc = (n) => new Date(n).toISOString();
const grants = [
  { database: 'bench', resource: '*', actions: ['model.read', 'model.write', 'transfer.import'] },
];
const query = {
  op: 'executeQuery',
  snapshot: {
    plan: {
      version: 2,
      originModel: 'Item',
      start: { kind: 'all' },
      hops: [],
      trailing: { type: 'group', logic: 'AND', children: [] },
    },
    execute: {},
    analysis: { groupBy: null, compute: null },
  },
};
const send = (message) => process.send?.(message);

async function service(root, build, isFlood) {
  assert.equal(process.platform, 'win32');
  const cfg = await loadModelDBServerConfig(ensureModelDbLayoutAtRoot(root), { port: 0 });
  const dir = join(root, 'security'),
    initial = SecurityRegistry.open(dir),
    instanceId = initial.status().instanceId;
  const principal = initial.createPrincipal('Synthetic baseline', 'application');
  if (isFlood) {
    initial.migrateAuthenticationStorage(initial.status().revision);
    fillPendingCapacity(initial, Date.now(), 1000);
  }
  const pendingCapacity = isFlood
    ? initial.readRegistrationStorage().applications.filter((a) => a.state === 'pending').length
    : 0;
  initial.close();
  const seed = new AuthoringEngine({
    atlas: 'bench',
    storageRoot: cfg.workspace,
    keyProvider: new LocalVaultKeyProvider(dir),
  });
  seed.registerModel('Item', { code: 'String', score: 'Int' });
  seed.registerModel('Saved', { code: 'String', score: 'Int' });
  for (let i = 0; i < 1000; i++) await seed.insert('Item', { code: `synthetic-${i}`, score: i });
  await seed.flushAll();
  await seed.close();
  const reservation = createServer();
  await new Promise((done, fail) => {
    reservation.once('error', fail);
    reservation.listen(0, '127.0.0.1', done);
  });
  const port = reservation.address().port;
  assert.notEqual(port, 9091);
  await new Promise((done, fail) => reservation.close((e) => (e ? fail(e) : done())));
  const origin = `https://modeldb-a.example.test:${port}`;
  const descriptor = {
    format: 'modeldb.device-registration-connection.v1',
    version: 1,
    instanceId,
    serverOrigin: origin,
    rpId: 'modeldb-a.example.test',
    registrationMode: 'enabled',
    issuedAtUtc: utc(Date.now() - 1000),
    expiresAtUtc: utc(Date.now() + 3600000),
    deploymentDescriptorSha256: 'a'.repeat(64),
    tls: {
      mode: 'owner-pinned',
      minVersion: 'TLS1.2',
      spkiSha256: sha(
        new X509Certificate(certificate).publicKey.export({ type: 'spki', format: 'der' }),
      ).toString('hex'),
    },
  };
  const context = new AsyncLocalStorage();
  let localRow;
  const actor = SecurityRegistry.prototype.withLocalActor;
  SecurityRegistry.prototype.withLocalActor = function (...args) {
    if (!localRow) return actor.apply(this, args);
    const row = localRow,
      started = performance.now(),
      cpu = process.cpuUsage();
    try {
      return context.run(row, () => actor.apply(this, args));
    } finally {
      const used = process.cpuUsage(cpu);
      row.serverMs += performance.now() - started;
      row.nodeCpuMs += (used.user + used.system) / 1000;
    }
  };
  const timed = (object, key, target) => {
    const original = object[key];
    object[key] = function (...args) {
      const started = performance.now();
      const row = context.getStore();
      const finish = () => {
        if (row) row[target] += performance.now() - started;
      };
      try {
        const result = original.apply(this, args);
        if (result?.then) return result.finally(finish);
        finish();
        return result;
      } catch (error) {
        finish();
        throw error;
      }
    };
  };
  for (const name of ['protect', 'unprotect', 'ensureDirectory'])
    timed(WindowsSecretProtector.prototype, name, 'protectionMs');
  // Test-only observation: wrap the existing bounded queues and real verification, preserving arguments/results.
  for (const Type of [RegistrationService, AuthenticationService]) {
    const original = Type.prototype.complete;
    Type.prototype.complete = function (...args) {
      if (!this.performanceObserved) {
        this.performanceObserved = true;
        timed(this, 'verify', 'verificationMs');
        if (this.slots) timed(this.slots, 'acquire', 'queueMs');
        else timed(this, 'acquire', 'queueMs');
      }
      return original.apply(this, args);
    };
  }
  const app = await buildDualTrackFastify({
    ...cfg,
    host: '127.0.0.1',
    port,
    publicBaseUrl: origin,
    securityMode: 'registry',
    securityAuthentication: { enabled: true, allowStorageMigration: true },
    securityRegistration: { descriptor, allowStorageMigration: true },
    securityHosting: { enabled: true, designerDirectory: build, managementPort: 0 },
    securityNetwork: {
      transport: {
        mode: 'tls',
        certificateFile: join(tls, 'modeldb-a.crt'),
        privateKeyFile: join(tls, 'modeldb-a.key'),
      },
      data: { allowListEnabled: false },
    },
    securityAudit: { maxEvents: 10000, retentionDays: 365 },
  });
  const resource = () => ({
    nodeRssMiB:
      Math.max(process.memoryUsage().rss, process.resourceUsage().maxRSS * 1024) / 1048576,
  });
  app.server.prependListener('request', (req, res) => {
    const row = {
      serverMs: 0,
      queueMs: 0,
      protectionMs: 0,
      verificationMs: 0,
      nodeCpuMs: 0,
      ...resource(),
    };
    const started = performance.now(),
      cpu = process.cpuUsage();
    context.enterWith(row);
    res.once('finish', () => {
      const used = process.cpuUsage(cpu);
      Object.assign(row, {
        serverMs: performance.now() - started,
        nodeCpuMs: (used.user + used.system) / 1000,
        ...resource(),
      });
      send({ type: 'metric', id: req.headers['x-drill-id'], row });
    });
  });
  process.on('message', async (message) => {
    if (message.type === 'close') {
      await app.close();
      send({ type: 'closed' });
      process.disconnect();
      return;
    }
    if (message.type !== 'local') return;
    const row = {
      serverMs: 0,
      queueMs: 0,
      protectionMs: 0,
      verificationMs: 0,
      nodeCpuMs: 0,
      ...resource(),
    };
    try {
      assert.equal(localRow, undefined);
      localRow = row;
      const result = await callLocalSecurity(dir, message.request);
      Object.assign(row, resource());
      send({ type: 'local-result', id: message.id, result, row });
    } catch (error) {
      send({
        type: 'local-result',
        id: message.id,
        error: error.code ?? 'PERFORMANCE_LOCAL_FAILED',
        row,
      });
    } finally {
      localRow = undefined;
    }
  });
  send({ type: 'ready', origin, instanceId, principalId: principal.id, dir, pendingCapacity });
}

function softwareKey(binding, begin, origin) {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }),
    jwk = pair.publicKey.export({ format: 'jwk' }),
    raw = randomBytes(32),
    id = raw.toString('base64url'),
    len = Buffer.alloc(2);
  len.writeUInt16BE(raw.length);
  const cose = isoCBOR.encode(
    new Map([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x, 'base64url')],
      [-3, Buffer.from(jwk.y, 'base64url')],
    ]),
  );
  const auth = Buffer.concat([
    sha('modeldb-a.example.test'),
    Buffer.from([0x45]),
    Buffer.alloc(4),
    Buffer.alloc(16),
    len,
    raw,
    Buffer.from(cose),
  ]);
  const att = isoCBOR.encode(
    new Map([
      ['fmt', 'none'],
      ['attStmt', new Map()],
      ['authData', auth],
    ]),
  );
  const proof = {
    ...binding,
    registrationId: begin.registrationId,
    continuationSecret: begin.continuationSecret,
    challengeId: begin.challengeId,
    credential: {
      id,
      rawId: id,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: Buffer.from(
          JSON.stringify({
            type: 'webauthn.create',
            challenge: begin.publicKey.challenge,
            origin,
            crossOrigin: false,
          }),
        ).toString('base64url'),
        attestationObject: Buffer.from(att).toString('base64url'),
      },
    },
  };
  let count = 0;
  return {
    proof,
    id,
    assertion(b) {
      const data = Buffer.from(
          JSON.stringify({
            type: 'webauthn.get',
            challenge: b.publicKey.challenge,
            origin,
            crossOrigin: false,
          }),
        ),
        counter = Buffer.alloc(4);
      counter.writeUInt32BE(++count);
      const auth = Buffer.concat([sha('modeldb-a.example.test'), Buffer.from([5]), counter]);
      return {
        format: 'modeldb.device-authentication.v1',
        version: 1,
        instanceId: binding.instanceId,
        deploymentDescriptorSha256: binding.deploymentDescriptorSha256,
        challengeId: b.challengeId,
        credential: {
          id,
          rawId: id,
          type: 'public-key',
          clientExtensionResults: {},
          response: {
            clientDataJSON: data.toString('base64url'),
            authenticatorData: auth.toString('base64url'),
            signature: sign('sha256', Buffer.concat([auth, sha(data)]), pair.privateKey).toString(
              'base64url',
            ),
            userHandle: begin.publicKey.user.id,
          },
        },
      };
    },
  };
}

async function workload(root, build, group, block, size, flood) {
  const child = spawn(
    process.execPath,
    [
      join(repository, 'node_modules/tsx/dist/cli.mjs'),
      fileURLToPath(import.meta.url),
      'service',
      root,
      build,
      group === 'F' ? 'flood' : 'normal',
    ],
    {
      cwd: repository,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...process.env, MODELDB_HOME: join(root, 'unused-home') },
    },
  );
  // Child stderr is bounded and never archived; errors are represented only by safe codes.
  child.stderr.resume();
  const metrics = new Map(),
    metricWaiters = new Map(),
    pending = new Map();
  let seq = 0,
    readyResolve,
    readyReject;
  const ready = new Promise((done, fail) => {
    readyResolve = done;
    readyReject = fail;
  });
  child.on('message', (m) => {
    if (m.type === 'ready') readyResolve(m);
    else if (m.type === 'diagnostic') send(m);
    else if (m.type === 'fatal') readyReject(Error(m.code));
    else if (m.type === 'metric') {
      const waiter = metricWaiters.get(m.id);
      if (waiter) {
        metricWaiters.delete(m.id);
        waiter(m.row);
      } else metrics.set(m.id, m.row);
    } else if (m.type === 'local-result') {
      const p = pending.get(m.id);
      pending.delete(m.id);
      p?.(m);
    }
  });
  child.once('exit', (code) => {
    if (code !== 0) {
      readyReject(Error('PERFORMANCE_SERVICE_EXIT'));
      for (const done of pending.values()) done({ error: 'PERFORMANCE_SERVICE_EXIT' });
    }
  });
  const deadline = setTimeout(() => child.kill(), 1800000);
  deadline.unref();
  let info;
  const zero = {
    serverMs: 0,
    tlsMs: 0,
    queueMs: 0,
    protectionMs: 0,
    verificationMs: 0,
    nodeCpuMs: 0,
    nodeRssMiB: 0,
  };
  const local = async (request) => {
    const id = 'local-' + ++seq,
      start = performance.now();
    const result = await new Promise((done) => {
      pending.set(id, done);
      child.send({ type: 'local', id, request });
    });
    if (result.error) throw Error(result.error);
    return {
      body: result.result,
      metric: { ...zero, ...result.row, clientMs: performance.now() - start },
    };
  };
  const http = async (path, body, session = {}, expected = 200) => {
    const id = 'http-' + ++seq,
      start = performance.now();
    let tcp = 0,
      tlsMs = 0;
    const reply = await new Promise((done, fail) => {
      const url = new URL(info.origin),
        bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = request(
        {
          hostname: url.hostname,
          port: url.port,
          path,
          method: bytes ? 'POST' : 'GET',
          ca: certificate,
          agent: false,
          lookup: (_h, o, cb) =>
            o.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4),
          headers: {
            host: url.host,
            origin: info.origin,
            'sec-fetch-site': 'same-origin',
            'x-drill-id': id,
            ...(bytes
              ? { 'content-type': 'application/json', 'content-length': bytes.length }
              : {}),
            ...(session.token ? { authorization: 'Bearer ' + session.token } : {}),
            ...(session.cookie ? { cookie: session.cookie } : {}),
            ...(session.csrf ? { 'x-modeldb-csrf': session.csrf } : {}),
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('error', fail);
          res.on('end', () => {
            let parsed;
            try {
              parsed = JSON.parse(Buffer.concat(chunks).toString());
            } catch {
              parsed = { bytes: Buffer.concat(chunks).length };
            }
            done({
              status: res.statusCode,
              body: parsed,
              cookies: res.headers['set-cookie'] ?? [],
            });
          });
        },
      );
      req.on('socket', (socket) => {
        socket.once('connect', () => {
          tcp = performance.now();
        });
        socket.once('secureConnect', () => {
          tlsMs = performance.now() - tcp;
        });
      });
      req.setTimeout(90000, () => req.destroy(Error('PERFORMANCE_HTTP_TIMEOUT')));
      req.on('error', fail);
      req.end(bytes);
    });
    const clientMs = performance.now() - start;
    const row =
      metrics.get(id) ??
      (await new Promise((done, fail) => {
        const timer = setTimeout(() => {
          metricWaiters.delete(id);
          fail(Error('PERFORMANCE_SERVER_METRIC_REQUIRED'));
        }, 120000);
        metricWaiters.set(id, (value) => {
          clearTimeout(timer);
          done(value);
        });
      }));
    metrics.delete(id);
    reply.metric = { ...row, tlsMs, clientMs };
    if (expected !== null && reply.status !== expected)
      throw Error(
        `PERFORMANCE_HTTP_STATUS_${expected}_${reply.status}_${/^SECURITY_[A-Z_]+$/.test(reply.body?.code ?? reply.body?.error) ? (reply.body.code ?? reply.body.error) : 'UNKNOWN'}`,
      );
    return reply;
  };
  const measure = async (scenario, fn) => {
    const r = await fn();
    const sample = {
      id: `${block}-${scenario}-${seq}`,
      group,
      block,
      scenario,
      ok: true,
      ...r.metric,
    };
    send({ type: 'sample', sample });
    return r;
  };
  const sessionFrom = (r, old = {}) => {
    const jar = new Map(
      (old.cookie ?? '')
        .split('; ')
        .filter(Boolean)
        .map((s) => s.split(/=(.*)/s).slice(0, 2)),
    );
    for (const s of r.cookies) {
      const [key, value] = s.split(';')[0].split(/=(.*)/s);
      jar.set(key, value);
    }
    return {
      cookie: [...jar].map(([k, v]) => k + '=' + v).join('; '),
      csrf: r.body.csrf ?? old.csrf,
    };
  };
  const rpc = (operation, s) =>
    http('/api/v1/rpc', { version: 1, database: 'bench', operation }, s);
  const throttle = { registration: [], authentication: [] };
  const pace = async (kind, limit) => {
    const times = throttle[kind];
    while (times.length && Date.now() - times[0] > 61000) times.shift();
    if (times.length >= limit) await delay(Math.max(1, 61000 - (Date.now() - times[0])));
    while (times.length && Date.now() - times[0] > 61000) times.shift();
    times.push(Date.now());
  };
  try {
    info = await ready;
    const binding = {
      format: 'modeldb.device-registration.v1',
      version: 1,
      instanceId: info.instanceId,
      deploymentDescriptorSha256: 'a'.repeat(64),
    };
    const credential = async () =>
      local({
        action: 'credential.create',
        principalId: info.principalId,
        name: 'Synthetic measured credential',
        grants,
      });
    if (group !== 'F') {
      const warm = await credential(),
        warmSession = { token: warm.body.token };
      for (let i = 0; i < 2; i++) {
        await rpc(query, warmSession);
        await http('/designer/');
      }
      await local({ action: 'credential.revoke', id: warm.body.credential.id });
    }
    for (let i = 0; i < size; i++) {
      let session, credentialId;
      if (group === 'A') {
        const r = await measure('credentialIssue', credential);
        session = { token: r.body.token };
        credentialId = r.body.credential.id;
      } else {
        await pace('registration', 5);
        const b = await measure('registrationStart', () =>
          http(
            '/security/registration/v1/begin',
            {
              ...binding,
              displayName: 'Synthetic performance device',
              userVerification: 'required',
            },
            {},
            201,
          ),
        );
        const key = softwareKey(binding, b.body, info.origin);
        await measure('registrationProof', () =>
          http('/security/registration/v1/complete', key.proof, {}, 202),
        );
        const list = await local({ action: 'registration.list', instanceId: info.instanceId });
        const approved = await local({
          action: 'registration.approve',
          instanceId: info.instanceId,
          id: b.body.registrationId,
          revision: list.body.revision,
          confirm: true,
          name: 'Synthetic measured operator',
          grants,
        });
        credentialId = approved.body.credentialId;
        for (let n = 0; n < 2; n++) {
          await pace('authentication', 10);
          const begin = await http(
            '/security/authentication/v1/begin',
            { ...binding, format: 'modeldb.device-authentication.v1', rawId: key.id },
            {},
            201,
          );
          const nonce = sessionFrom(begin);
          const login = await measure('login', async () => {
            const finish = await http(
              '/security/authentication/v1/complete',
              key.assertion(begin.body),
              nonce,
            );
            for (const field of [
              'clientMs',
              'serverMs',
              'tlsMs',
              'queueMs',
              'protectionMs',
              'verificationMs',
              'nodeCpuMs',
            ])
              finish.metric[field] += begin.metric[field];
            finish.metric.nodeRssMiB = Math.max(finish.metric.nodeRssMiB, begin.metric.nodeRssMiB);
            return finish;
          });
          session = sessionFrom(login, nonce);
        }
        const refreshed = await measure('refresh', () =>
          http('/api/v1/security/session/refresh', {}, session),
        );
        session = sessionFrom(refreshed, session);
      }
      for (let n = 0; n < 2; n++) {
        const r = await measure('query1000', () => rpc(query, session));
        assert.equal(r.body.result?.rows?.length, 1000, 'PERFORMANCE_QUERY_RESULT');
      }
      if (i < 6) {
        await measure('batchSave', () =>
          rpc(
            {
              op: 'insertMany',
              model: 'Saved',
              rows: Array.from({ length: 10 }, (_, n) => ({ code: `batch-${i}-${n}`, score: n })),
              sync: true,
            },
            session,
          ),
        );
      }
      await measure('static', () => http('/designer/'));
      if (group === 'A')
        await measure('revoke', () => local({ action: 'credential.revoke', id: credentialId }));
      else {
        const keys = await local({
          action: 'registration.credentials.list',
          instanceId: info.instanceId,
        });
        await measure('revoke', () =>
          local({
            action: 'registration.credential.disable',
            instanceId: info.instanceId,
            id: credentialId,
            revision: keys.body.revision,
            confirm: true,
          }),
        );
      }
      await measure('revocationProbe', () =>
        http('/api/v1/rpc', { version: 1, database: 'bench', operation: query }, session, 401),
      );
      send({ type: 'progress', block, completed: i + 1, total: size });
    }
    if (flood) {
      const network = await local({ action: 'network.status' }),
        config = structuredClone(network.body.config);
      config.data = {
        allowListEnabled: true,
        allow: [{ id: randomUUID(), source: '127.0.0.0/8', reason: 'Synthetic loopback repair' }],
        deny: [],
      };
      const preview = await local({ action: 'network.preview', config });
      const started = performance.now();
      send({ type: 'progress', stage: 'native-flood-ready' });
      let completed = 0;
      const requests = Array.from({ length: 48 }, () =>
        http(
          '/security/registration/v1/begin',
          { ...binding, displayName: 'Synthetic flood device', userVerification: 'required' },
          {},
          null,
        ).then((r) => {
          completed++;
          return r;
        }),
      );
      await Promise.race(requests);
      const completedBeforeRepair = completed;
      const repair = await local({
        action: 'network.apply',
        config,
        revision: preview.body.revision,
        previewId: preview.body.id,
      });
      send({ type: 'progress', stage: 'native-local-repair', durationMs: repair.metric.clientMs });
      const replies = await Promise.all(requests);
      const confirmed = await local({ action: 'network.confirm', id: repair.body.pending.id });
      const rolledBack = await local({
        action: 'network.rollback',
        revision: confirmed.body.revision,
      });
      const audit = await local({ action: 'audit.page', query: { offset: 0, limit: 100 } });
      return {
        requests: 48,
        concurrency: 48,
        completed: replies.length,
        completedBeforeRepair,
        unexpected: replies.filter(
          (r) =>
            ![429, 503].includes(r.status) ||
            !['SECURITY_REGISTRATION_CAPACITY', 'SECURITY_REGISTRATION_RATE_LIMITED'].includes(
              r.body.code,
            ),
        ).length,
        localMutationSucceeded: repair.body.config.data.allowListEnabled === true,
        networkPolicyRolledBack:
          JSON.stringify(rolledBack.body.config) === JSON.stringify(network.body.config),
        localMutationMs: repair.metric.clientMs,
        pendingCapacity: info.pendingCapacity,
        capacityRejected: replies.some((r) => r.body.code === 'SECURITY_REGISTRATION_CAPACITY'),
        auditPresent:
          audit.body.events
            .filter(
              (e) =>
                e.action === 'authentication.reject' &&
                /^SECURITY_REGISTRATION_(CAPACITY|RATE_LIMITED)$/.test(e.reasonCode),
            )
            .reduce((sum, e) => sum + (e.aggregation?.observedCount ?? 1), 0) === 48,
        durationMs: performance.now() - started,
        maxRequestMs: Math.max(...replies.map((r) => r.metric.clientMs)),
        nodeRssMiB: Math.max(...replies.map((r) => r.metric.nodeRssMiB)),
      };
    }
    return {};
  } finally {
    if (child.connected) child.send({ type: 'close' });
    clearTimeout(deadline);
    let forced = false;
    const closeDeadline = setTimeout(() => {
      forced = true;
      child.kill();
    }, 30000);
    try {
      if (child.exitCode === null) await new Promise((done) => child.once('exit', done));
      if (forced) throw Error('PERFORMANCE_SERVICE_CLOSE_TIMEOUT');
    } finally {
      clearTimeout(closeDeadline);
    }
  }
}

// Standalone capacity/flood run reuses only a generated fixture from this invocation.
async function floodWorkload(root, build) {
  const native = await workload(root, build, 'F', 4, 0, true);
  let unlock;
  const gate = new Promise((done) => {
    unlock = done;
  });
  const f = await integrationFixture(async (options) => {
    await gate;
    return verifyRegistrationResponse(options);
  });
  const ctx = {
    source: { peerIp: '127.0.0.1', clientIp: '127.0.0.1', clientIpBasis: 'socket', secure: true },
    requestId: 'synthetic-bounded-proof',
    recheck() {},
  };
  try {
    const proofs = [];
    for (let i = 0; i < 37; i++) {
      const b = await f.service.begin(
        {
          format: 'modeldb.device-registration.v1',
          version: 1,
          instanceId: f.instanceId,
          deploymentDescriptorSha256: 'a'.repeat(64),
          displayName: 'Synthetic queue',
          userVerification: 'required',
        },
        ctx,
      );
      proofs.push(syntheticProof(f.instanceId, b));
    }
    const calls = proofs.map((p) =>
      f.service.complete(p, ctx).then(
        () => true,
        (e) => e.code,
      ),
    );
    await delay(0);
    const m = f.service.metrics();
    assert.equal(m.activeProofs, 4);
    assert.equal(m.queuedProofs, 32);
    assert.equal(await calls[36], 'SECURITY_REGISTRATION_CAPACITY');
    f.local({ action: 'principal.create', name: 'Synthetic queue maintenance', kind: 'operator' });
    unlock();
    const results = await Promise.all(calls);
    assert.equal(results.filter((r) => r === true).length, 36);
    return {
      ...native,
      proofBounds: {
        active: m.activeProofs,
        queued: m.queuedProofs,
        overflowRejected: true,
        localMutationSucceeded: true,
        protector: 'synthetic AES-GCM; deterministic queue-only check',
        nativePerformance: false,
      },
    };
  } finally {
    unlock();
    await f.stop();
  }
}

if (process.argv[2] === 'service')
  await service(process.argv[3], process.argv[4], process.argv[5] === 'flood').catch((error) => {
    send({
      type: 'fatal',
      code: 'PERFORMANCE_SERVICE_SETUP_FAILED',
      diagnostic: error.code ?? error.message.split('\n')[0].slice(0, 180),
    });
    process.exitCode = 1;
  });
else if (process.argv[2] === 'block')
  await workload(
    process.argv[3],
    process.argv[4],
    process.argv[5],
    Number(process.argv[6]),
    Number(process.argv[7]),
    false,
  )
    .then((result) => send({ type: 'result', result }))
    .catch((error) => {
      send({
        type: 'fatal',
        code: /^PERFORMANCE_/.test(error.message) ? error.message : 'PERFORMANCE_BLOCK_FAILED',
        diagnostic: error.message.split('\n')[0].slice(0, 180),
      });
      process.exitCode = 1;
    });
else if (process.argv[2] === 'flood')
  await floodWorkload(process.argv[3], process.argv[4])
    .then((result) => send({ type: 'result', result }))
    .catch((error) => {
      send({
        type: 'fatal',
        code: /^PERFORMANCE_/.test(error.message) ? error.message : 'PERFORMANCE_FLOOD_FAILED',
      });
      process.exitCode = 1;
    });

/** DR-P4.6 assisted two-Windows drill. Only new temporary synthetic instances. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { hostname, networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { request } from 'node:https';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureModelDbLayoutAtRoot } from '../packages/server/src/modeldb-default-home.ts';
import { loadModelDBServerConfig } from '../packages/server/src/config-loader.ts';
import { buildDualTrackFastify } from '../packages/server/src/dual-track-app.ts';
import { SecurityRegistry } from '../packages/server/src/security/security-registry.ts';
import { WindowsSecretProtector } from '../packages/server/src/security/windows-secret-protector.ts';
import { LocalVaultKeyProvider } from '../packages/server/src/security/local-vault-key-provider.ts';
import { callLocalSecurity } from '../packages/server/src/security/local-management-channel.ts';
import { AuthoringEngine } from '../packages/core/authoring/engine.ts';
import { buildHostedDesigner } from './security-hosting-build.mjs';
import { deviceBrowser } from './security-device-drill-browser.mjs';
import {
  assertProbe,
  assertIsolatedConfig,
  createDrillCertificate,
  digest,
  deviceFailureCode,
  drillRoot,
  ownFile,
  privateIPv4,
  readTicket,
  saveExpression,
  sourceFingerprint,
  uuidPattern,
  validateTicket,
} from './security-device-drill-contract.mjs';

const json = (path, value, fresh = false) =>
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: fresh ? 'wx' : 'w' });
const output = (value) =>
  process.stdout.write(
    typeof value === 'string' ? value + '\n' : JSON.stringify(value, null, 2) + '\n',
  );
const envHash = (runId) => digest(runId + '\0' + hostname().toLowerCase());
const grants = [
  { database: 'synthetic_business', resource: '*', actions: ['model.read', 'model.write'] },
];
let report;
let reportPath;
const save = () => {
  if (reportPath) {
    json(reportPath, report);
  }
};
const check = (name, value = true) => {
  assert.equal(value, true, 'DEVICE_CHECK_FAILED');
  report.checks[name] = true;
  save();
};
function options() {
  const args = process.argv.slice(2),
    action = args.shift(),
    result = { action };
  const fields = {
    prepare: ['server', 'client'],
    smoke: [],
    serve: ['root'],
    client: ['ticket', 'pin', 'browser'],
  };
  assert.ok(Object.hasOwn(fields, action), 'DEVICE_ACTION_REQUIRED_PREPARE_SERVE_CLIENT_SMOKE');
  while (args.length) {
    const flag = args.shift();
    assert.ok(
      flag?.startsWith('--') &&
        fields[action].includes(flag.slice(2)) &&
        !Object.hasOwn(result, flag.slice(2)) &&
        args[0] &&
        !args[0].startsWith('--'),
      'DEVICE_ARGUMENT_REJECTED',
    );
    result[flag.slice(2)] = args.shift();
  }
  return result;
}
function assertOrdinaryWindows() {
  assert.equal(process.platform, 'win32', 'DEVICE_WINDOWS_REQUIRED');
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$identity = [Security.Principal.WindowsIdentity]::GetCurrent(); try { if ((New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { exit 1 } } finally { $identity.Dispose() }',
    ],
    { windowsHide: true, stdio: 'ignore', timeout: 20000 },
  );
  assert.equal(result.status, 0, 'DEVICE_NON_ELEVATED_REQUIRED');
}
function createRoot() {
  const root = join(tmpdir(), 'ModeDB-Device-Drill-' + randomUUID().replaceAll('-', ''));
  output('DrillRoot: ' + root);
  // The protector must create the directory with a protected DACL, not adopt mkdtemp's inherited ACL.
  new WindowsSecretProtector().ensureDirectory(root);
  drillRoot(root);
  return root;
}
async function freePort(address) {
  const server = createServer();
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, address, done);
  });
  const port = server.address().port;
  await new Promise((done, fail) => server.close((e) => (e ? fail(e) : done())));
  assert.notEqual(port, 9091, 'DEVICE_PORT_REJECTED');
  return port;
}
function buildInventory(root, relative = 'designer') {
  const files = [];
  for (const entry of readdirSync(join(root, relative), { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = relative + '/' + entry.name;
    assert.ok(!entry.isSymbolicLink(), 'DEVICE_BUILD_LINK_REJECTED');
    if (entry.isDirectory()) {
      files.push(...buildInventory(root, path));
    } else {
      files.push({ path, sha256: digest(readFileSync(ownFile(root, path))) });
    }
  }
  return files;
}
async function prepare(serverAddress, clientAddress) {
  assert.ok(
    (serverAddress === '127.0.0.1' && clientAddress === '127.0.0.1') ||
      (privateIPv4(serverAddress) && privateIPv4(clientAddress) && serverAddress !== clientAddress),
    'DEVICE_TWO_PRIVATE_ADDRESSES_REQUIRED',
  );
  const addresses = Object.values(networkInterfaces())
    .flat()
    .map((n) => n.address);
  assert.ok(addresses.includes(serverAddress), 'DEVICE_SERVER_ADDRESS_NOT_ON_THIS_COMPUTER');
  const root = createRoot(),
    runId = randomUUID();
  reportPath = join(root, 'prepare-report.json');
  report = {
    format: 'modeldb.device-drill-preparation.v1',
    runId,
    ok: false,
    task: 'DR-P4.6',
    taskComplete: false,
    syntheticOnly: true,
    checks: {},
  };
  save();
  const source = sourceFingerprint();
  const rpId = `drill-${runId}.example.test`;
  const tls = await createDrillCertificate(rpId);
  new WindowsSecretProtector().ensureDirectory(join(root, 'private'));
  writeFileSync(join(root, 'private/tls.key'), tls.privateKey, { flag: 'wx' });
  mkdirSync(join(root, 'transfer'));
  writeFileSync(join(root, 'transfer/server.crt'), tls.certificate, { flag: 'wx' });
  const port = await freePort(serverAddress);
  const ticket = validateTicket({
    format: 'modeldb.windows-device-drill.v1',
    runId,
    serverAddress,
    clientAddress,
    port,
    rpId,
    origin: `https://${rpId}:${port}`,
    spkiSha256: tls.spkiSha256,
    sourceSha256: source,
    expiresAtUtc: new Date(Date.now() + 2 * 3600000).toISOString(),
  });
  json(join(root, 'transfer/connection.json'), ticket, true);
  await buildHostedDesigner(join(root, 'designer'));
  check('freshDesignerBuild');
  const cfg = await loadModelDBServerConfig(ensureModelDbLayoutAtRoot(root), {
    host: serverAddress,
    port,
  });
  const registry = SecurityRegistry.open(join(root, 'security'));
  const instanceId = registry.status().instanceId;
  registry.close();
  const engine = new AuthoringEngine({
    atlas: 'synthetic_business',
    storageRoot: cfg.workspace,
    keyProvider: new LocalVaultKeyProvider(join(root, 'security')),
  });
  try {
    engine.registerModel('SyntheticItem', { label: 'String' });
    await engine.flushAll();
  } finally {
    await engine.close();
  }
  const artifacts = [
    ...buildInventory(root),
    ...[
      'transfer/connection.json',
      'transfer/server.crt',
      'private/tls.key',
      'modeldb.config.json',
    ].map((path) => ({
      path,
      sha256: digest(readFileSync(ownFile(root, path))),
    })),
  ];
  assert.equal(sourceFingerprint(), source, 'DEVICE_SOURCE_CHANGED_DURING_PREPARE');
  json(
    join(root, 'server-state.json'),
    { format: 'modeldb.device-drill-server.v1', instanceId, artifacts },
    true,
  );
  check('syntheticSeed');
  check('uniqueTlsKey');
  report.ok = true;
  save();
  output({
    prepared: true,
    drillRoot: root,
    transferOnly: join(root, 'transfer'),
    pin: ticket.spkiSha256,
    report: reportPath,
    expiresAtUtc: ticket.expiresAtUtc,
    taskComplete: false,
  });
  return root;
}
async function startServer(root) {
  root = drillRoot(root);
  const state = JSON.parse(readFileSync(ownFile(root, 'server-state.json'), 'utf8'));
  assert.equal(state.format, 'modeldb.device-drill-server.v1');
  assert.match(state.instanceId, uuidPattern);
  const ticket = readTicket(ownFile(root, 'transfer/connection.json'));
  assert.equal(sourceFingerprint(), ticket.sourceSha256, 'DEVICE_SOURCE_CHANGED_REPREPARE');
  assert.ok(state.artifacts.length > 3 && state.artifacts.length < 500);
  assert.deepEqual(
    state.artifacts.map((f) => f.path).sort(),
    [
      ...buildInventory(root).map((f) => f.path),
      'transfer/connection.json',
      'transfer/server.crt',
      'private/tls.key',
      'modeldb.config.json',
    ].sort(),
  );
  for (const file of state.artifacts) {
    assert.equal(
      digest(readFileSync(ownFile(root, file.path))),
      file.sha256,
      'DEVICE_PREPARED_BYTES_CHANGED',
    );
  }
  const configPath = ownFile(root, 'modeldb.config.json');
  assertIsolatedConfig(JSON.parse(readFileSync(configPath, 'utf8')));
  for (const name of ['logs', 'vault', 'security', 'cache', 'designer', 'private', 'transfer']) {
    const directory = join(root, name);
    assert.ok(
      lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink(),
      'DEVICE_DIRECTORY_LINK_REJECTED',
    );
    assert.equal(
      realpathSync(directory).toLowerCase(),
      directory.toLowerCase(),
      'DEVICE_DIRECTORY_LINK_REJECTED',
    );
  }
  const cfg = await loadModelDBServerConfig(configPath, {
    host: ticket.serverAddress,
    port: ticket.port,
  });
  const descriptor = {
    format: 'modeldb.device-registration-connection.v1',
    version: 1,
    instanceId: state.instanceId,
    serverOrigin: ticket.origin,
    rpId: ticket.rpId,
    registrationMode: 'enabled',
    issuedAtUtc: new Date(Date.parse(ticket.expiresAtUtc) - 2 * 3600000).toISOString(),
    expiresAtUtc: ticket.expiresAtUtc,
    deploymentDescriptorSha256: digest(JSON.stringify(ticket)),
    tls: { mode: 'owner-pinned', minVersion: 'TLS1.2', spkiSha256: ticket.spkiSha256 },
  };
  const app = await buildDualTrackFastify({
    ...cfg,
    host: ticket.serverAddress,
    port: ticket.port,
    publicBaseUrl: ticket.origin,
    securityMode: 'registry',
    securityAuthentication: { enabled: true, allowStorageMigration: true },
    securityRegistration: { descriptor, allowStorageMigration: true },
    securityHosting: {
      enabled: true,
      designerDirectory: join(root, 'designer'),
      managementPort: 0,
    },
    securityNetwork: {
      transport: {
        mode: 'tls',
        certificateFile: ownFile(root, 'transfer/server.crt'),
        privateKeyFile: ownFile(root, 'private/tls.key'),
      },
      data: {
        allowListEnabled: true,
        allow: [...new Set(['127.0.0.1', ticket.serverAddress, ticket.clientAddress])].map(
          (source, i) => ({ id: 'drill-' + i, source, reason: 'Isolated device drill' }),
        ),
      },
    },
    securityAudit: { maxEvents: 20000, retentionDays: 365 },
  });
  return {
    app,
    ticket,
    state,
    local: (request) =>
      callLocalSecurity(join(root, 'security'), { ...request, instanceId: state.instanceId }),
  };
}
async function interactive(prompt, handler) {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for await (const line of terminal) {
      if (line.trim() === 'stop') {
        break;
      }
      try {
        await handler(line.trim());
      } catch (error) {
        const code = deviceFailureCode(error);
        if (report?.events) {
          report.events.push({ action: 'step-failed', code, atUtc: new Date().toISOString() });
          save();
        }
        output(code + ': check prerequisites; run preserved.');
      }
      output(prompt);
    }
  } finally {
    terminal.close();
  }
}
async function serve(root) {
  root = drillRoot(root);
  let service = await startServer(root);
  const runId = service.ticket.runId;
  reportPath = join(root, `server-report-${randomUUID()}.json`);
  report = {
    format: 'modeldb.device-drill-server-report.v1',
    runId,
    sourceSha256: service.ticket.sourceSha256,
    environmentSha256: envHash(runId),
    taskComplete: false,
    syntheticOnly: true,
    checks: {},
    events: [],
  };
  save();
  const startupCredentials = await service.local({
    action: 'registration.credentials.list',
    limit: 100,
  });
  report.disabledCredentialsAtStartup = startupCredentials.credentials
    .filter((c) => c.state === 'disabled')
    .map((c) => digest(c.id))
    .sort();
  save();
  output({
    origin: service.ticket.origin,
    report: reportPath,
    commands: [
      'list',
      'approve <application UUID>',
      'credentials',
      'disable <credential UUID>',
      'restart',
      'stop',
    ],
  });
  try {
    await interactive(
      'A> list / approve <id> / credentials / disable <id> / restart / stop',
      async (line) => {
        const [command, id, extra] = line.split(/\s+/);
        assert.ok(!extra);
        if (command === 'list') {
          const result = await service.local({ action: 'registration.list', limit: 100 });
          output({
            revision: result.revision,
            applications: result.applications.map(({ id, state }) => ({ id, state })),
          });
        } else if (command === 'credentials') {
          const result = await service.local({
            action: 'registration.credentials.list',
            limit: 100,
          });
          output({
            revision: result.revision,
            credentials: result.credentials.map(({ id, state, userId }) => ({ id, state, userId })),
          });
        } else if (command === 'approve' || command === 'disable') {
          assert.match(id, uuidPattern);
          const approve = command === 'approve';
          const list = await service.local({
            action: approve ? 'registration.list' : 'registration.credentials.list',
            limit: 100,
          });
          assert.ok(
            (approve ? list.applications : list.credentials).some((v) => v.id === id),
            'DEVICE_EXACT_ID_REQUIRED',
          );
          await service.local({
            action: approve ? 'registration.approve' : 'registration.credential.disable',
            id,
            revision: list.revision,
            confirm: true,
            ...(approve ? { name: 'Synthetic device drill operator', grants } : {}),
          });
          report.events.push({
            action: command,
            idSha256: digest(id),
            atUtc: new Date().toISOString(),
          });
          check(approve ? 'localOsApproval' : 'localOsDisable');
          output('SUCCESS: ' + command);
        } else if (command === 'restart') {
          await service.app.close();
          service = await startServer(root);
          report.events.push({ action: 'restart', atUtc: new Date().toISOString() });
          if (report.checks.localOsDisable) {
            const list = await service.local({
              action: 'registration.credentials.list',
              limit: 100,
            });
            const disabled = report.events.filter((e) => e.action === 'disable');
            check(
              'disabledStateSurvivesRestart',
              disabled.every((e) =>
                list.credentials.some((c) => digest(c.id) === e.idSha256 && c.state === 'disabled'),
              ),
            );
          }
          save();
          output('SUCCESS: restarted the isolated instance');
        } else {
          throw Error('DEVICE_COMMAND_REJECTED');
        }
      },
    );
  } finally {
    await service.app.close();
    save();
    output('Report: ' + reportPath);
  }
}
async function client(args) {
  const ticket = readTicket(args.ticket);
  assert.equal(args.pin, ticket.spkiSha256, 'DEVICE_PIN_MISMATCH_OBTAIN_FROM_A_SEPARATELY');
  assert.equal(sourceFingerprint(), ticket.sourceSha256, 'DEVICE_SOURCE_MISMATCH_SYNC_CODE');
  const root = createRoot();
  reportPath = join(root, 'client-report.json');
  report = {
    format: 'modeldb.device-drill-client-report.v1',
    runId: ticket.runId,
    sourceSha256: ticket.sourceSha256,
    environmentSha256: envHash(ticket.runId),
    taskComplete: false,
    syntheticOnly: true,
    hardwareEvidence:
      'operator confirmation required; attestation none does not prove hardware binding',
    checks: {},
    events: [],
  };
  save();
  const page = await deviceBrowser(root, ticket, args.browser ?? 'edge');
  report.browser = page.version;
  const platformAuthenticatorAvailable = await page.evaluate(
    'PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()',
  );
  report.platformAuthenticatorAvailable = platformAuthenticatorAvailable;
  check('secureContext');
  output({
    report: reportPath,
    platformAuthenticatorAvailable,
    instructions:
      'Use the formal Designer registration/login buttons and complete Windows Hello yourself. No virtual authenticator is used.',
    commands: ['status', 'save', 'refresh', 'denied', 'offline', 'online', 'stop'],
  });
  const ready = () => page.evaluate(`fetch('/api/v1/security/session').then(r=>r.status)`);
  try {
    await interactive(
      'B> status / save / refresh / denied / offline / online / stop',
      async (command) => {
        if (command === 'status') {
          const state = await page.evaluate(
            `({state:document.querySelector('[data-identity-state]')?.getAttribute('data-identity-state')??null,applicationId:document.querySelector('[data-identity-state] dd')?.textContent??null,ready:!!document.querySelector('[data-identity-session="ready"]'),issue:document.querySelector('[data-identity-issue]')?.getAttribute('data-identity-issue')??null})`,
          );
          if (state.applicationId && !uuidPattern.test(state.applicationId)) {
            state.applicationId = null;
          }
          output(state);
          if (state.state === 'pending') {
            assert.equal(await ready(), 401);
            check('formalPending');
          }
          if (state.state === 'approved' && !state.ready) {
            assert.equal(await ready(), 401);
            check('approvalRequiresFreshLogin');
          }
          if (state.ready && (await ready()) === 200) {
            check('formalLogin');
          }
        } else if (command === 'save') {
          assert.equal(report.checks.formalLogin, true);
          assertProbe(await page.evaluate(saveExpression(true)));
          check('syntheticSaveReadbackAndBoundaries');
        } else if (command === 'refresh') {
          assert.equal(report.checks.syntheticSaveReadbackAndBoundaries, true);
          await page.call('Page.reload');
          const deadline = Date.now() + 20000;
          while ((await ready()) !== 200) {
            assert.ok(Date.now() < deadline);
            await delay(100);
          }
          assertProbe(await page.evaluate(saveExpression(false)));
          check('reloadReadback');
        } else if (command === 'denied') {
          const denied = await page.evaluate(
            `(async()=>({session:(await fetch('/api/v1/security/session')).status,context:(await fetch('/api/v1/security/context?database=synthetic_business')).status,issue:document.querySelector('[data-identity-issue]')?.getAttribute('data-identity-issue')??null}))()`,
          );
          assert.equal(denied.session, 401);
          assert.equal(denied.context, 401);
          // The sequence is checked with A's timestamps when reports are reviewed.
          report.events.push({
            action: 'denied',
            atUtc: new Date().toISOString(),
            freshLoginIssue: denied.issue === 'identity',
          });
          save();
          output(denied);
        } else if (command === 'offline') {
          await page.call('Network.enable');
          await page.call('Network.emulateNetworkConditions', {
            offline: true,
            latency: 0,
            downloadThroughput: -1,
            uploadThroughput: -1,
          });
          const rejected = await page.evaluate(
            `fetch('/api/v1/security/session').then(()=>false,()=>true)`,
          );
          check('simulatedOfflineRejected', rejected);
        } else if (command === 'online') {
          assert.equal(report.checks.simulatedOfflineRejected, true);
          await page.call('Network.emulateNetworkConditions', {
            offline: false,
            latency: 0,
            downloadThroughput: -1,
            uploadThroughput: -1,
          });
          output({ sessionStatusAfterReconnect: await ready() });
          report.events.push({ action: 'reconnect', atUtc: new Date().toISOString() });
          save();
        } else {
          throw Error('DEVICE_COMMAND_REJECTED');
        }
      },
    );
  } finally {
    await page.close();
    save();
    output('Report: ' + reportPath);
  }
}
async function smoke() {
  const root = await prepare('127.0.0.1', '127.0.0.1');
  const service = await startServer(root);
  reportPath = join(root, 'smoke-report.json');
  report = {
    format: 'modeldb.device-drill-smoke.v1',
    ok: false,
    task: 'DR-P4.6',
    taskComplete: false,
    runId: service.ticket.runId,
    sourceSha256: service.ticket.sourceSha256,
    actualHelloTested: false,
    twoDeviceTested: false,
    syntheticOnly: true,
    checks: {},
  };
  save();
  const status = (path) =>
    new Promise((done, fail) => {
      const req = request(
        service.ticket.origin + path,
        {
          ca: readFileSync(ownFile(root, 'transfer/server.crt')),
          family: 4,
          autoSelectFamily: false,
          lookup: (_host, _opts, cb) => cb(null, '127.0.0.1', 4),
          timeout: 10000,
        },
        (res) => {
          res.resume();
          res.once('end', () => done(res.statusCode));
        },
      );
      req.once('error', fail);
      req.once('timeout', () => req.destroy(Error('DEVICE_SMOKE_TIMEOUT')));
      req.end();
    });
  try {
    check('freshTlsDesigner', (await status('/designer/')) === 200);
    check(
      'anonymousDenied',
      (await status('/api/v1/security/context?database=synthetic_business')) === 401,
    );
    check('publicManagementDenied', (await status('/api/v1/security/admin/overview')) === 404);
    check('registrationDescriptor', (await status('/security/registration/v1/connection')) === 200);
    const list = await service.local({ action: 'registration.list' });
    check('realLocalPipe', Array.isArray(list.applications) && list.applications.length === 0);
    const page = await deviceBrowser(root, service.ticket, 'chrome');
    try {
      report.browser = page.version;
      check('pinnedBrowserSecureContext', await page.evaluate('isSecureContext'));
      const deadline = Date.now() + 20000;
      while (!(await page.evaluate(`!!document.querySelector('[data-identity-register]')`))) {
        assert.ok(Date.now() < deadline, 'DEVICE_DESIGNER_NOT_READY');
        await delay(100);
      }
      check('formalDesignerAvailable');
    } finally {
      await page.close();
    }
    await service.app.close();
    const restarted = await startServer(root);
    try {
      check(
        'isolatedRestart',
        (await restarted.local({ action: 'status' })).instanceId === service.state.instanceId,
      );
    } finally {
      await restarted.app.close();
    }
    report.ok = true;
    save();
    output({
      ok: true,
      report: reportPath,
      taskComplete: false,
      actualHelloTested: false,
      twoDeviceTested: false,
    });
  } finally {
    await service.app.close();
    save();
  }
}
try {
  const args = options();
  assertOrdinaryWindows();
  if (args.action === 'prepare') {
    await prepare(args.server, args.client);
  } else if (args.action === 'serve') {
    await serve(args.root);
  } else if (args.action === 'client') {
    await client(args);
  } else {
    await smoke();
  }
} catch (error) {
  const code = deviceFailureCode(error);
  if (report) {
    report.failureCode = code;
    save();
  }
  output('FAILED: ' + code + (reportPath ? '\nReport: ' + reportPath : ''));
  process.exitCode = 1;
}

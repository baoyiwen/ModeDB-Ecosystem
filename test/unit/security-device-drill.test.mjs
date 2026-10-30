import assert from 'node:assert/strict';
import { randomUUID, X509Certificate } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request } from 'node:https';
import { it } from 'node:test';
import { assertIsolatedConfig, assertProbe, createDrillCertificate, digest, deviceFailureCode, drillRoot, ownFile, privateIPv4, readTicket, saveExpression, validateTicket } from '../../scripts/security-device-drill-contract.mjs';
import { assertDeviceSmoke, verifyDevicePreparationEvidence } from '../../scripts/security-device-drill-evidence.mjs';
import { readDeviceClientStatus, saveDeviceClient, refreshDeviceClient } from '../../scripts/security-device-drill-client-state.mjs';

function ticket() {
  const runId = randomUUID(), rpId = `drill-${runId}.example.test`;
  return { format: 'modeldb.windows-device-drill.v1', runId, serverAddress: '192.168.20.10', clientAddress: '192.168.20.11', port: 49455, rpId, origin: `https://${rpId}:49455`, spkiSha256: 'a'.repeat(64), sourceSha256: 'b'.repeat(64), expiresAtUtc: new Date(Date.now() + 3600000).toISOString() };
}
it('accepts an exact private A/B ticket and the explicit loopback smoke ticket', () => {
  assert.ok(validateTicket(ticket()));
  assert.ok(validateTicket({ ...ticket(), serverAddress: '127.0.0.1', clientAddress: '127.0.0.1' }));
});
it('rejects public, ambiguous, wildcard, multicast and special addresses', () => {
  for (const address of ['0.0.0.0', '8.8.8.8', '169.254.1.2', '127.0.0.2', '192.168.0.255', '10.1.2.0', '192.168.001.2', '10.0.0.256', '::1', 'localhost', '10.0.0.1/24']) {
    assert.equal(privateIPv4(address), false, address);
    assert.throws(() => validateTicket({ ...ticket(), serverAddress: address }));
  }
  assert.throws(() => validateTicket({ ...ticket(), clientAddress: '192.168.20.10' }));
});
it('rejects mismatched origins, RP, credentials in URLs and the real service port', () => {
  for (const changed of [{ origin: 'http://localhost:49455' }, { rpId: 'localhost' }, { port: 9091 }, { port: 0 }, { port: 443 }, { port: 65536 }, { origin: 'https://user:secret@example.test:49455' }]) assert.throws(() => validateTicket({ ...ticket(), ...changed }));
});
it('rejects expired, far future and noncanonical time tickets', () => {
  for (const expiresAtUtc of ['invalid', new Date(Date.now() - 1).toISOString(), new Date(Date.now() + 26 * 3600000).toISOString(), '2090-01-01']) assert.throws(() => validateTicket({ ...ticket(), expiresAtUtc }));
});
it('rejects extra secret fields, missing hashes and malformed run IDs', () => {
  for (const changed of [{ token: 'must never be transferable' }, { privateKey: 'rejected' }, { sourceSha256: '' }, { spkiSha256: 'not a pin' }, { runId: '../outside' }]) assert.throws(() => validateTicket({ ...ticket(), ...changed }));
});
it('requires only a bounded public connection file for B', () => {
  const root = mkdtempSync(join(tmpdir(), 'ModeDB-Device-Drill-'));
  const file = join(root, 'connection.json');
  writeFileSync(file, JSON.stringify(ticket()));
  assert.ok(readTicket(file));
  writeFileSync(file, ' '.repeat(8193));
  assert.throws(() => readTicket(file), /DEVICE_TICKET_FILE_REJECTED/);
  assert.throws(() => readTicket(join(root, 'registry.mds')), /DEVICE_PUBLIC_TICKET_REQUIRED/);
});
it('rejects existing workspace paths and traversal before opening a file', () => {
  const root = mkdtempSync(join(tmpdir(), 'ModeDB-Device-Drill-'));
  assert.equal(drillRoot(root), root);
  assert.throws(() => drillRoot(process.cwd()));
  for (const path of ['../secret', 'private/../secret', 'C:/secret', '/secret', 'a\\secret', 'security:secret']) assert.throws(() => ownFile(root, path), /DEVICE_RELATIVE_PATH_REQUIRED/);
});
it('rejects a directory junction even when its file exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'ModeDB-Device-Drill-'));
  const target = mkdtempSync(join(tmpdir(), 'ModeDB-Device-Drill-'));
  writeFileSync(join(target, 'public.txt'), 'synthetic');
  symlinkSync(target, join(root, 'junction'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.ok(lstatSync(join(root, 'junction')).isSymbolicLink());
  assert.throws(() => ownFile(root, 'junction/public.txt'), /DEVICE_FILE_LINK_REJECTED/);
});
it('accepts the generated layout and rejects every path redirection or security override', () => {
  const config = { port: 9090, host: '127.0.0.1', advertisedHost: '', publicBaseUrl: '', logDir: 'logs', workspace: 'vault', bufferThreshold: 50000, cacheSize: '2GB', mode: 'development', designerWorkspace: 'model_designer_workspace', security: { version: 1 }, autoBackup: { enabled: false, intervalMinutes: 60, runOnStart: false, reason: 'auto' }, dev: false };
  assertIsolatedConfig(config);
  for (const changed of [{ workspace: 'C:/real-data' }, { logDir: '../logs' }, { connectToken: 'real-secret' }, { security: { version: 1, network: {} } }, { autoBackup: { enabled: true } }]) assert.throws(() => assertIsolatedConfig({ ...config, ...changed }));
});
it('requires all synthetic save and authorization boundary assertions', () => {
  const probe = { saved: true, readBack: true, csrfDenied: true, crossDatabaseDenied: true, managementDenied: true };
  assertProbe(probe);
  for (const key of Object.keys(probe)) assert.throws(() => assertProbe({ ...probe, [key]: false }));
  assert.throws(() => assertProbe({ ...probe, extra: true }));
});
it('save probe accepts only the exact hosted or source-policy management refusal, never arbitrary errors', async () => {
  for (const [status, error, expected] of [[404,'SECURITY_NOT_FOUND',true],[403,'SECURITY_SOURCE_DENIED',true],[403,'SECURITY_FORBIDDEN',false],[401,'SECURITY_CREDENTIAL_INVALID',false],[503,'SECURITY_STORE_WRITE_FAILED',false],[404,'unexpected',false],[200,'SECURITY_NOT_FOUND',false]]) {
    const fetch=async(path,options)=>{
      if(path==='/api/v1/security/session')return Response.json({csrf:'synthetic'});
      if(path==='/api/v1/security/admin/overview')return Response.json({error},{status});
      const body=JSON.parse(options.body),denied=body.database==='synthetic_other'||!options.headers['x-modeldb-csrf'];
      return Response.json(denied?{error:'SECURITY_FORBIDDEN'}:{result:'device-drill-saved'},{status:denied?403:200});
    };
    const result=await new Function('fetch','return '+saveExpression(true))(fetch);
    assert.equal(result.managementDenied,expected);
    if(expected)assertProbe(result);
  }
});
function clientFixture() {
  const view = { sessionStatus: 200, editor: true, identityState: null, applicationId: null, offline: false, managementStatus: 404 };
  const checks = {}, requests = [], calls = [];
  const document = { querySelector(selector) {
    if (selector === 'canvas') return view.editor ? {} : null;
    if (selector === '.designer-connection-flow') return view.editor ? null : {};
    if (selector === '[data-identity-state]') return view.identityState ? { getAttribute: () => view.identityState } : null;
    if (selector === '[data-identity-state] dd') return view.applicationId ? { textContent: view.applicationId } : null;
    return null;
  } };
  const fetch = async (path, options) => {
    requests.push({ path, options });
    if (view.offline) throw Error('synthetic network failure');
    if (path === '/api/v1/security/session') return Response.json({ csrf: 'synthetic' }, { status: view.sessionStatus });
    if (path === '/api/v1/security/admin/overview') return Response.json({ error: view.managementStatus === 404 ? 'SECURITY_NOT_FOUND' : 'SECURITY_STORE_WRITE_FAILED' }, { status: view.managementStatus });
    const body = JSON.parse(options.body);
    const denied = body.database === 'synthetic_other' || !options.headers['x-modeldb-csrf'];
    return Response.json(denied ? { error: 'SECURITY_FORBIDDEN' } : { result: 'device-drill-saved' }, { status: denied ? 403 : 200 });
  };
  const performance = { timeOrigin: 1 };
  const page = { evaluate: expression => new Function('document', 'fetch', 'performance', 'return ' + expression)(document, fetch, performance), call: async method => { calls.push(method); if (method === 'Page.reload') performance.timeOrigin++; } };
  return { view, checks, requests, calls, page, check: name => { checks[name] = true; } };
}
it('records a current login when the first status is in the editor with the identity panel unmounted', async () => {
  const f = clientFixture();
  const status = await readDeviceClientStatus(f.page, f.check);
  assert.deepEqual(status, { state: null, applicationId: null, sessionStatus: 200, ready: true, editorReady: true, issue: null });
  assert.deepEqual(f.checks, { formalLogin: true, formalLibraryOpened: true });
  await saveDeviceClient(f.page, f.check);
  assert.equal(f.checks.syntheticSaveReadbackAndBoundaries, true);
});
it('saves directly from the editor without any earlier status command, then reloads and reads without writing again', async () => {
  const f = clientFixture();
  await saveDeviceClient(f.page, f.check);
  const writes = () => f.requests.filter(r => r.options && JSON.parse(r.options.body).operation.op === 'insert').length;
  assert.equal(writes(), 2, 'one denied CSRF probe and one authenticated synthetic insert');
  await refreshDeviceClient(f.page, f.checks, f.check);
  assert.deepEqual(f.calls, ['Page.reload']);
  assert.equal(writes(), 2);
  assert.equal(f.checks.reloadReadback, true);
});
it('requires current authentication before saving despite a visible canvas or previous successful login', async () => {
  for (const sessionStatus of [401, 403, 503]) {
    const f = clientFixture(); f.view.sessionStatus = sessionStatus;
    const status = await readDeviceClientStatus(f.page, f.check);
    assert.equal(status.ready, false); assert.equal(status.sessionStatus, sessionStatus);
    assert.deepEqual(f.checks, {});
    f.checks.formalLogin = true; f.checks.formalLibraryOpened = true;
    await assert.rejects(saveDeviceClient(f.page, f.check), /DEVICE_LOGIN_REQUIRED_BEFORE_SAVE/);
    assert.equal(f.requests.some(r => r.options), false);
    assert.equal(f.checks.syntheticSaveReadbackAndBoundaries, undefined);
  }
});
it('refresh waits for a new document and tolerates a destroyed navigation context before accepting readback', async () => {
  const f = clientFixture(); await saveDeviceClient(f.page, f.check);
  const evaluate = f.page.evaluate; let timeReads = 0;
  f.page.evaluate = async expression => {
    if (expression === 'performance.timeOrigin') {
      timeReads++;
      if (timeReads === 2) return 1; // Page.reload returned while the old document was still present.
      if (timeReads === 3) throw Error('synthetic destroyed execution context');
    }
    return evaluate(expression);
  };
  await refreshDeviceClient(f.page, f.checks, f.check);
  assert.ok(timeReads >= 4); assert.equal(f.checks.reloadReadback, true);
});
it('never accepts a reload when the browser stays on the old document until the deadline', async t => {
  const f = clientFixture(); await saveDeviceClient(f.page, f.check);
  let now = Date.now(), reads = 0;
  t.mock.method(Date, 'now', () => now);
  const evaluate = f.page.evaluate;
  f.page.evaluate = async expression => {
    if (expression === 'performance.timeOrigin') {
      if (++reads > 1) now += 120001;
      return 1;
    }
    return evaluate(expression);
  };
  const before = f.requests.length;
  await assert.rejects(refreshDeviceClient(f.page, f.checks, f.check), /DEVICE_EDITOR_SESSION_NOT_RESTORED/);
  assert.equal(f.checks.reloadReadback, undefined); assert.equal(f.requests.length, before);
});
it('records pending and approved-without-login evidence only for an actual 401 response', async () => {
  for (const identityState of ['pending', 'approved']) for (const sessionStatus of [401, 403, 503]) {
    const f = clientFixture(); Object.assign(f.view, { editor: false, identityState, sessionStatus, applicationId: 'unsafe text' });
    const status = await readDeviceClientStatus(f.page, f.check);
    assert.equal(status.applicationId, null);
    assert.deepEqual(f.checks, sessionStatus === 401 ? { [identityState === 'pending' ? 'formalPending' : 'approvalRequiresFreshLogin']: true } : {});
  }
});
it('does not save or mark acceptance on network failure', async () => {
  const f = clientFixture(); f.view.offline = true;
  await assert.rejects(readDeviceClientStatus(f.page, f.check));
  await assert.rejects(saveDeviceClient(f.page, f.check));
  assert.deepEqual(f.checks, {}); assert.equal(f.requests.some(r => r.options), false);
});
it('refuses a save before opening a library and explains refresh before a successful save', async () => {
  const f = clientFixture(); f.view.editor = false;
  await assert.rejects(saveDeviceClient(f.page, f.check), /DEVICE_OPEN_LIBRARY_BEFORE_SAVE/);
  assert.equal(f.requests.some(r => r.options), false);
  await assert.rejects(refreshDeviceClient(f.page, f.checks, f.check), /DEVICE_SAVE_BEFORE_REFRESH/);
  assert.deepEqual(f.calls, []);
});
it('failed authorization boundaries never mark save or refreshed readback as passing', async () => {
  const f = clientFixture(); f.view.managementStatus = 503;
  await assert.rejects(saveDeviceClient(f.page, f.check), /DEVICE_SAVE_READBACK_OR_BOUNDARY_FAILED/);
  assert.equal(f.checks.syntheticSaveReadbackAndBoundaries, undefined);
  await assert.rejects(refreshDeviceClient(f.page, f.checks, f.check), /DEVICE_SAVE_BEFORE_REFRESH/);
  f.view.managementStatus = 404; await saveDeviceClient(f.page, f.check);
  f.view.managementStatus = 503;
  await assert.rejects(refreshDeviceClient(f.page, f.checks, f.check), /DEVICE_SAVE_READBACK_OR_BOUNDARY_FAILED/);
  assert.equal(f.checks.reloadReadback, undefined);
});
it('generates unique TLS keys and verifies the exact DNS name in a real TLS handshake', async () => {
  const rpId = ticket().rpId;
  const first = await createDrillCertificate(rpId), second = await createDrillCertificate(rpId);
  assert.notEqual(first.spkiSha256, second.spkiSha256);
  assert.notEqual(first.privateKey, second.privateKey);
  const parsed = new X509Certificate(first.certificate);
  assert.equal(parsed.checkHost('wrong.example.test', { subject: 'never' }), undefined);
  assert.equal(digest(parsed.publicKey.export({ type: 'spki', format: 'der' })), first.spkiSha256);
  const server = createServer({ cert: first.certificate, key: first.privateKey }, (_req, res) => res.end('synthetic'));
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  const get = (ca) => new Promise((done, fail) => {
    const req = request({ hostname: rpId, port, path: '/', ca, family: 4, autoSelectFamily: false, lookup: (_host, _options, cb) => cb(null, '127.0.0.1', 4) }, (res) => { res.resume(); res.on('end', () => done(res.statusCode)); });
    req.on('error', fail); req.end();
  });
  try { assert.equal(await get(first.certificate), 200); await assert.rejects(get(second.certificate)); } finally { await new Promise((done) => server.close(done)); }
});
it('the wrapper forwards Unicode paths as arguments without PowerShell JSON parsing', () => {
  const script = readFileSync(new URL('../../scripts/security-device-drill.ps1', import.meta.url), 'utf8');
  assert.ok(script.includes('@deviceArguments'));
  assert.ok(!script.includes('ConvertFrom-Json') && !script.includes('Invoke-Expression'));
});
function smokeReport() {
  return { format: 'modeldb.device-drill-smoke.v1', task: 'DR-P4.6', ok: true, taskComplete: false, actualHelloTested: false, twoDeviceTested: false, syntheticOnly: true, sourceSha256: 'a'.repeat(64), browser: 'Chrome/156.0.0.0', checks: { freshTlsDesigner: true, anonymousDenied: true, publicManagementDenied: true, registrationDescriptor: true, realLocalPipe: true, pinnedBrowserSecureContext: true, formalDesignerAvailable: true, isolatedRestart: true } };
}
it('accepts preparation only and refuses to promote smoke to hardware or final acceptance', () => {
  assertDeviceSmoke(smokeReport());
  for (const changed of [{ taskComplete: true }, { actualHelloTested: true }, { twoDeviceTested: true }, { syntheticOnly: false }, { ok: false }]) assert.throws(() => assertDeviceSmoke({ ...smokeReport(), ...changed }));
});
it('refuses missing, false or extra smoke assertions', () => {
  const report = smokeReport();
  for (const key of Object.keys(report.checks)) assert.throws(() => assertDeviceSmoke({ ...report, checks: { ...report.checks, [key]: false } }));
  assert.throws(() => assertDeviceSmoke({ ...report, checks: { ...report.checks, hello: true } }));
});
function preparationEvidence() {
  const source = { files: [{ path: 'scripts/synthetic.mjs', sha256: 'b'.repeat(64) }] };
  const smoke = { ...smokeReport(), sourceSha256: digest(JSON.stringify(source.files)) };
  const verification = { format: 'modeldb.device-drill-preparation-verification.v1', task: 'DR-P4.6', taskStatus: 'waiting-for-actual-devices', taskComplete: false, tasks: { registration: '22/23', registrationP4: '5/6', registrationWorkPackages: '3/4' }, unitPass: 14, sourceSha256: smoke.sourceSha256 };
  const logs = { 'unit.original.txt': '# tests 14\n# pass 14\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n', 'smoke.original.txt': '{"ok": true}', 'static.original.txt': 'checks passed' };
  const commands = Object.fromEntries(['unit', 'smoke', 'static'].map((name) => [name, { executable: 'C:/node.exe', args: name === 'unit' ? ['--test', 'test/unit/security-device-drill.test.mjs'] : name === 'smoke' ? ['scripts/security-device-drill.mjs', 'smoke'] : ['checks'], exitCode: 0, timedOut: false, log: name + '.original.txt' }]));
  const records = { ...logs, 'verification.json': JSON.stringify(verification), 'source-manifest.json': JSON.stringify(source), 'smoke-report.json': JSON.stringify(smoke), 'commands.json': JSON.stringify(commands) };
  const receipt = { verification: { status: 'preparation-passed', report: 'verification.json' }, files: [{ path: source.files[0].path, sha256Lf: source.files[0].sha256 }], verificationArtifacts: Object.keys(records).map((path) => ({ path })) };
  return { records, receipt, verify: () => verifyDevicePreparationEvidence({ read: (path) => Buffer.from(records[path]), receipt, base: '' }) };
}
it('retains assertion codes while removing paths and actual or expected secret values', () => {
  let error;
  try { assert.equal('synthetic-secret-canary', 'expected-value', 'DEVICE_PIN_MISMATCH_OBTAIN_FROM_A_SEPARATELY'); } catch (failure) { error = failure; }
  assert.equal(deviceFailureCode(error), 'DEVICE_PIN_MISMATCH_OBTAIN_FROM_A_SEPARATELY');
  assert.equal(deviceFailureCode(Error('ENOENT: private path')), 'DEVICE_STEP_FAILED');
  assert.equal(deviceFailureCode(Error('DEVICE_BAD secret-canary')), 'DEVICE_STEP_FAILED');
});
it('binds preparation logs, source and command results while keeping device acceptance pending', () => {
  const item = preparationEvidence();
  assert.equal(item.verify().taskStatus, 'waiting-for-actual-devices');
  assert.equal(item.verify().taskComplete, false);
});
it('rejects evidence without logs, changed sources, duplicated TAP totals or inflated completion', () => {
  const mutations = [
    (v) => { v.receipt.verificationArtifacts = []; },
    (v) => { v.receipt.files[0].sha256Lf = 'c'.repeat(64); },
    (v) => { v.records['unit.original.txt'] += '# pass 14\n'; },
    (v) => { v.records['unit.original.txt'] = v.records['unit.original.txt'].replace('# skipped 0', '# skipped 1'); },
    (v) => { const r = JSON.parse(v.records['verification.json']); r.taskComplete = true; v.records['verification.json'] = JSON.stringify(r); },
    (v) => { const r = JSON.parse(v.records['verification.json']); r.tasks.registration = '23/23'; v.records['verification.json'] = JSON.stringify(r); },
    (v) => { const r = JSON.parse(v.records['commands.json']); r.smoke.exitCode = 1; v.records['commands.json'] = JSON.stringify(r); },
  ];
  for (const mutate of mutations) { const item = preparationEvidence(); mutate(item); assert.throws(item.verify); }
});

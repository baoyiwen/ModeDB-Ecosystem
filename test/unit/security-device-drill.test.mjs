import assert from 'node:assert/strict';
import { randomUUID, X509Certificate } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request } from 'node:https';
import { it } from 'node:test';
import { assertIsolatedConfig, assertProbe, createDrillCertificate, digest, deviceFailureCode, drillRoot, ownFile, privateIPv4, readTicket, validateTicket } from '../../scripts/security-device-drill-contract.mjs';
import { assertDeviceSmoke, verifyDevicePreparationEvidence } from '../../scripts/security-device-drill-evidence.mjs';

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

/** Preparation evidence only. This verifier cannot close the actual-device task. */
import assert from 'node:assert/strict';
import { digest } from './security-device-drill-contract.mjs';
export function assertDeviceSmoke(report) {
  assert.equal(report.format, 'modeldb.device-drill-smoke.v1');
  assert.equal(report.task, 'DR-P4.6');
  assert.equal(report.ok, true);
  assert.equal(report.taskComplete, false, 'DEVICE_ACTUAL_ACCEPTANCE_STILL_PENDING');
  assert.equal(report.actualHelloTested, false, 'DEVICE_SMOKE_IS_NOT_HELLO');
  assert.equal(report.twoDeviceTested, false, 'DEVICE_SMOKE_IS_NOT_TWO_DEVICE');
  assert.equal(report.syntheticOnly, true);
  assert.match(report.sourceSha256, /^[a-f0-9]{64}$/);
  assert.match(report.browser, /Chrome\/[0-9.]+/);
  const checks = [
    'freshTlsDesigner',
    'anonymousDenied',
    'publicManagementDenied',
    'registrationDescriptor',
    'realLocalPipe',
    'pinnedBrowserSecureContext',
    'formalDesignerAvailable',
    'isolatedRestart',
  ];
  assert.deepEqual(Object.keys(report.checks).sort(), checks.sort());
  assert.ok(Object.values(report.checks).every((v) => v === true));
}
export function verifyDevicePreparationEvidence({ read, receipt, base }) {
  const json = (path) => JSON.parse(read(base + path));
  assert.equal(receipt.verification.status, 'preparation-passed');
  assert.equal(receipt.verification.report, base + 'verification.json');
  const verification = json('verification.json');
  assert.equal(verification.format, 'modeldb.device-drill-preparation-verification.v1');
  assert.equal(verification.task, 'DR-P4.6');
  assert.equal(verification.taskStatus, 'waiting-for-actual-devices');
  assert.equal(verification.taskComplete, false, 'DEVICE_ACTUAL_ACCEPTANCE_STILL_PENDING');
  assert.deepEqual(verification.tasks, {
    registration: '22/23',
    registrationP4: '5/6',
    registrationWorkPackages: '3/4',
  });
  const required = [
    'verification.json',
    'smoke-report.json',
    'source-manifest.json',
    'unit.original.txt',
    'smoke.original.txt',
    'commands.json',
    'static.original.txt',
  ];
  for (const name of required) {
    assert.ok(
      receipt.verificationArtifacts.some((f) => f.path === base + name),
      'DEVICE_PREPARATION_ARTIFACT_REQUIRED',
    );
  }
  const smoke = json('smoke-report.json');
  assertDeviceSmoke(smoke);
  const source = json('source-manifest.json');
  assert.equal(digest(JSON.stringify(source.files)), smoke.sourceSha256);
  assert.equal(verification.sourceSha256, smoke.sourceSha256);
  assert.equal(new Set(source.files.map((f) => f.path)).size, source.files.length);
  for (const file of source.files) {
    assert.match(file.sha256, /^[a-f0-9]{64}$/);
    const current = receipt.files.find((f) => f.path === file.path);
    assert.ok(current && current.sha256Lf === file.sha256, 'DEVICE_PREPARATION_SOURCE_CHANGED');
  }
  const tap = read(base + 'unit.original.txt').toString('utf8');
  assert.doesNotMatch(tap, /^not ok |^#.*(?:SKIP|TODO)\b/m);
  const counts = {};
  for (const label of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const entries = [...tap.matchAll(new RegExp('^# ' + label + ' (\\d+)\\s*$', 'gm'))];
    assert.equal(entries.length, 1, 'DEVICE_TAP_STATS_REQUIRED');
    counts[label] = Number(entries[0][1]);
  }
  assert.ok(counts.pass >= 14);
  assert.equal(counts.tests, counts.pass);
  for (const label of ['fail', 'cancelled', 'skipped', 'todo']) {
    assert.equal(counts[label], 0);
  }
  assert.equal(verification.unitPass, counts.pass);
  const commands = json('commands.json');
  for (const name of ['unit', 'smoke', 'static']) {
    const command = commands[name];
    assert.equal(command.exitCode, 0);
    assert.equal(command.timedOut, false);
    assert.equal(
      command.log,
      name === 'unit'
        ? 'unit.original.txt'
        : name === 'smoke'
          ? 'smoke.original.txt'
          : 'static.original.txt',
    );
    assert.match(command.executable, /node(?:\.exe)?$/i);
    assert.ok(Array.isArray(command.args));
  }
  assert.ok(commands.unit.args.includes('test/unit/security-device-drill.test.mjs'));
  assert.deepEqual(commands.smoke.args, ['scripts/security-device-drill.mjs', 'smoke']);
  assert.ok(
    read(base + 'smoke.original.txt')
      .toString('utf8')
      .includes('"ok": true'),
  );
  return verification;
}

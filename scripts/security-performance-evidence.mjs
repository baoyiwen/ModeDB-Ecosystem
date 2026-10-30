/** DR-P4.5 public statistics and frozen-source validation, never opens an instance. */
import assert from 'node:assert/strict';
import {
  digest,
  method,
  assertMeasurements,
  assertPerformanceReport,
} from './security-performance-contract.mjs';
import { assertNoPublicSecrets } from './security-full-contract.mjs';
import { parseRequiredTap } from './security-regression-contract.mjs';
export function verifyPerformanceEvidence({ read, receipt, base }) {
  const required = (name) => {
    assert.ok(
      receipt.verificationArtifacts.some((f) => f.path === base + name),
      'PERFORMANCE_ARTIFACT_REQUIRED: ' + name,
    );
    const bytes = read(base + name);
    assertNoPublicSecrets(bytes);
    return bytes;
  };
  const json = (name) => JSON.parse(required(name));
  const explore = json('exploration/performance.json'),
    confirm = json('confirmation/performance.json'),
    registration = json('registration.json'),
    verification = json('verification.json');
  assertMeasurements(explore, 3);
  assertPerformanceReport(confirm, registration);
  assert.equal(registration.explorationSha256, digest(explore));
  assert.equal(explore.sourceSha256, confirm.sourceSha256);
  assert.equal(explore.candidateSha256, confirm.candidateSha256);
  for (const [key, row] of Object.entries(explore.summary)) {
    const threshold = (value) => Math.max(500, Math.ceil((value * 1.5) / 250) * 250);
    assert.deepEqual(
      registration.limits[key],
      { clientP95Ms: threshold(row.clientMs.p95), serverP95Ms: threshold(row.serverMs.p95) },
      'PERFORMANCE_REGISTERED_LIMIT_CHANGED',
    );
  }
  assert.equal(registration.nodeRssMiB, 1024);
  assert.equal(registration.nodeCpuMaxMs, 10000);
  assert.equal(registration.queueMaxMs, 1000);
  assert.equal(registration.localRepairMaxMs, 15000);
  assert.equal(registration.floodMaxRequestMs, 60000);
  for (const [phase, report] of [
    ['exploration', explore],
    ['confirmation', confirm],
  ]) {
    const source = json(phase + '/source-manifest.json');
    assert.equal(digest(source.sources), report.sourceSha256);
    for (const file of source.sources) {
      assert.ok(
        receipt.files.some((f) => f.path === file.path && f.sha256 === file.sha256),
        'PERFORMANCE_SOURCE_RECEIPT_REQUIRED',
      );
    }
    const candidate = json(phase + '/candidate-manifest.json');
    assert.equal(digest(candidate.files), report.candidateSha256);
    for (const file of candidate.files) {
      assert.match(file.path, /^(?:index\.html|assets\/[A-Za-z0-9_.-]+\.(?:js|css))$/);
      assert.equal(
        digest(required(phase + '/designer/' + file.path).toString('base64')),
        file.sha256,
      );
    }
    for (let i = 0; i < 4; i++) {
      assert.deepEqual(
        json(phase + '/block-' + i + '.json'),
        report.samples.filter((s) => s.block === i),
      );
    }
  }
  assert.equal(verification.revision, 'SEC-M7-D33');
  assert.equal(verification.task, 'DR-P4.5');
  assert.equal(verification.sourceSha256, confirm.sourceSha256);
  assert.equal(verification.confirmationSha256, digest(confirm));
  assert.deepEqual(verification.tasks, {
    registration: '22/23',
    registrationP4: '5/6',
    registrationWorkPackages: '3/4',
  });
  assert.equal(json('documents.json').ok, true);
  const checks = json('checks.json');
  assert.equal(new Set(checks.map((c) => c.name)).size, checks.length);
  for (const name of [
    'tools',
    'affected',
    'browser',
    'types',
    'lint',
    'format',
    'material-guard',
    'source-guard',
    'tools-final',
    'final-lint',
  ]) {
    assert.ok(
      checks.some((c) => c.name === name),
      'PERFORMANCE_CHECK_REQUIRED: ' + name,
    );
  }
  for (const check of checks) {
    assert.equal(check.exitCode, 0);
    assert.equal(check.timedOut, false);
    required(check.log);
  }
  for (const [name, minimum] of [
    ['tools-final', 60],
    ['affected', 187],
    ['browser', 1],
  ]) {
    const check = checks.find((c) => c.name === name),
      parsed = parseRequiredTap(required(check.log).toString(), check.exitCode);
    assert.ok(parsed.pass >= minimum);
  }
  assert.equal(json('types.original.txt').ok, true);
  assert.equal(verification.scope.hardwareAuthenticatorTested, false);
  assert.equal(verification.scope.realTwoDeviceTested, false);
  assert.deepEqual(confirm.method, method);
  return verification;
}

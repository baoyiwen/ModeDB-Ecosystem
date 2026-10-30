/** D29 public development evidence only. Never reads holder keys or instance directories. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseRecipientTap } from './security-recipient-check.mjs';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function verifyRecipientEvidence({ read, receipt, base }) {
  const json = (path) => JSON.parse(read(path).toString('utf8'));
  const required = (path) =>
    assert.ok(
      receipt.verificationArtifacts.some((f) => f.path === path),
      'EVIDENCE_RECIPIENT_ARTIFACT_REQUIRED: ' + path,
    );
  assert.equal(receipt.task, 'DR-P4.1');
  assert.equal(receipt.verification.report, base + 'verification.json');
  for (const name of [
    'verification.json',
    'native/integration-check.json',
    'native/candidate-manifest.json',
    'native/native.original.txt',
    'unit.original.txt',
    'receipt-tools.original.txt',
    'types.original.txt',
    'consumer.original.txt',
    'static-commands.json',
    'documents.json',
    'visual-review.json',
  ]) {
    required(base + name);
  }
  const v = json(base + 'verification.json'),
    report = json(base + 'native/integration-check.json'),
    manifest = json(base + 'native/candidate-manifest.json');
  assert.equal(v.format, 'modeldb.recipient-verification.v1');
  assert.equal(v.task, 'DR-P4.1');
  assert.equal(v.tasks.registration, '18/23');
  assert.equal(v.tasks.registrationP4, '1/6');
  assert.equal(v.tasks.registrationWorkPackages, '3/4');
  assert.equal(report.format, 'modeldb.recipient-check.v1');
  assert.equal(report.ok, true);
  assert.equal(report.task, v.task);
  assert.equal(report.candidateSha256, sha(JSON.stringify(manifest)));
  assert.equal(v.candidateSha256, report.candidateSha256);
  const native = parseRecipientTap(
    read(base + 'native/native.original.txt').toString('utf8'),
    report.exitCode,
  );
  assert.deepEqual(report.unit, native.unit);
  assert.deepEqual(report.browser, native.browser);
  assert.equal(report.build.configFile, false);
  assert.equal(report.build.envFile, false);
  assert.equal(report.scope.temporarySyntheticOnly, true);
  for (const key of ['liveMaterialRead', 'hardwareAuthenticatorTested', 'systemTrustInstalled']) {
    assert.equal(report.scope[key], false);
  }
  assert.ok(manifest.source.length > 0 && manifest.artifacts.length > 0);
  for (const file of manifest.source) {
    assert.equal(
      receipt.files.find((f) => f.path === file.path)?.sha256,
      file.sha256,
      'EVIDENCE_RECIPIENT_SOURCE_REQUIRED',
    );
  }
  for (const file of manifest.artifacts) {
    assert.ok(
      /^(?:index\.html|favicon\.svg|assets\/[A-Za-z0-9_.-]+\.(?:js|css))$/.test(file.path),
      'EVIDENCE_RECIPIENT_BUILD_PATH_REQUIRED',
    );
    required(base + 'native/build/' + file.path);
    assert.equal(sha(read(base + 'native/build/' + file.path)), file.sha256);
  }
  for (const scene of ['challenge', 'review', 'history']) {
    for (const locale of ['zh', 'en', 'ja']) {
      for (const width of [1280, 390]) {
        required(`${base}native/screenshots/${scene}-${locale}-${width}.png`);
      }
    }
  }
  const checkUnit = (name, expected) => {
    const tap = read(base + name).toString('utf8');
    assert.doesNotMatch(tap, /^not ok |^#.*(?:SKIP|TODO)\b/m);
    for (const [name, key] of [
      ['pass', 'pass'],
      ['fail', 'fail'],
      ['skipped', 'skip'],
      ['cancelled', 'cancelled'],
      ['todo', 'todo'],
    ]) {
      const matches = [...tap.matchAll(new RegExp('^# ' + name + ' (\\d+)\\s*$', 'gm'))];
      assert.equal(matches.length, 1);
      assert.equal(Number(matches[0][1]), expected[key]);
    }
    assert.ok(expected.pass > 0);
    for (const key of ['fail', 'skip', 'cancelled', 'todo']) {
      assert.equal(expected[key], 0);
    }
  };
  checkUnit('unit.original.txt', v.unit);
  checkUnit('receipt-tools.original.txt', v.receiptUnit);
  assert.ok(v.unit.pass >= 20);
  assert.equal(v.nativePass, 1);
  assert.equal(v.totalTargetedPass, v.unit.pass + v.receiptUnit.pass + v.nativePass);
  for (const name of ['types.original.txt', 'consumer.original.txt']) {
    assert.equal(json(base + name).ok, true);
    assert.ok(Object.values(json(base + name).checks).every((x) => x === true));
  }
  const commands = json(base + 'static-commands.json');
  assert.ok(commands.length >= 3 && commands.every((c) => c.exitCode === 0));
  assert.equal(json(base + 'documents.json').ok, true);
  assert.equal(json(base + 'visual-review.json').reviewed, true);
  for (const key of [
    'protocolAndRecovery',
    'atomicProofAndHistory',
    'strictTypes',
    'browserBoundary',
    'localizedUi',
    'documents',
    'materialGuard',
  ]) {
    assert.equal(v.checks[key], true, 'EVIDENCE_RECIPIENT_CHECK_REQUIRED: ' + key);
  }
  assert.equal(v.scope.liveMaterialRead, false);
  assert.equal(v.scope.realTwoDeviceTested, false);
  assert.equal(v.scope.packageDeliveryTested, false);
  return v;
}

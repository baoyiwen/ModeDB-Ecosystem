/** D30 development evidence only; never opens a live instance or delivery material. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseRecipientDeliveryTap } from './security-recipient-delivery-check.mjs';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function verifyRecipientDeliveryEvidence({ read, receipt, base }) {
  const json = (path) => JSON.parse(read(path).toString('utf8'));
  const required = (name) => {
    const path = base + name;
    assert.ok(
      receipt.verificationArtifacts.some((f) => f.path === path),
      'DELIVERY_EVIDENCE_REQUIRED: ' + path,
    );
    return path;
  };
  assert.equal(receipt.task, 'DR-P4.2');
  assert.equal(receipt.verification.report, base + 'verification.json');
  for (const name of [
    'verification.json',
    'native/integration-check.json',
    'native/source-manifest.json',
    'native/native.original.txt',
    'unit.original.txt',
    'unit.command.json',
    'receipt-tools.original.txt',
    'receipt-tools.command.json',
    'types.original.txt',
    'consumer.original.txt',
    'static-commands.json',
    'documents.json',
  ]) {
    required(name);
  }
  const v = json(base + 'verification.json'),
    report = json(base + 'native/integration-check.json'),
    manifest = json(base + 'native/source-manifest.json');
  assert.equal(v.format, 'modeldb.recipient-delivery-verification.v1');
  assert.equal(v.task, receipt.task);
  assert.equal(v.tasks.registration, '19/23');
  assert.equal(v.tasks.registrationP4, '2/6');
  assert.equal(v.tasks.registrationWorkPackages, '3/4');
  assert.equal(report.format, 'modeldb.recipient-delivery-check.v1');
  assert.equal(report.ok, true);
  assert.equal(report.task, receipt.task);
  assert.equal(report.platform, 'win32');
  assert.equal(report.timedOut, false);
  assert.equal(report.candidateSha256, sha(JSON.stringify(manifest)));
  assert.equal(v.candidateSha256, report.candidateSha256);
  const actual = parseRecipientDeliveryTap(
    read(base + 'native/native.original.txt').toString('utf8'),
    report.exitCode,
  );
  assert.deepEqual(report.unit, actual.unit);
  assert.deepEqual(report.native, actual.native);
  assert.ok(manifest.source.length > 0);
  assert.equal(new Set(manifest.source.map((f) => f.path)).size, manifest.source.length);
  for (const file of manifest.source) {
    assert.equal(
      receipt.files.find((f) => f.path === file.path)?.sha256,
      file.sha256,
      'DELIVERY_SOURCE_BINDING_REQUIRED',
    );
  }
  assert.equal(report.scope.temporarySyntheticOnly, true);
  for (const key of [
    'liveMaterialRead',
    'realTwoDeviceTested',
    'frontendChanged',
    'packageFormatsChanged',
  ]) {
    assert.equal(report.scope[key], false);
  }
  const unit = (name, commandName, expected) => {
    const tap = read(base + name).toString('utf8'),
      command = json(base + commandName);
    assert.equal(command.exitCode, 0);
    assert.equal(command.timedOut, false);
    assert.doesNotMatch(tap, /^not ok |^#.*(?:SKIP|TODO)\b/m);
    for (const [raw, key] of [
      ['pass', 'pass'],
      ['fail', 'fail'],
      ['skipped', 'skip'],
      ['cancelled', 'cancelled'],
      ['todo', 'todo'],
    ]) {
      const matches = [...tap.matchAll(new RegExp('^# ' + raw + ' (\\d+)\\s*$', 'gm'))];
      assert.equal(matches.length, 1);
      assert.equal(Number(matches[0][1]), expected[key]);
    }
    assert.ok(expected.pass > 0);
    for (const key of ['fail', 'skip', 'cancelled', 'todo']) {
      assert.equal(expected[key], 0);
    }
  };
  unit('unit.original.txt', 'unit.command.json', v.unit);
  unit('receipt-tools.original.txt', 'receipt-tools.command.json', v.receiptUnit);
  assert.ok(v.unit.pass >= 15);
  assert.equal(v.nativePass, 1);
  assert.equal(v.totalTargetedPass, v.unit.pass + v.receiptUnit.pass + 1);
  for (const name of ['types.original.txt', 'consumer.original.txt']) {
    const result = json(base + name);
    assert.equal(result.ok, true);
    assert.ok(
      Object.values(result.checks).length > 0 &&
        Object.values(result.checks).every((x) => x === true),
    );
  }
  const commands = json(base + 'static-commands.json');
  assert.ok(commands.length >= 4 && commands.every((c) => c.exitCode === 0));
  for (const command of commands) {
    required(command.log);
  }
  assert.equal(json(base + 'documents.json').ok, true);
  for (const key of [
    'exactRecipientAndCas',
    'atomicSealingAudit',
    'existingFormatsAndRecovery',
    'strictTypes',
    'browserBoundary',
    'documents',
    'materialGuard',
  ]) {
    assert.equal(v.checks[key], true);
  }
  assert.equal(v.scope.temporarySyntheticOnly, true);
  assert.equal(v.scope.packageDeliveryTested, true);
  for (const key of [
    'liveMaterialRead',
    'realTwoDeviceTested',
    'frontendChanged',
    'fullReleaseInstallTested',
    'performanceTested',
    'productionMigrationPerformed',
  ]) {
    assert.equal(v.scope[key], false);
  }
  return v;
}

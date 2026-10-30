/** Recorded DR-P4.4 development evidence only; does not rerun or inspect instances. */
import assert from 'node:assert/strict';
import { assertFullCheckReport, assertNoPublicSecrets } from './security-full-contract.mjs';
import { parseRequiredTap } from './security-regression-contract.mjs';
import { assertAuthenticationResilienceMatrix } from './security-authentication-resilience-check.mjs';
import { sha256 } from './security-install-contract.mjs';
export function verifyFullEvidence({ read, receipt, base }) {
  const required = (name) => {
    const path = base + name;
    assert.ok(
      receipt.verificationArtifacts.some((f) => f.path === path),
      'FULL_EVIDENCE_REQUIRED: ' + name,
    );
    return read(path);
  };
  const json = (name) => JSON.parse(required(name).toString('utf8'));
  assert.equal(receipt.task, 'DR-P4.4');
  assert.equal(receipt.verification.report, base + 'verification.json');
  const v = json('verification.json'),
    full = json('native/full-check.json'),
    source = json('native/source-manifest.json');
  assert.equal(v.format, 'modeldb.full-verification.v1');
  assert.equal(v.task, receipt.task);
  assert.deepEqual(v.tasks, {
    registration: '21/23',
    registrationP4: '4/6',
    registrationWorkPackages: '3/4',
  });
  assertFullCheckReport(full);
  assert.equal(full.sourceSha256, sha256(required('native/source-manifest.json')));
  assert.equal(v.sourceSha256, full.sourceSha256);
  assert.ok(source.sources.length > 0);
  assert.equal(new Set(source.sources.map((f) => f.path)).size, source.sources.length);
  for (const file of source.sources) {
    assert.equal(
      receipt.files.find((f) => f.path === file.path)?.sha256,
      file.sha256,
      'FULL_SOURCE_BINDING_REQUIRED',
    );
  }
  const raw = required('regression/unit.original.txt').toString('utf8');
  assert.deepEqual(
    parseRequiredTap(raw, full.regression.results[0].exitCode),
    full.regression.unit,
  );
  const matrices = [
    ...raw.matchAll(/^# (\{"format":"modeldb\.authentication-resilience-matrix\.v1".*\})\s*$/gm),
  ];
  assert.equal(matrices.length, 1);
  const matrix = JSON.parse(matrices[0][1]);
  assertAuthenticationResilienceMatrix(matrix);
  assert.deepEqual(full.resilience, matrix);
  for (const result of full.regression.results) {
    const name =
      result.name === 'unit'
        ? 'regression/unit.original.txt'
        : 'regression/' + result.name + '.original.txt';
    assertNoPublicSecrets(required(name));
  }
  const browserManifest = json('browser/candidate-manifest.json');
  assert.equal(full.browser.candidateSha256, sha256(JSON.stringify(browserManifest)));
  for (const file of browserManifest.sources) {
    assert.equal(
      source.sources.find((f) => f.path === file.path)?.sha256,
      file.sha256,
      'FULL_BROWSER_SOURCE_REQUIRED',
    );
  }
  for (const file of browserManifest.applications) {
    assertNoPublicSecrets(required('browser/builds/' + file.path));
    assert.equal(sha256(required('browser/builds/' + file.path)), file.sha256);
  }
  for (const group of full.browser.groups) {
    const tap = required('browser/' + group.log);
    assert.equal(parseRequiredTap(tap.toString('utf8'), group.exitCode).pass, group.unit.pass);
    assertNoPublicSecrets(tap);
  }
  for (const group of full.native) {
    const tap = required('native/' + group.name + '.original.txt');
    assert.equal(parseRequiredTap(tap.toString('utf8'), group.exitCode).pass, group.unit.pass);
    assertNoPublicSecrets(tap);
  }
  assert.ok(full.scannedFiles > 0);
  assert.deepEqual(
    full.commands.map((command) => command.name),
    [
      ...full.native.map((group) => group.name),
      'security-registration-storage-check',
      'security-registration-consumer-check',
    ],
  );
  for (const command of full.commands) {
    assert.equal(command.exitCode, 0);
    assert.equal(command.timedOut, false);
    assert.deepEqual(json('native/command-' + command.name + '.json'), command);
  }
  for (const name of [
    'security-registration-storage-check',
    'security-registration-consumer-check',
  ]) {
    const result = json('native/' + name + '.original.txt');
    assert.equal(result.ok, true);
    assert.ok(
      Object.values(result.checks).length > 0 &&
        Object.values(result.checks).every((v) => v === true),
    );
  }
  assert.equal(v.totalPass, full.totalPass);
  assert.equal(v.unitPass, full.regression.unit.pass);
  assert.equal(v.nativePass, 22);
  const statics = json('static-commands.json');
  assert.ok(statics.length >= 4);
  for (const command of statics) {
    assert.equal(command.exitCode, 0);
    required(command.log);
  }
  assert.equal(json('documents.json').ok, true);
  assert.equal(v.scope.temporarySyntheticOnly, true);
  for (const key of [
    'performanceTested',
    'realTwoDeviceTested',
    'hardwareAuthenticatorTested',
    'liveMaterialRead',
    'productionMigrationPerformed',
    'frontendChanged',
  ]) {
    assert.equal(v.scope[key], false);
  }
  return v;
}

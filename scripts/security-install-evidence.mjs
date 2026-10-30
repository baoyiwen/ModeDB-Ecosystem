/** D31 recorded development evidence; does not rerun installation or open instance state. */
import assert from 'node:assert/strict';
import { assertInstalledUpgradeReport, sha256 } from './security-install-contract.mjs';
export function verifyInstallEvidence({ read, receipt, base }) {
  const required = (name) => {
    const path = base + name;
    assert.ok(
      receipt.verificationArtifacts.some((f) => f.path === path),
      'INSTALL_EVIDENCE_REQUIRED: ' + name,
    );
    return read(path);
  };
  const json = (name) => JSON.parse(required(name).toString('utf8'));
  assert.equal(receipt.task, 'DR-P4.3');
  assert.equal(receipt.verification.report, base + 'verification.json');
  const v = json('verification.json'),
    report = json('native/install-check.json'),
    manifest = json('native/release-candidate.json');
  assert.equal(v.format, 'modeldb.install-verification.v1');
  assert.equal(v.task, receipt.task);
  assert.deepEqual(v.tasks, {
    registration: '20/23',
    registrationP4: '3/6',
    registrationWorkPackages: '3/4',
  });
  assert.equal(report.format, 'modeldb.security-install-check.v1');
  assert.equal(report.task, receipt.task);
  assert.equal(report.ok, true);
  assert.equal(report.platform, 'win32');
  assert.equal(manifest.format, 'modeldb.security-release-candidate.v1');
  const manifestSha256 = sha256(required('native/release-candidate.json'));
  assert.equal(report.releaseManifestSha256, manifestSha256);
  assert.equal(v.candidateSha256, manifestSha256);
  assert.equal(report.packages, 7);
  assert.equal(report.frontends, 3);
  assert.deepEqual(
    manifest.packages.map((p) => p.name).sort(),
    ['common', 'core', 'data-kit', 'data-ui', 'sdk', 'server', 'shared'].map(
      (n) => '@mode-db/' + n,
    ),
  );
  assert.deepEqual(manifest.apps.map((a) => a.name).sort(), [
    'data-studio',
    'model-designer',
    'web',
  ]);
  for (const key of [
    'freshOutput',
    'minifiedProductionPackages',
    'exactArchiveManifest',
    'offlineTarballInstall',
    'cliHelp',
    'binShim',
    'consumerTypes',
    'installedBrowserTypesWithoutNode',
    'unchangedSource',
    'cleanFrontends',
    'documentedCliAndSecurityI18n',
  ]) {
    assert.equal(manifest.checks[key], true);
  }
  assert.equal(manifest.checks.frontendBuild.configFile, false);
  assert.equal(manifest.checks.frontendBuild.envFile, false);
  assert.ok(manifest.offlineDependencies.length > 0);
  assert.ok(manifest.documentation.length >= 9);
  assert.equal(manifest.i18n.length, 3);
  for (const locale of manifest.i18n) {
    assert.deepEqual(locale.keys, manifest.i18n[0].keys);
  }
  assert.deepEqual(
    report.commands.map((c) => c.name),
    ['candidate', 'upgrade'],
  );
  for (const command of report.commands) {
    assert.equal(command.exitCode, 0);
    assert.equal(command.timedOut, false);
  }
  assert.ok(
    required('native/candidate.original.txt')
      .toString('utf8')
      .includes('SUCCESS: ' + report.releaseRoot),
  );
  const upgrade = JSON.parse(required('native/upgrade.original.txt').toString('utf8').trim());
  assert.deepEqual(report.upgrade, upgrade);
  assertInstalledUpgradeReport(upgrade);
  assert.equal(upgrade.releaseManifestSha256, manifestSha256);
  assert.deepEqual(upgrade.legacy.rejectedVersions, [2, 3, 4, 5]);
  assert.equal(
    upgrade.legacy.sourceSha256,
    'ca5c64f8b3c5559cefffc0e11dfa2aa3240f96775b90f4f2a4e6f532fb3bdf0c',
  );
  assert.match(upgrade.legacy.compiledSha256, /^[a-f0-9]{64}$/);
  assert.ok(
    Object.values(report.checks).length === 7 &&
      Object.values(report.checks).every((x) => x === true),
  );
  assert.equal(report.sourceFiles, manifest.sourceFiles.length);
  assert.ok(manifest.sourceFiles.length > 0);
  for (const file of [...manifest.sourceFiles, ...manifest.documentation]) {
    assert.equal(
      receipt.files.find((f) => f.path === file.path)?.sha256,
      file.sha256,
      'INSTALL_SOURCE_BINDING_REQUIRED',
    );
  }
  const tapCheck = (name, expected) => {
    const tap = required(name + '.original.txt').toString('utf8'),
      command = json(name + '.command.json');
    assert.equal(command.exitCode, 0);
    assert.equal(command.timedOut, false);
    assert.doesNotMatch(tap, /^not ok |^#.*(?:SKIP|TODO)\b/m);
    for (const [label, key] of [
      ['tests', 'pass'],
      ['pass', 'pass'],
      ['fail', 'fail'],
      ['skipped', 'skip'],
      ['cancelled', 'cancelled'],
      ['todo', 'todo'],
    ]) {
      const matches = [...tap.matchAll(new RegExp('^# ' + label + ' (\\d+)\\s*$', 'gm'))];
      assert.equal(matches.length, 1);
      assert.equal(Number(matches[0][1]), expected[key]);
    }
    assert.ok(expected.pass > 0);
    for (const key of ['fail', 'skip', 'cancelled', 'todo']) {
      assert.equal(expected[key], 0);
    }
  };
  tapCheck('unit', v.unit);
  tapCheck('receipt-tools', v.receiptUnit);
  assert.equal(v.nativePass, 1);
  assert.equal(v.totalTargetedPass, v.unit.pass + v.receiptUnit.pass + 1);
  const staticCommands = json('static-commands.json');
  assert.ok(staticCommands.length >= 4);
  for (const command of staticCommands) {
    assert.equal(command.exitCode, 0);
    required(command.log);
  }
  assert.equal(json('documents.json').ok, true);
  assert.equal(v.scope.temporarySyntheticOnly, true);
  assert.equal(v.scope.installedCandidateTested, true);
  for (const key of [
    'liveMaterialRead',
    'realTwoDeviceTested',
    'hardwareAuthenticatorTested',
    'performanceTested',
    'fullHistoricalPackageDowngradeTested',
    'productionMigrationPerformed',
    'frontendChanged',
  ]) {
    assert.equal(v.scope[key], false);
  }
  assert.equal(report.scope.temporarySyntheticOnly, true);
  for (const key of [
    'liveMaterialRead',
    'realTwoDeviceTested',
    'frontendChanged',
    'performanceTested',
    'fullHistoricalPackageDowngradeTested',
  ]) {
    assert.equal(report.scope[key], false);
  }
  return v;
}

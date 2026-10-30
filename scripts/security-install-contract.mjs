/** Public development artifacts only. Never resolves a user configuration or instance path. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const installedUpgradeChecks = [
  'nativeDpapi',
  'installedModulesOnly',
  'legacyCompiledReaderBaseline',
  'explicitV1ToV5',
  'identityAndKeysPreserved',
  'legacyReaderRejectsV2ToV5',
  'unknownLedgerRejectedUnchanged',
  'unknownPackagesRejected',
  'registeredSignatureLogin',
  'registrationClosedLoginStillWorks',
  'authenticationDisabled',
  'disabledIdentitySurvivesRestart',
  'reenableRequiresFreshLogin',
  'recipientHistoryPreserved',
  'accessResetDoesNotRevive',
  'installedRecipientCli',
  'installedDesignerHosting',
];
export function temporaryReleaseRoot(value) {
  const root = resolve(value),
    temporary = realpathSync(tmpdir());
  assert.equal(resolve(root, '..'), temporary, 'INSTALL_TEMPORARY_ROOT_REQUIRED');
  assert.match(root.slice(temporary.length + 1), /^ModeDB-Release-[A-Za-z0-9]+$/);
  assert.equal(lstatSync(root).isSymbolicLink(), false, 'INSTALL_LINK_REJECTED');
  assert.equal(realpathSync(root), root, 'INSTALL_ROOT_ALIAS_REJECTED');
  return root;
}
export function artifactFile(root, path) {
  assert.ok(
    typeof path === 'string' &&
      path.length > 0 &&
      !path.includes('\\') &&
      !path.includes(':') &&
      path.split('/').every((p) => p && p !== '.' && p !== '..'),
    'INSTALL_ARTIFACT_PATH_REQUIRED',
  );
  let current = root;
  for (const part of path.split('/')) {
    current = join(current, part);
    assert.equal(lstatSync(current).isSymbolicLink(), false, 'INSTALL_LINK_REJECTED');
  }
  assert.equal(lstatSync(current).isFile(), true, 'INSTALL_FILE_REQUIRED');
  return current;
}
export function checkInstalledCandidate(releaseRoot) {
  const root = temporaryReleaseRoot(releaseRoot);
  const manifestBytes = readFileSync(artifactFile(root, 'release-candidate.json'));
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.format, 'modeldb.security-release-candidate.v1');
  assert.deepEqual(
    manifest.packages.map((p) => p.name).sort(),
    ['common', 'core', 'data-kit', 'data-ui', 'sdk', 'server', 'shared'].map(
      (n) => '@mode-db/' + n,
    ),
  );
  assert.deepEqual(manifest.apps.map((p) => p.name).sort(), [
    'data-studio',
    'model-designer',
    'web',
  ]);
  assert.equal(manifest.checks.offlineTarballInstall, true);
  assert.equal(manifest.checks.consumerTypes, true);
  assert.equal(manifest.checks.installedBrowserTypesWithoutNode, true);
  assert.equal(manifest.checks.unchangedSource, true);
  assert.equal(manifest.checks.frontendBuild.configFile, false);
  assert.equal(manifest.checks.frontendBuild.envFile, false);
  const consumer = realpathSync(join(root, 'consumer'));
  assert.equal(consumer, join(root, 'consumer'));
  for (const pkg of manifest.packages) {
    assert.equal(sha256(readFileSync(artifactFile(root, pkg.archive))), pkg.sha256);
    const installed = realpathSync(join(consumer, 'node_modules', pkg.name));
    assert.ok(relative(consumer, installed) && installed.startsWith(consumer + sep));
    for (const file of pkg.files) {
      assert.equal(
        sha256(readFileSync(artifactFile(installed, file.path))),
        file.sha256,
        'INSTALL_PACKAGE_CHANGED',
      );
    }
  }
  for (const dep of manifest.offlineDependencies) {
    assert.equal(sha256(readFileSync(artifactFile(root, dep.archive))), dep.sha256);
  }
  for (const app of manifest.apps) {
    for (const file of app.files) {
      assert.equal(
        sha256(readFileSync(artifactFile(root, 'apps/' + app.name + '/' + file.path))),
        file.sha256,
      );
    }
  }
  for (const file of manifest.documentation) {
    assert.equal(sha256(readFileSync(artifactFile(root, file.path))), file.sha256);
  }
  assert.equal(new Set(manifest.sourceFiles.map((f) => f.path)).size, manifest.sourceFiles.length);
  return { manifest, manifestSha256: sha256(manifestBytes), root, consumer };
}
export function assertInstalledUpgradeReport(report) {
  assert.equal(report.format, 'modeldb.installed-upgrade.v1');
  assert.equal(report.ok, true);
  assert.equal(report.task, 'DR-P4.3');
  assert.equal(report.platform, 'win32');
  assert.match(report.releaseManifestSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(report.checks).sort(), [...installedUpgradeChecks].sort());
  for (const key of installedUpgradeChecks) {
    assert.equal(report.checks[key], true, 'INSTALL_CHECK_REQUIRED: ' + key);
  }
  for (const key of [
    'liveMaterialRead',
    'realTwoDeviceTested',
    'hardwareAuthenticatorTested',
    'fullHistoricalPackageDowngradeTested',
    'performanceTested',
    'frontendChanged',
  ]) {
    assert.equal(report.scope[key], false);
  }
  assert.equal(report.scope.temporarySyntheticOnly, true);
}

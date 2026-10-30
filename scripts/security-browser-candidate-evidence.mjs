/** D28 receipt validation. Reads only supplied development/evidence paths, never an instance. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { candidateGroups, validateCandidateResults } from './security-browser-candidate-check.mjs';
export const candidateUnitGroups = [
  ['hostingUnit', 'hosting', 36],
  ['identityUnit', 'identity', 31],
  ['identityAdminUnit', 'identity-admin', 14],
  ['authenticationUnit', 'authentication', 55],
  ['dynamicUnit', 'dynamic', 42],
  ['regressionUnit', 'regression', 169],
  ['maintenanceUnit', 'maintenance', 33],
  ['toolsUnit', 'tools', 49],
  ['deploymentUnit', 'deployment', 22],
  ['launchCompatibilityUnit', 'launch-compat', 19],
  ['publicReportUnit', 'public-report', 4],
  ['candidateReportUnit', 'candidate-report', 7],
];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function verifyBrowserCandidateEvidence({ read, receipt, base }) {
  const json = (path) => JSON.parse(read(path).toString('utf8'));
  const required = (path) =>
    assert.ok(
      receipt.verificationArtifacts.some((f) => f.path === path),
      'EVIDENCE_CANDIDATE_ARTIFACT_REQUIRED: ' + path,
    );
  assert.equal(receipt.task, 'DR-P3.6');
  assert.equal(receipt.verification.report, base + 'verification.json');
  for (const name of [
    'verification.json',
    'selected-candidate.json',
    'types.original.txt',
    'consumer-native.original.txt',
    'static-commands.json',
    'documents.original.json.txt',
  ]) {
    required(base + name);
  }
  const selected = json(base + 'selected-candidate.json');
  assert.ok(
    new RegExp('^' + base.replaceAll('.', '\\.') + 'run-\\d+$').test(selected.directory),
    'EVIDENCE_CANDIDATE_PATH_REQUIRED',
  );
  const directory = selected.directory + '/';
  required(directory + 'candidate-check.json');
  required(directory + 'candidate-manifest.json');
  const report = json(directory + 'candidate-check.json'),
    manifest = json(directory + 'candidate-manifest.json');
  validateCandidateResults(report);
  assert.equal(manifest.format, 'modeldb.browser-candidate-manifest.v1');
  assert.equal(
    hash(JSON.stringify(manifest)),
    report.candidateSha256,
    'EVIDENCE_CANDIDATE_DIGEST_REQUIRED',
  );
  assert.equal(selected.candidateSha256, report.candidateSha256);
  assert.ok(manifest.sources.length > 0 && manifest.applications.length > 0);
  const seen = new Set();
  for (const source of manifest.sources) {
    assert.ok(!seen.has(source.path), 'EVIDENCE_CANDIDATE_SOURCE_DUPLICATE');
    seen.add(source.path);
    const bound = receipt.files.find((f) => f.path === source.path);
    assert.ok(bound, 'EVIDENCE_CANDIDATE_SOURCE_UNBOUND');
    assert.equal(bound.sha256, source.sha256, 'EVIDENCE_CANDIDATE_SOURCE_MISMATCH');
  }
  const builds = new Set();
  for (const file of manifest.applications) {
    assert.match(
      file.path,
      /^(model-designer|data-studio|web)\/(?:assets\/[^/]+\.(?:js|css)|index\.html|(?:vite|favicon)\.svg)$/,
    );
    assert.ok(!builds.has(file.path));
    builds.add(file.path);
    assert.match(file.sha256, /^[a-f0-9]{64}$/);
  }
  for (const name of ['model-designer', 'data-studio', 'web']) {
    assert.ok(builds.has(name + '/index.html'));
  }
  for (const [index, [name, , parse]] of candidateGroups.entries()) {
    const path = directory + name + '.tap';
    required(path);
    const parsed = parse(read(path).toString('utf8'), report.groups[index].exitCode);
    for (const [key, value] of Object.entries(parsed)) {
      assert.deepEqual(report.groups[index][key], value);
    }
    if (name === 'identity') {
      assert.equal(parsed.browser.checks.syntheticSaveReadback, true);
    }
    if (name === 'public') {
      for (const browser of parsed.browsers) {
        assert.equal(browser.checks.syntheticSaveReadback, true);
      }
    }
  }
  const screenshot = (path) => required(directory + 'screenshots/' + path);
  for (const [group, scenes] of [
    ['identity', ['login', 'pending', 'approved', 'rejected']],
    ['admin', ['applications', 'approval-review', 'conflict', 'credentials']],
    ['deployment', ['local', 'lan', 'review', 'existing']],
    ['hosting', ['connection', 'security']],
  ]) {
    for (const scene of scenes) {
      for (const locale of ['zh', 'en', 'ja']) {
        for (const width of [1280, 390]) {
          screenshot(group + '/' + scene + '-' + locale + '-' + width + '.png');
        }
      }
    }
  }
  for (const app of ['data-studio', 'web']) {
    for (const scene of ['login', 'pending', 'approved', 'rejected']) {
      for (const locale of app === 'web' ? ['zh-CN', 'en'] : ['zh', 'en', 'ja']) {
        for (const width of [1280, 390]) {
          screenshot('public/' + app + '/' + scene + '-' + locale + '-' + width + '.png');
        }
      }
    }
  }
  const verification = json(base + 'verification.json');
  assert.equal(verification.format, 'modeldb.security-browser-candidate-verification.v1');
  assert.equal(verification.task, 'DR-P3.6');
  assert.equal(verification.candidateSha256, report.candidateSha256);
  assert.equal(verification.tasks.registration, '17/23');
  assert.equal(verification.tasks.registrationP3, '6/6');
  assert.equal(verification.tasks.registrationWorkPackages, '3/4');
  for (const [key, name, count] of candidateUnitGroups) {
    const path = base + name + '.original.txt';
    required(path);
    const tap = read(path).toString('utf8');
    assert.doesNotMatch(tap, /^not ok |^#.*(?:SKIP|TODO)\b/m);
    for (const [key, expected] of [
      ['tests', count],
      ['pass', count],
      ['fail', 0],
      ['cancelled', 0],
      ['skipped', 0],
      ['todo', 0],
    ]) {
      const matches = [...tap.matchAll(new RegExp('^# ' + key + ' (\\d+)\\s*$', 'gm'))];
      assert.equal(matches.length, 1);
      assert.equal(Number(matches[0][1]), expected);
    }
    assert.deepEqual(verification[key], { pass: count, fail: 0, skip: 0, cancelled: 0, todo: 0 });
  }
  assert.equal(
    verification.totalTargetedPass,
    candidateUnitGroups.reduce((n, [, , count]) => n + count, 9),
  );
  assert.equal(verification.nativePass, 9);
  for (const key of [
    'singleCandidate',
    'threeClientSaveReadback',
    'hostileBrowser',
    'strictTypes',
    'browserBoundary',
    'scopedStatic',
    'materialGuard',
  ]) {
    assert.equal(verification.checks[key], true);
  }
  const types = json(base + 'types.original.txt'),
    consumer = json(base + 'consumer-native.original.txt');
  assert.equal(types.ok, true);
  for (const key of [
    'entireServerTypecheck',
    'strictHostileBrowserTypecheck',
    'existingDistUnchanged',
  ]) {
    assert.equal(types.checks[key], true);
  }
  assert.equal(consumer.ok, true);
  for (const key of [
    'entireDesignerTypecheck',
    'entireDataStudioTypecheck',
    'entireWebTypecheck',
    'publicIdentityClientConsumer',
    'domTypesWithoutNode',
    'serverLibraryExcluded',
  ]) {
    assert.equal(consumer.checks[key], true);
  }
  const staticCommands = json(base + 'static-commands.json');
  assert.ok(staticCommands.length >= 4 && staticCommands.every((c) => c.exitCode === 0));
  const documents = json(base + 'documents.original.json.txt');
  assert.deepEqual(documents, verification.documentValidation);
  assert.equal(documents.ok, true);
  assert.equal(documents.registrationTaskRows, 23);
  assert.equal(documents.completedRegistrationTasks, 17);
  assert.equal(documents.failures.length, 0);
  assert.equal(verification.scope.temporarySyntheticOnly, true);
  for (const key of [
    'liveMaterialRead',
    'productionMigrationPerformed',
    'physicalAuthenticatorTested',
    'performanceTested',
    'fullReleaseInstallTested',
    'lanTested',
    'fullBusinessSaveTested',
    'uiChanged',
  ]) {
    assert.equal(verification.scope[key], false);
  }
  return verification;
}

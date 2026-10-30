/** DR-P3.6: one fresh frontend candidate, sequential native browser acceptance, no live instance. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createWriteStream,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildReleaseApplication } from './security-release-apps.mjs';
import { parseHostingIntegrationTap } from './security-hosting-integration-check.mjs';
import { parseIdentityBrowserTap } from './security-designer-identity-check.mjs';
import { parseIdentityAdminTap } from './security-identity-admin-check.mjs';
import { parseDeploymentTap } from './security-deployment-wizard-check.mjs';
import { parsePublicClientsTap } from './security-public-clients-check.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const apps = ['model-designer', 'data-studio', 'web'];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function snapshotCandidateDirectory(directory) {
  const result = [];
  function walk(path, prefix = '') {
    assert.equal(lstatSync(path).isSymbolicLink(), false, 'CANDIDATE_LINK_REJECTED');
    for (const name of readdirSync(path).sort()) {
      const absolute = join(path, name),
        relative = prefix + name,
        stat = lstatSync(absolute);
      assert.equal(stat.isSymbolicLink(), false, 'CANDIDATE_LINK_REJECTED');
      if (stat.isDirectory()) {
        walk(absolute, relative + '/');
      } else {
        assert.ok(stat.isFile(), 'CANDIDATE_FILE_REQUIRED');
        result.push({ path: relative, sha256: hash(readFileSync(absolute)) });
      }
    }
  }
  walk(directory);
  return result;
}
function sourceSnapshot() {
  // Explicit development directories only. Never enumerate repository root, dist, .env or instances.
  const directories = [
    ...apps.map((app) => 'apps/' + app + '/src'),
    ...['shared', 'common', 'core', 'server', 'sdk', 'data-kit', 'data-ui'].map(
      (pkg) => 'packages/' + pkg + '/src',
    ),
  ];
  const files = directories.flatMap((dir) =>
    snapshotCandidateDirectory(join(repository, dir)).map((file) => ({
      ...file,
      path: dir + '/' + file.path,
    })),
  );
  const explicit = [
    'package.json',
    'pnpm-lock.yaml',
    'test/vault-keys.ts',
    ...apps.flatMap((app) => ['apps/' + app + '/index.html', 'apps/' + app + '/package.json']),
    ...['shared', 'common', 'core', 'server', 'sdk', 'data-kit', 'data-ui'].map(
      (pkg) => 'packages/' + pkg + '/package.json',
    ),
    ...candidateGroups.flatMap(([, tests]) => tests.map((test) => 'test/integration/' + test)),
    ...readdirSync(join(repository, 'test/fixtures'))
      .filter((name) => /^security-.*\.ts$/.test(name))
      .map((name) => 'test/fixtures/' + name),
    ...[
      'security-browser-candidate-check',
      'security-release-apps',
      'security-hosting-build',
      'security-hosting-integration-check',
      'security-designer-identity-check',
      'security-identity-admin-check',
      'security-deployment-wizard-check',
      'security-public-clients-check',
    ].map((name) => 'scripts/' + name + '.mjs'),
    'test/fixtures/security-registration-tls/modeldb-a.crt',
    'test/fixtures/security-registration-tls/modeldb-a.key',
  ];
  for (const path of [...new Set(explicit)].sort()) {
    const absolute = join(repository, path);
    assert.equal(lstatSync(absolute).isSymbolicLink(), false, 'CANDIDATE_LINK_REJECTED');
    files.push({ path, sha256: hash(readFileSync(absolute)) });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
export const hostileBrowserChecks = [
  'authenticatedPositiveControl',
  'sameOriginCsrfRequired',
  'sameSiteMaliciousFetchDenied',
  'preflightDenied',
  'maliciousFormDenied',
  'frameDenied',
  'sandboxNullOriginDenied',
  'webAuthnWrongRpDenied',
  'rebindingHostDenied',
  'localhostAliasDenied',
  'proxySpoofDenied',
  'dataManagementSeparated',
  'sessionSurvivesAttack',
  'oneTimePairingSurvivesAttack',
  'noPermissiveCors',
  'rejectionsAudited',
];
export function parseHostileBrowserTap(tap, exitCode) {
  assert.equal(exitCode, 0, 'CANDIDATE_HOSTILE_PROCESS_FAILED');
  for (const [key, count] of [
    ['tests', 1],
    ['pass', 1],
    ['fail', 0],
    ['cancelled', 0],
    ['skipped', 0],
    ['todo', 0],
  ]) {
    const matches = [...tap.matchAll(new RegExp('^# ' + key + ' (\\d+)\\s*$', 'gm'))];
    assert.equal(matches.length, 1, 'CANDIDATE_SUMMARY_REQUIRED');
    assert.equal(Number(matches[0][1]), count, 'CANDIDATE_COUNT_REQUIRED');
  }
  assert.doesNotMatch(tap, /^not ok |^#.*(?:SKIP|TODO)\b/m);
  const lines = [...tap.matchAll(/^# (\{"format":"modeldb\.hostile-browser\.v1".*\})\s*$/gm)];
  assert.equal(lines.length, 1, 'CANDIDATE_HOSTILE_REPORT_REQUIRED');
  const browser = JSON.parse(lines[0][1]);
  assert.equal(browser.ok, true);
  assert.match(browser.browser, /^Chrome\/\d/);
  for (const key of ['hardwareAuthenticatorTested', 'systemTrustInstalled', 'liveMaterialRead']) {
    assert.equal(browser[key], false);
  }
  for (const key of hostileBrowserChecks) {
    assert.equal(browser.checks[key], true, 'CANDIDATE_HOSTILE_CHECK_REQUIRED: ' + key);
  }
  return { unit: { pass: 1, fail: 0, skip: 0, cancelled: 0, todo: 0 }, browser };
}
export const candidateGroups = [
  ['hosting', ['security-hosting-browser.test.ts'], parseHostingIntegrationTap],
  ['identity', ['security-designer-identity-browser.test.ts'], parseIdentityBrowserTap],
  ['admin', ['security-identity-admin-browser.test.ts'], parseIdentityAdminTap],
  ['deployment', ['security-deployment-wizard-browser.test.ts'], parseDeploymentTap],
  [
    'public',
    ['security-public-clients-browser.test.ts', 'security-browser-apps.test.ts'],
    parsePublicClientsTap,
  ],
  ['hostile', ['security-hostile-browser.test.ts'], parseHostileBrowserTap],
];
export function validateCandidateResults(report) {
  assert.equal(report.format, 'modeldb.browser-candidate-check.v1');
  assert.equal(report.task, 'DR-P3.6');
  assert.equal(report.ok, true);
  assert.equal(report.platform, 'win32');
  assert.deepEqual(report.build.applications, apps);
  for (const key of ['configFile', 'envFile']) {
    assert.equal(report.build[key], false);
  }
  for (const key of [
    'existingDistUnchanged',
    'sourceUnchanged',
    'buildUnchanged',
    'singleCandidate',
  ]) {
    assert.equal(report.build[key], true);
  }
  for (const key of [
    'liveMaterialRead',
    'hardwareAuthenticatorTested',
    'systemTrustInstalled',
    'lanTested',
    'fullReleaseInstallTested',
  ]) {
    assert.equal(report.scope[key], false);
  }
  assert.equal(report.scope.temporarySyntheticOnly, true);
  assert.match(report.candidateSha256, /^[a-f0-9]{64}$/);
  assert.equal(report.groups.length, candidateGroups.length);
  assert.deepEqual(
    report.groups.map((g) => g.name),
    candidateGroups.map((g) => g[0]),
  );
  for (const [index, group] of report.groups.entries()) {
    assert.equal(group.exitCode, 0);
    assert.equal(group.ok, true);
    assert.equal(group.timedOut, false);
    assert.equal(group.candidateSha256, report.candidateSha256);
    assert.deepEqual(group.unit, {
      pass: [2, 1, 1, 1, 3, 1][index],
      fail: 0,
      skip: 0,
      cancelled: 0,
      todo: 0,
    });
    assert.equal(group.log, group.name + '.tap');
  }
  assert.equal(report.totalNativePass, 9);
  return true;
}
export async function checkBrowserCandidate() {
  assert.equal(process.platform, 'win32', 'CANDIDATE_NATIVE_WINDOWS_REQUIRED');
  const root = mkdtempSync(join(tmpdir(), 'ModeDB-Browser-Candidate-'));
  process.stdout.write(JSON.stringify({ event: 'candidate-start', root }) + '\n');
  const save = (name, value) =>
    writeFileSync(join(root, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  const source = sourceSnapshot(),
    builds = join(root, 'builds');
  const aliases = Object.fromEntries(
    ['sdk', 'shared', 'data-kit', 'data-ui'].map((p) => [
      '@mode-db/' + p,
      join(repository, 'packages', p, 'src/index.ts'),
    ]),
  );
  const groups = [];
  let manifest, candidateSha256, failureCode;
  try {
    for (const name of apps) {
      await buildReleaseApplication({
        name,
        sourceRoot: join(repository, 'apps', name),
        toolingRoot: join(repository, 'apps', name),
        output: join(builds, name),
        aliases,
      });
    }
    manifest = {
      format: 'modeldb.browser-candidate-manifest.v1',
      node: process.version,
      sources: source,
      applications: snapshotCandidateDirectory(builds),
    };
    candidateSha256 = hash(JSON.stringify(manifest));
    save('candidate-manifest.json', manifest);
    for (const [name, files, parse] of candidateGroups) {
      assert.deepEqual(sourceSnapshot(), source, 'CANDIDATE_SOURCE_CHANGED');
      assert.deepEqual(
        snapshotCandidateDirectory(builds),
        manifest.applications,
        'CANDIDATE_BUILD_CHANGED',
      );
      const log = name + '.tap',
        screenshots = join(root, 'screenshots', name),
        started = Date.now();
      const args = [
        join(repository, 'node_modules/tsx/dist/cli.mjs'),
        '--test',
        '--test-reporter=tap',
        '--test-concurrency=1',
        ...files.map((f) => join(repository, 'test/integration', f)),
      ];
      const stream = createWriteStream(join(root, log), { flags: 'wx' });
      const child = spawn(process.execPath, args, {
        cwd: repository,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          MODELDB_HOSTING_TEST_BUILD: join(builds, 'model-designer'),
          MODELDB_PUBLIC_TEST_BUILDS: builds,
          MODELDB_TEST_APP_ROOT: builds,
          MODELDB_HOSTING_TEST_SCREENSHOTS: screenshots,
          MODELDB_TEST_SCREENSHOTS_ROOT: join(screenshots, 'legacy'),
        },
      });
      child.stdout.pipe(stream, { end: false });
      child.stderr.pipe(stream, { end: false });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, 720000);
      const exitCode = await new Promise((done, fail) => {
        child.once('error', fail);
        child.once('close', done);
      }).finally(() => clearTimeout(timer));
      await new Promise((done) => stream.end(done));
      const group = {
        name,
        log,
        exitCode,
        timedOut,
        durationMs: Date.now() - started,
        candidateSha256,
        ok: false,
      };
      groups.push(group);
      assert.equal(timedOut, false, 'CANDIDATE_TIMEOUT');
      Object.assign(group, parse(readFileSync(join(root, log), 'utf8'), exitCode), { ok: true });
      if (name === 'identity') {
        assert.equal(group.browser.checks.syntheticSaveReadback, true);
      }
      if (name === 'public') {
        for (const browser of group.browsers) {
          assert.equal(browser.checks.syntheticSaveReadback, true);
        }
      }
      assert.deepEqual(sourceSnapshot(), source, 'CANDIDATE_SOURCE_CHANGED');
      assert.deepEqual(
        snapshotCandidateDirectory(builds),
        manifest.applications,
        'CANDIDATE_BUILD_CHANGED',
      );
      process.stdout.write(
        JSON.stringify({
          event: 'candidate-group',
          name,
          pass: group.unit.pass,
          durationMs: group.durationMs,
        }) + '\n',
      );
    }
  } catch (error) {
    failureCode = String(error.message).split('\n')[0].slice(0, 240);
  }
  const report = {
    format: 'modeldb.browser-candidate-check.v1',
    task: 'DR-P3.6',
    ok: !failureCode,
    platform: process.platform,
    node: process.version,
    root,
    candidateSha256,
    groups,
    totalNativePass: groups.reduce((n, g) => n + (g.ok ? g.unit.pass : 0), 0),
    build: {
      applications: apps,
      configFile: false,
      envFile: false,
      existingDistUnchanged: true,
      singleCandidate: true,
      sourceUnchanged: !failureCode,
      buildUnchanged: !failureCode,
    },
    scope: {
      temporarySyntheticOnly: true,
      liveMaterialRead: false,
      hardwareAuthenticatorTested: false,
      systemTrustInstalled: false,
      lanTested: false,
      fullReleaseInstallTested: false,
    },
    ...(failureCode ? { failureCode } : {}),
  };
  if (report.ok) {
    validateCandidateResults(report);
  }
  save('candidate-check.json', report);
  return { ...report, report: join(root, 'candidate-check.json') };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert.equal(
      process.argv.length,
      2,
      'Usage: node scripts/security-browser-candidate-check.mjs',
    );
    const result = await checkBrowserCandidate();
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (!result.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(String(error.message).split('\n')[0] + '\n');
    process.exitCode = 1;
  }
}

/** DR-P3.1: explicit fresh build and required native Windows/Chrome acceptance. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildHostedDesigner } from './security-hosting-build.mjs';
const repository = fileURLToPath(new URL('../', import.meta.url));
export const nativeChecks = [
  'nativeDpapi',
  'osAuthenticatedPipe',
  'exactLiveAddress',
  'dataManagementSeparated',
  'anonymousAdminDenied',
  'legacyLaunchBlocked',
  'cookieRestartRecovery',
  'closeReleasesBothPorts',
  'bindFailuresReleaseRegistryAndPipe',
  'invalidBuildRejected',
];
export const browserChecks = [
  'freshDesignerBuild',
  'cspRunsApplication',
  'sameOriginData',
  'osLaunchFragmentRemoved',
  'httpOnlyStrict',
  'csrfRequired',
  'managementOnly',
  'reloadRecovery',
  'refreshAndLogout',
  'localizedZhEnJa',
  'wideAndNarrow',
  'accessibleLanguageControl',
];
export function parseHostingIntegrationTap(tap, exitCode) {
  assert.equal(exitCode, 0, 'HOSTING_PROCESS_FAILED');
  const counts = {};
  for (const k of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...tap.matchAll(new RegExp('^# ' + k + ' (\\d+)\\s*$', 'gm'))];
    assert.equal(matches.length, 1, 'HOSTING_SUMMARY_REQUIRED');
    counts[k] = Number(matches[0][1]);
  }
  assert.equal(counts.tests, 2);
  assert.equal(counts.pass, 2);
  for (const k of ['fail', 'cancelled', 'skipped', 'todo']) {
    assert.equal(counts[k], 0, 'HOSTING_INCOMPLETE');
  }
  assert.equal(/^not ok /m.test(tap), false);
  const records = {};
  for (const [name, checks] of [
    ['native', nativeChecks],
    ['browser', browserChecks],
  ]) {
    const lines = [
      ...tap.matchAll(
        new RegExp('^# (\\{"format":"modeldb\\.hosting-' + name + '\\.v1".*\\})\\s*$', 'gm'),
      ),
    ];
    assert.equal(lines.length, 1, 'HOSTING_' + name.toUpperCase() + '_REQUIRED');
    const record = JSON.parse(lines[0][1]);
    assert.equal(record.ok, true);
    assert.equal(record.liveMaterialRead, false);
    for (const k of checks) {
      assert.equal(record.checks[k], true, 'HOSTING_CHECK_REQUIRED: ' + k);
    }
    records[name] = record;
  }
  assert.match(records.browser.browser, /^Chrome\/\d/);
  assert.equal(records.browser.hardwareAuthenticatorTested, false);
  assert.equal(records.browser.systemTrustInstalled, false);
  assert.equal(records.browser.screenshots, 12);
  return { unit: { pass: 2, fail: 0, skip: 0, cancelled: 0, todo: 0 }, ...records };
}
export async function checkHostingIntegration() {
  const root = mkdtempSync(join(tmpdir(), 'ModeDB-Hosting-Check-')),
    output = join(root, 'designer-build'),
    screenshots = join(root, 'screenshots'),
    log = join(root, 'integration.tap');
  await buildHostedDesigner(output);
  const args = [
    join(repository, 'node_modules/tsx/dist/cli.mjs'),
    '--test',
    '--test-reporter=tap',
    join(repository, 'test/integration/security-hosting-browser.test.ts'),
  ];
  const stream = createWriteStream(log, { flags: 'wx' }),
    child = spawn(process.execPath, args, {
      cwd: repository,
      windowsHide: true,
      env: {
        ...process.env,
        MODELDB_HOSTING_TEST_BUILD: output,
        MODELDB_HOSTING_TEST_SCREENSHOTS: screenshots,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  child.stdout.pipe(stream, { end: false });
  child.stderr.pipe(stream, { end: false });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 420000);
  const exitCode = await new Promise((done, fail) => {
    child.once('error', fail);
    child.once('close', done);
  }).finally(() => clearTimeout(timer));
  await new Promise((done) => stream.end(done));
  let result, errorCode;
  try {
    assert.equal(timedOut, false, 'HOSTING_TIMEOUT');
    result = parseHostingIntegrationTap(readFileSync(log, 'utf8'), exitCode);
  } catch (e) {
    errorCode = String(e.message).split('\n')[0];
  }
  const report = {
    format: 'modeldb.hosting-integration-check.v1',
    task: 'DR-P3.1',
    ok: !errorCode,
    node: process.version,
    platform: process.platform,
    root,
    output,
    screenshots,
    log,
    command: [process.execPath, ...args],
    exitCode,
    ...result,
    ...(errorCode ? { errorCode } : {}),
    build: { configFile: false, envFile: false, existingDistUnchanged: true },
    scope: {
      temporarySyntheticOnly: true,
      liveMaterialRead: false,
      hardwareAuthenticatorTested: false,
      systemTrustInstalled: false,
      productionRegistrationUiTested: false,
    },
  };
  const path = join(root, 'integration-check.json');
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
  return { ...report, report: path };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert.equal(process.argv.length, 2);
    const report = await checkHostingIntegration();
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    if (!report.ok) {
      process.exitCode = 1;
    }
  } catch (e) {
    process.stderr.write('HOSTING_RUNNER_FAILED: ' + String(e.message) + '\n');
    process.exitCode = 1;
  }
}

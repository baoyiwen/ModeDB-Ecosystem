/** DR-P3.4 formal UI acceptance. No repository configuration, installed trust or live data. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildHostedDesigner } from './security-hosting-build.mjs';
const repository = fileURLToPath(new URL('../', import.meta.url));
export const deploymentChecks = [
  'freshDesignerBuild',
  'nativeDpapi',
  'osPairedManagement',
  'loopbackBootstrap',
  'registrationDisabledByDefault',
  'publicPemOnly',
  'wrongRpRejected',
  'wrongPinRejected',
  'previewDoesNotWrite',
  'explicitConfirmation',
  'descriptorImportBinding',
  'descriptorDownload',
  'offlineLeaseRequired',
  'cliFinalize',
  'identityPreserved',
  'persistentPolicyApplied',
  'oneShotCommit',
  'existingInstanceGuide',
  'auditMetadataOnly',
  'syntheticTlsStartup',
  'dataListenerDenied',
  'localizedZhEnJa',
  'wideAndNarrow',
  'labelsAndFocus',
  'formContrast',
  'expiredExportBlocked',
];
export function parseDeploymentTap(tap, exitCode) {
  assert.equal(exitCode, 0, 'DEPLOYMENT_PROCESS_FAILED');
  const unit = {};
  for (const [key, count] of [
    ['tests', 1],
    ['pass', 1],
    ['fail', 0],
    ['cancelled', 0],
    ['skipped', 0],
    ['todo', 0],
  ]) {
    const matches = [...tap.matchAll(new RegExp('^# ' + key + ' (\\d+)\\s*$', 'gm'))];
    assert.equal(matches.length, 1, 'DEPLOYMENT_SUMMARY_REQUIRED');
    assert.equal(Number(matches[0][1]), count, 'DEPLOYMENT_COUNT_REQUIRED');
    if (key !== 'tests') {
      unit[key === 'skipped' ? 'skip' : key] = count;
    }
  }
  assert.doesNotMatch(tap, /^not ok |^#.*(?:SKIP|TODO)\b/m);
  const lines = [
    ...tap.matchAll(/^# (\{"format":"modeldb\.deployment-wizard-browser\.v1".*\})\s*$/gm),
  ];
  assert.equal(lines.length, 1, 'DEPLOYMENT_BROWSER_REQUIRED');
  const browser = JSON.parse(lines[0][1]);
  assert.equal(browser.ok, true);
  assert.match(browser.browser, /^Chrome\/\d/);
  assert.equal(browser.screenshots, 24);
  for (const key of ['hardwareAuthenticatorTested', 'systemTrustInstalled', 'liveMaterialRead']) {
    assert.equal(browser[key], false);
  }
  for (const key of deploymentChecks) {
    assert.equal(browser.checks[key], true, 'DEPLOYMENT_CHECK_REQUIRED: ' + key);
  }
  return { unit, browser };
}
export async function checkDeploymentWizard() {
  const root = mkdtempSync(join(tmpdir(), 'ModeDB-Deployment-Check-')),
    output = join(root, 'designer-build'),
    screenshots = join(root, 'screenshots'),
    log = join(root, 'integration.tap');
  const build = await buildHostedDesigner(output);
  const args = [
    join(repository, 'node_modules/tsx/dist/cli.mjs'),
    '--test',
    '--test-reporter=tap',
    join(repository, 'test/integration/security-deployment-wizard-browser.test.ts'),
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
  }, 300000);
  const exitCode = await new Promise((done, fail) => {
    child.once('error', fail);
    child.once('close', done);
  }).finally(() => clearTimeout(timer));
  await new Promise((done) => stream.end(done));
  let result, errorCode;
  try {
    assert.equal(timedOut, false, 'DEPLOYMENT_TIMEOUT');
    result = parseDeploymentTap(readFileSync(log, 'utf8'), exitCode);
  } catch (error) {
    errorCode = String(error.message).split('\n')[0];
  }
  const report = {
    format: 'modeldb.deployment-wizard-check.v1',
    task: 'DR-P3.4',
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
    build,
    scope: {
      temporarySyntheticOnly: true,
      liveMaterialRead: false,
      hardwareAuthenticatorTested: false,
      systemTrustInstalled: false,
      deploymentWizardTested: true,
    },
  };
  const path = join(root, 'integration-check.json');
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
  return { ...report, report: path };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert.equal(process.argv.length, 2);
    const report = await checkDeploymentWizard();
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    if (!report.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write('DEPLOYMENT_RUNNER_FAILED: ' + String(error.message) + '\n');
    process.exitCode = 1;
  }
}

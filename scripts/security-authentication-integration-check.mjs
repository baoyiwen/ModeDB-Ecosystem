/** Reproducible DR-P2.2 acceptance: isolated synthetic Windows instances and a fresh Chrome profile. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const browserChecks = [
  'actualBrowserWebAuthnGet',
  'freshSdkBundle',
  'nativeTlsDpapiApproval',
  'pendingDenied',
  'httpOnlySecureStrict',
  'dataScope',
  'adminDenied',
  'reloadRecovery',
  'csrfRotation',
  'logout',
  'restartRecovery',
  'disabledNewLogin',
  'expiredRegistrationIndependent',
  'noApiCredential',
  'instanceKeyUnchanged',
];
export function parseAuthenticationIntegrationTap(tap, exitCode) {
  assert.equal(exitCode, 0, 'AUTHENTICATION_INTEGRATION_PROCESS_FAILED');
  const counts = Object.fromEntries(
    ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map((key) => {
      const matches = [...tap.matchAll(new RegExp('^# ' + key + ' (\\d+)\\s*$', 'gm'))];
      assert.equal(matches.length, 1, 'AUTHENTICATION_INTEGRATION_SUMMARY_REQUIRED');
      return [key, Number(matches[0][1])];
    }),
  );
  assert.equal(counts.tests, 1, 'AUTHENTICATION_INTEGRATION_CASES_REQUIRED');
  assert.equal(counts.pass, 1, 'AUTHENTICATION_INTEGRATION_CASES_REQUIRED');
  for (const key of ['fail', 'cancelled', 'skipped', 'todo']) {
    assert.equal(counts[key], 0, 'AUTHENTICATION_INTEGRATION_INCOMPLETE');
  }
  assert.equal(/^not ok /m.test(tap), false, 'AUTHENTICATION_INTEGRATION_FAILED_CASE');
  const lines = [
    ...tap.matchAll(/^# (\{"format":"modeldb\.authentication-browser\.v1".*\})\s*$/gm),
  ];
  assert.equal(lines.length, 1, 'AUTHENTICATION_VIRTUAL_AUTHENTICATOR_EVIDENCE_REQUIRED');
  const browser = JSON.parse(lines[0][1]);
  assert.equal(browser.ok, true);
  assert.match(browser.browser, /^Chrome\/\d/);
  assert.equal(browser.hardwareAuthenticatorTested, false);
  assert.equal(browser.systemTrustInstalled, false);
  for (const name of browserChecks) {
    assert.equal(browser.checks[name], true, 'AUTHENTICATION_BROWSER_CHECK_REQUIRED: ' + name);
  }
  return { unit: { pass: counts.pass, fail: 0, skip: 0, cancelled: 0, todo: 0 }, browser };
}
export async function checkAuthenticationIntegration() {
  const root = mkdtempSync(join(tmpdir(), 'ModeDB-Authentication-Flow-Report-'));
  const log = join(root, 'integration.tap'),
    stream = createWriteStream(log, { flags: 'wx' });
  const args = [
    join(repository, 'node_modules/tsx/dist/cli.mjs'),
    '--test',
    '--test-reporter=tap',
    join(repository, 'test/integration/security-authentication-browser.test.ts'),
  ];
  const started = performance.now();
  const child = spawn(process.execPath, args, {
    cwd: repository,
    windowsHide: true,
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
    assert.equal(timedOut, false, 'AUTHENTICATION_INTEGRATION_TIMEOUT');
    result = parseAuthenticationIntegrationTap(readFileSync(log, 'utf8'), exitCode);
  } catch (error) {
    errorCode = String(error.message).split('\n')[0];
  }
  const report = {
    format: 'modeldb.authentication-integration-check.v1',
    ok: !errorCode,
    task: 'DR-P2.2',
    node: process.version,
    platform: process.platform,
    root,
    command: [process.execPath, ...args],
    exitCode,
    durationMs: performance.now() - started,
    log,
    ...result,
    ...(errorCode ? { errorCode } : {}),
    scope: {
      temporarySyntheticOnly: true,
      liveMaterialRead: false,
      hardwareAuthenticatorTested: false,
      productionRegistrationUiTested: false,
      publicKeyLoginImplemented: true,
      systemTrustInstalled: false,
    },
  };
  const path = join(root, 'integration-check.json');
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
  return { ...report, report: path };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert.equal(
      process.argv.length,
      2,
      'Usage: node scripts/security-authentication-integration-check.mjs',
    );
    const report = await checkAuthenticationIntegration();
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    if (!report.ok) {
      process.exitCode = 1;
    }
  } catch {
    process.stderr.write('AUTHENTICATION_INTEGRATION_RUNNER_FAILED\n');
    process.exitCode = 1;
  }
}

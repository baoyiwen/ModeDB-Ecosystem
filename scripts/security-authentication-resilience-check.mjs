/** DR-P2.5: reproducible synthetic hard exits and signed races, separate from native/hardware tests. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const checks = [
  'hardProcessExits',
  'atomicSessionAudit',
  'unknownOutcomeInspectable',
  'noRevivalAfterRestart',
  'disableEnableProofBarrier',
  'latestReduction',
  'maintenanceCas',
  'legacyApiPairingManagement',
  'noSecretsInLogs',
];
export function assertAuthenticationResilienceMatrix(matrix) {
  assert.equal(matrix.ok, true);
  assert.equal(matrix.hardExitCases, 30);
  assert.equal(matrix.signedRaceCases, 10);
  assert.equal(matrix.auditFaultCases, 4);
  assert.equal(matrix.liveMaterialRead, false);
  assert.equal(matrix.hardwareAuthenticatorTested, false);
  for (const name of checks) {
    assert.equal(matrix.checks[name], true, 'AUTHENTICATION_RESILIENCE_CHECK_REQUIRED: ' + name);
  }
}
export function parseAuthenticationResilienceTap(tap, exitCode) {
  assert.equal(exitCode, 0, 'AUTHENTICATION_RESILIENCE_PROCESS_FAILED');
  const counts = Object.fromEntries(
    ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map((key) => {
      const matches = [...tap.matchAll(new RegExp('^# ' + key + ' (\\d+)\\s*$', 'gm'))];
      assert.equal(matches.length, 1, 'AUTHENTICATION_RESILIENCE_SUMMARY_REQUIRED');
      return [key, Number(matches[0][1])];
    }),
  );
  assert.equal(counts.tests, 55, 'AUTHENTICATION_RESILIENCE_CASES_REQUIRED');
  assert.equal(counts.pass, 55, 'AUTHENTICATION_RESILIENCE_CASES_REQUIRED');
  for (const key of ['fail', 'cancelled', 'skipped', 'todo']) {
    assert.equal(counts[key], 0, 'AUTHENTICATION_RESILIENCE_INCOMPLETE');
  }
  assert.doesNotMatch(tap, /^not ok |^#.*(?:SKIP|TODO)\b/m);
  const lines = [
    ...tap.matchAll(/^# (\{"format":"modeldb\.authentication-resilience-matrix\.v1".*\})\s*$/gm),
  ];
  assert.equal(lines.length, 1, 'AUTHENTICATION_RESILIENCE_MATRIX_REQUIRED');
  const matrix = JSON.parse(lines[0][1]);
  assertAuthenticationResilienceMatrix(matrix);
  return { unit: { pass: counts.pass, fail: 0, skip: 0, cancelled: 0, todo: 0 }, matrix };
}
export async function checkAuthenticationResilience() {
  const root = mkdtempSync(join(tmpdir(), 'ModeDB-Authentication-Resilience-Report-'));
  const log = join(root, 'resilience.tap'),
    stream = createWriteStream(log, { flags: 'wx' });
  const args = [
    join(repository, 'node_modules/tsx/dist/cli.mjs'),
    '--test',
    '--test-reporter=tap',
    join(repository, 'test/unit/security-authentication-resilience.test.ts'),
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
  }, 240000);
  const exitCode = await new Promise((done, fail) => {
    child.once('error', fail);
    child.once('close', done);
  }).finally(() => clearTimeout(timer));
  await new Promise((done) => stream.end(done));
  let result, errorCode;
  try {
    assert.equal(timedOut, false, 'AUTHENTICATION_RESILIENCE_TIMEOUT');
    result = parseAuthenticationResilienceTap(readFileSync(log, 'utf8'), exitCode);
  } catch (error) {
    errorCode = String(error.message).split('\n')[0];
  }
  const report = {
    format: 'modeldb.authentication-resilience-check.v1',
    task: 'DR-P2.5',
    ok: !errorCode,
    node: process.version,
    platform: process.platform,
    command: [process.execPath, ...args],
    exitCode,
    durationMs: performance.now() - started,
    log,
    ...result,
    ...(errorCode ? { errorCode } : {}),
    scope: {
      temporarySyntheticOnly: true,
      liveMaterialRead: false,
      hardProcessExitTested: true,
      nativeDpapiTested: false,
      hardwareAuthenticatorTested: false,
      physicalDiskFullTested: false,
      productionRegistrationUiTested: false,
    },
  };
  const path = join(root, 'resilience-check.json');
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
  return { ...report, report: path };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert.equal(
      process.argv.length,
      2,
      'Usage: node scripts/security-authentication-resilience-check.mjs',
    );
    const report = await checkAuthenticationResilience();
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    if (!report.ok) {
      process.exitCode = 1;
    }
  } catch {
    process.stderr.write('AUTHENTICATION_RESILIENCE_RUNNER_FAILED\n');
    process.exitCode = 1;
  }
}

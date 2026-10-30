/** Full safety/business acceptance, fresh synthetic workspaces, no configuration arguments. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkFullRegression } from './security-release-regression.mjs';
import { parseRequiredTap } from './security-regression-contract.mjs';
import {
  checkBrowserCandidate,
  snapshotCandidateDirectory,
} from './security-browser-candidate-check.mjs';
import { parseRegistrationIntegrationTap } from './security-registration-integration-check.mjs';
import { parseAuthenticationIntegrationTap } from './security-authentication-integration-check.mjs';
import { parseRecipientTap } from './security-recipient-check.mjs';
import { parseRecipientDeliveryTap } from './security-recipient-delivery-check.mjs';
import { assertAuthenticationResilienceMatrix } from './security-authentication-resilience-check.mjs';
import {
  fullSourceSnapshot,
  assertNoPublicSecrets,
  assertFullCheckReport,
} from './security-full-contract.mjs';
import { sha256 } from './security-install-contract.mjs';
const repository = fileURLToPath(new URL('../', import.meta.url));
export async function checkSecurityFull() {
  assert.equal(process.platform, 'win32', 'FULL_NATIVE_WINDOWS_REQUIRED');
  const root = mkdtempSync(join(tmpdir(), 'ModeDB-Full-Check-')),
    sources = fullSourceSnapshot(repository);
  const save = (name, value) =>
    writeFileSync(join(root, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  save('source-manifest.json', { format: 'modeldb.full-source.v1', sources });
  const sourceSha256 = sha256(readFileSync(join(root, 'source-manifest.json')));
  process.stdout.write(JSON.stringify({ event: 'full-start', root, sourceSha256 }) + '\n');
  const stable = () =>
    assert.deepEqual(fullSourceSnapshot(repository), sources, 'FULL_SOURCE_CHANGED');
  const commands = [],
    native = [];
  const run = async (name, args, env = {}) => {
    const log = join(root, name + '.original.txt'),
      stream = createWriteStream(log, { flags: 'wx' });
    const child = spawn(process.execPath, args, {
      cwd: repository,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, MODELDB_HOME: join(root, 'unused-home'), ...env },
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
    const command = { name, args: [process.execPath, ...args], exitCode, timedOut, log };
    commands.push(command);
    save('command-' + name + '.json', command);
    assert.equal(timedOut, false, 'FULL_TIMEOUT: ' + name);
    assert.equal(exitCode, 0, 'FULL_COMMAND_FAILED: ' + name);
    const bytes = readFileSync(log);
    assertNoPublicSecrets(bytes);
    stable();
    process.stdout.write(JSON.stringify({ event: 'full-group', name, exitCode }) + '\n');
    return { text: bytes.toString('utf8'), command };
  };
  let regression,
    browser,
    resilience,
    errorCode,
    scannedFiles = 0;
  try {
    regression = await checkFullRegression();
    assert.equal(regression.ok, true, 'FULL_REGRESSION_FAILED');
    stable();
    const raw = readFileSync(join(regression.root, 'unit.log'), 'utf8');
    const matrices = [
      ...raw.matchAll(/^# (\{"format":"modeldb\.authentication-resilience-matrix\.v1".*\})\s*$/gm),
    ];
    assert.equal(matrices.length, 1);
    resilience = JSON.parse(matrices[0][1]);
    assertAuthenticationResilienceMatrix(resilience);
    for (const name of [
      'security-registered-recovery.test.ts',
      'pivot-display.test.ts',
      'pivot-presentation.test.ts',
      'data-transfer.test.ts',
      'data-transfer-http.test.ts',
      'security-reset-recovery.test.ts',
      'security-authentication-resilience.test.ts',
    ]) {
      assert.ok(regression.unitFiles.includes(name), 'FULL_REQUIRED_UNIT: ' + name);
    }
    for (const result of regression.results) {
      assertNoPublicSecrets(readFileSync(result.log));
      scannedFiles++;
    }
    browser = await checkBrowserCandidate();
    assert.equal(browser.ok, true, 'FULL_BROWSER_FAILED');
    stable();
    const builds = join(browser.root, 'builds'),
      env = {
        MODELDB_HOSTING_TEST_BUILD: join(builds, 'model-designer'),
        MODELDB_PUBLIC_TEST_BUILDS: builds,
        MODELDB_TEST_APP_ROOT: builds,
        MODELDB_HOSTING_TEST_SCREENSHOTS: join(root, 'screenshots/recipients'),
      };
    const groups = [
      [
        'registration',
        ['security-registration-flow.test.ts', 'security-registration-browser.test.ts'],
        parseRegistrationIntegrationTap,
      ],
      [
        'authentication',
        ['security-authentication-browser.test.ts'],
        parseAuthenticationIntegrationTap,
      ],
      ['recipients', ['security-recipient-keys-browser.test.ts'], parseRecipientTap],
      [
        'asset',
        ['security-asset-browser.test.ts'],
        (tap, code) => ({ unit: parseRequiredTap(tap, code) }),
      ],
      ['delivery', ['security-recipient-delivery-native.test.ts'], parseRecipientDeliveryTap],
    ];
    for (const [name, files, parse] of groups) {
      const { text, command } = await run(
        name,
        [
          join(repository, 'node_modules/tsx/dist/cli.mjs'),
          '--test',
          '--test-reporter=tap',
          '--test-concurrency=1',
          ...files.map((f) => join(repository, 'test/integration', f)),
        ],
        env,
      );
      native.push({
        name,
        exitCode: command.exitCode,
        timedOut: command.timedOut,
        ...parse(text, command.exitCode),
      });
    }
    for (const name of [
      'security-registration-storage-check',
      'security-registration-consumer-check',
    ]) {
      const { text } = await run(name, [join(repository, 'scripts', name + '.mjs')]);
      assert.equal(JSON.parse(text).ok, true);
    }
    for (const file of snapshotCandidateDirectory(builds)) {
      assertNoPublicSecrets(readFileSync(join(builds, file.path)));
      scannedFiles++;
    }
    for (const group of browser.groups) {
      assertNoPublicSecrets(readFileSync(join(browser.root, group.log)));
      scannedFiles++;
    }
    for (const command of commands) {
      assertNoPublicSecrets(readFileSync(command.log));
      scannedFiles++;
    }
    stable();
  } catch (error) {
    errorCode = String(error.message).split('\n')[0];
  }
  const report = {
    format: 'modeldb.security-full-check.v1',
    task: 'DR-P4.4',
    ok: !errorCode,
    node: process.version,
    platform: process.platform,
    root,
    sourceSha256,
    regression,
    browser,
    resilience,
    native,
    commands,
    scannedFiles,
    totalPass:
      (regression?.unit?.pass ?? 0) +
      (browser?.totalNativePass ?? 0) +
      native.reduce((n, g) => n + g.unit.pass, 0),
    checks: {
      sourceUnchanged: !errorCode,
      allUnitFiles: !errorCode,
      sixEngineFlows: !errorCode,
      authenticationRecovery: !errorCode,
      registeredRecovery: !errorCode,
      publicArtifactsScanned: !errorCode,
      strictTypes: !errorCode,
      browserBoundary: !errorCode,
    },
    scope: {
      temporarySyntheticOnly: true,
      liveMaterialRead: false,
      hardwareAuthenticatorTested: false,
      realTwoDeviceTested: false,
      systemTrustInstalled: false,
      performanceTested: false,
      productionMigrationPerformed: false,
      frontendChanged: false,
    },
    ...(errorCode ? { errorCode } : {}),
  };
  if (report.ok) {
    assertFullCheckReport(report);
  }
  save('full-check.json', report);
  return { ...report, report: join(root, 'full-check.json') };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert.equal(process.argv.length, 2, 'Usage: node scripts/security-full-check.mjs');
    const report = await checkSecurityFull();
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    if (!report.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(String(error.message).split('\n')[0] + '\n');
    process.exitCode = 1;
  }
}

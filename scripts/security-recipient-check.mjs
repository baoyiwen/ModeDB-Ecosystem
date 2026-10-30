/** DR-P4.1 isolated native page and offline holder verification. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildHostedDesigner } from './security-hosting-build.mjs';
import { snapshotCandidateDirectory } from './security-browser-candidate-check.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const recipientChecks = [
  'freshDesignerBuild',
  'nativeDpapi',
  'osPairedManagement',
  'explicitMigration',
  'uiPublicImport',
  'uiChallengeDownload',
  'offlineInspect',
  'offlineProof',
  'wrongBindingRejected',
  'noOverwrite',
  'explicitConfirmation',
  'uiAssociation',
  'uiReplacement',
  'uiRetirement',
  'conflictRequiresReload',
  'noWebStorageSecrets',
  'restartHistory',
  'localizedZhEnJa',
  'wideAndNarrow',
  'labelsAndFocus',
];
export function parseRecipientTap(tap, exitCode) {
  assert.equal(exitCode, 0, 'RECIPIENT_PROCESS_FAILED');
  for (const [key, count] of [
    ['tests', 1],
    ['pass', 1],
    ['fail', 0],
    ['cancelled', 0],
    ['skipped', 0],
    ['todo', 0],
  ]) {
    const matches = [...tap.matchAll(new RegExp('^# ' + key + ' (\\d+)\\s*$', 'gm'))];
    assert.equal(matches.length, 1, 'RECIPIENT_SUMMARY_REQUIRED');
    assert.equal(Number(matches[0][1]), count, 'RECIPIENT_COUNT_REQUIRED');
  }
  assert.doesNotMatch(tap, /^not ok |^#.*(?:SKIP|TODO)\b/m);
  const lines = [...tap.matchAll(/^# (\{"format":"modeldb\.recipient-browser\.v1".*\})\s*$/gm)];
  assert.equal(lines.length, 1, 'RECIPIENT_BROWSER_REQUIRED');
  const browser = JSON.parse(lines[0][1]);
  assert.equal(browser.ok, true);
  assert.match(browser.browser, /^Chrome\/\d/);
  assert.equal(browser.screenshots, 18);
  for (const key of ['hardwareAuthenticatorTested', 'systemTrustInstalled', 'liveMaterialRead']) {
    assert.equal(browser[key], false);
  }
  for (const key of recipientChecks) {
    assert.equal(browser.checks[key], true, 'RECIPIENT_CHECK_REQUIRED: ' + key);
  }
  return { unit: { pass: 1, fail: 0, skip: 0, cancelled: 0, todo: 0 }, browser };
}
function sourceSnapshot() {
  const dirs = [
    'packages/shared/src',
    'packages/server/src',
    'packages/sdk/src',
    'apps/model-designer/src',
  ];
  const files = dirs.flatMap((dir) =>
    snapshotCandidateDirectory(join(repository, dir)).map((f) => ({
      ...f,
      path: dir + '/' + f.path,
    })),
  );
  for (const path of [
    'package.json',
    'pnpm-lock.yaml',
    'scripts/security-recipient-check.mjs',
    'scripts/security-recipient-key.ts',
    'scripts/security-hosting-build.mjs',
    'scripts/security-release-apps.mjs',
    'test/integration/security-recipient-keys-browser.test.ts',
    'test/fixtures/security-registration-browser.ts',
    'test/fixtures/security-registration-tls/modeldb-a.crt',
    'test/fixtures/security-registration-tls/modeldb-a.key',
  ]) {
    files.push({ path, sha256: sha(readFileSync(join(repository, path))) });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
export async function checkRecipients() {
  const root = mkdtempSync(join(tmpdir(), 'ModeDB-Recipient-Check-')),
    output = join(root, 'designer-build'),
    screenshots = join(root, 'screenshots'),
    log = join(root, 'native.original.txt'),
    source = sourceSnapshot();
  const build = await buildHostedDesigner(output),
    manifest = { source, artifacts: snapshotCandidateDirectory(output) },
    candidateSha256 = sha(JSON.stringify(manifest));
  writeFileSync(join(root, 'candidate-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const args = [
    join(repository, 'node_modules/tsx/dist/cli.mjs'),
    '--test',
    '--test-reporter=tap',
    join(repository, 'test/integration/security-recipient-keys-browser.test.ts'),
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
  }, 330000);
  const exitCode = await new Promise((done, fail) => {
    child.once('error', fail);
    child.once('close', done);
  }).finally(() => clearTimeout(timer));
  await new Promise((done) => stream.end(done));
  let result, errorCode;
  try {
    assert.equal(timedOut, false, 'RECIPIENT_TIMEOUT');
    assert.deepEqual(sourceSnapshot(), source, 'RECIPIENT_SOURCE_CHANGED');
    assert.deepEqual(
      snapshotCandidateDirectory(output),
      manifest.artifacts,
      'RECIPIENT_BUILD_CHANGED',
    );
    result = parseRecipientTap(readFileSync(log, 'utf8'), exitCode);
  } catch (error) {
    errorCode = String(error.message).split('\n')[0];
  }
  const report = {
    format: 'modeldb.recipient-check.v1',
    task: 'DR-P4.1',
    ok: !errorCode,
    node: process.version,
    platform: process.platform,
    root,
    output,
    screenshots,
    log,
    exitCode,
    command: [process.execPath, ...args],
    candidateSha256,
    ...result,
    ...(errorCode ? { errorCode } : {}),
    build,
    scope: {
      temporarySyntheticOnly: true,
      liveMaterialRead: false,
      hardwareAuthenticatorTested: false,
      systemTrustInstalled: false,
      recipientUiTested: true,
    },
  };
  const path = join(root, 'integration-check.json');
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
  return { ...report, report: path };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert.equal(process.argv.length, 2, 'Usage: node scripts/security-recipient-check.mjs');
    const report = await checkRecipients();
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    if (!report.ok) {
      process.exitCode = 1;
    }
  } catch {
    process.stderr.write('RECIPIENT_CHECK_FAILED\n');
    process.exitCode = 1;
  }
}

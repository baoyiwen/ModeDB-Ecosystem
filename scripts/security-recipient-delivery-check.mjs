/** Repeatable DR-P4.2 native CLI acceptance. No runtime configuration is loaded by this runner. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { snapshotCandidateDirectory } from './security-browser-candidate-check.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
export const deliveryChecks = [
  'nativeDpapi',
  'sourceRemoved',
  'wrongRecipientRejected',
  'staleRevisionRejected',
  'wrongPrivateKeyRejected',
  'tamperRejected',
  'wrongTargetRejected',
  'repeatPublicationRejected',
  'freshDestinationKeys',
  'emptyAccessLedger',
];
export function parseRecipientDeliveryTap(tap, exitCode) {
  assert.equal(exitCode, 0, 'RECIPIENT_DELIVERY_PROCESS_FAILED');
  const unit = {};
  for (const [raw, key] of [
    ['pass', 'pass'],
    ['fail', 'fail'],
    ['cancelled', 'cancelled'],
    ['skipped', 'skip'],
    ['todo', 'todo'],
  ]) {
    const matches = [...tap.matchAll(new RegExp('^# ' + raw + ' (\\d+)\\s*$', 'gm'))];
    assert.equal(matches.length, 1, 'RECIPIENT_DELIVERY_SUMMARY_REQUIRED');
    unit[key] = Number(matches[0][1]);
  }
  assert.equal(unit.pass, 1);
  for (const key of ['fail', 'cancelled', 'skip', 'todo']) {
    assert.equal(unit[key], 0);
  }
  assert.doesNotMatch(tap, /^not ok |^#.*(?:SKIP|TODO)\b/m);
  const records = [
    ...tap.matchAll(/^# (\{"format":"modeldb\.recipient-delivery-native\.v1".*\})\s*$/gm),
  ];
  assert.equal(records.length, 1, 'RECIPIENT_DELIVERY_NATIVE_REQUIRED');
  const native = JSON.parse(records[0][1]);
  assert.equal(native.ok, true);
  assert.deepEqual(native.formats, ['modeldb.backup.v2', 'modeldb.asset.v1', 'modeldb.asset.v2']);
  for (const key of deliveryChecks) {
    assert.equal(native[key], true, 'RECIPIENT_DELIVERY_CHECK_REQUIRED: ' + key);
  }
  assert.equal(native.realTwoDeviceTested, false);
  assert.equal(native.liveMaterialRead, false);
  return { unit, native };
}
function sourceSnapshot() {
  const dirs = [
    'packages/server/src',
    'packages/shared/src',
    'packages/common/src',
    'packages/core/src',
    'packages/core/authoring',
    'packages/core/facade',
  ];
  const files = dirs.flatMap((dir) =>
    snapshotCandidateDirectory(join(repository, dir))
      .filter((f) => /\.(ts|json)$/.test(f.path) && !f.path.endsWith('.d.ts'))
      .map((f) => ({ ...f, path: dir + '/' + f.path })),
  );
  for (const path of [
    'package.json',
    'pnpm-lock.yaml',
    'tsconfig.json',
    'packages/core/index.ts',
    'scripts/security-recipient-delivery-check.mjs',
    'test/integration/security-recipient-delivery-native.test.ts',
    'test/fixtures/security-recipient-delivery.ts',
    'test/fixtures/security-registration-integration.ts',
    'test/fixtures/security-designer-asset.ts',
  ]) {
    files.push({
      path,
      sha256: createHash('sha256')
        .update(readFileSync(join(repository, path)))
        .digest('hex'),
    });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
export async function checkRecipientDelivery() {
  const root = mkdtempSync(join(tmpdir(), 'ModeDB-Recipient-Delivery-Check-')),
    log = join(root, 'native.original.txt'),
    source = sourceSnapshot();
  const manifest = { source },
    candidateSha256 = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  writeFileSync(join(root, 'source-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const args = [
    join(repository, 'node_modules/tsx/dist/cli.mjs'),
    '--test',
    '--test-reporter=tap',
    join(repository, 'test/integration/security-recipient-delivery-native.test.ts'),
  ];
  const stream = createWriteStream(log, { flags: 'wx' }),
    child = spawn(process.execPath, args, {
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
  }, 600000);
  const exitCode = await new Promise((done, fail) => {
    child.once('error', fail);
    child.once('close', done);
  }).finally(() => clearTimeout(timer));
  await new Promise((done) => stream.end(done));
  let result, errorCode;
  try {
    assert.equal(timedOut, false, 'RECIPIENT_DELIVERY_TIMEOUT');
    assert.deepEqual(sourceSnapshot(), source, 'RECIPIENT_DELIVERY_SOURCE_CHANGED');
    result = parseRecipientDeliveryTap(readFileSync(log, 'utf8'), exitCode);
  } catch (error) {
    errorCode = String(error.message).split('\n')[0];
  }
  const report = {
    format: 'modeldb.recipient-delivery-check.v1',
    task: 'DR-P4.2',
    ok: !errorCode,
    node: process.version,
    platform: process.platform,
    root,
    log,
    exitCode,
    timedOut,
    command: [process.execPath, ...args],
    candidateSha256,
    ...result,
    ...(errorCode ? { errorCode } : {}),
    scope: {
      temporarySyntheticOnly: true,
      liveMaterialRead: false,
      realTwoDeviceTested: false,
      frontendChanged: false,
      packageFormatsChanged: false,
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
      'Usage: node scripts/security-recipient-delivery-check.mjs',
    );
    const report = await checkRecipientDelivery();
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    if (!report.ok) {
      process.exitCode = 1;
    }
  } catch {
    process.stderr.write('RECIPIENT_DELIVERY_CHECK_FAILED\n');
    process.exitCode = 1;
  }
}

/** Capture D34 preparation checks, without claiming actual-device acceptance. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { digest, sourceFingerprint } from '../../../../scripts/security-device-drill-contract.mjs';
import { fullSourceSnapshot } from '../../../../scripts/security-full-contract.mjs';
import { assertDeviceSmoke } from '../../../../scripts/security-device-drill-evidence.mjs';
const base = 'docs/security-v1-deliveries/evidence/SEC-M7-D34/';
const save = (path, value) => writeFileSync(base + path, JSON.stringify(value, null, 2) + '\n');
const files = fullSourceSnapshot(process.cwd()).map(({ path }) => ({ path, sha256: digest(readFileSync(path, 'utf8').replace(/\r\n/g, '\n')) }));
const source = sourceFingerprint();
assert.equal(source, digest(JSON.stringify(files)));
save('source-manifest.json', { files });
const commands = {};
for (const [name, args, timeout] of [
  ['unit', ['--test', '--test-reporter=tap', 'test/unit/security-device-drill.test.mjs', 'test/unit/security-release-evidence.test.mjs'], 120000],
  ['smoke', ['scripts/security-device-drill.mjs', 'smoke'], 240000],
  ['static', [base + 'static-checks.mjs'], 180000],
]) {
  const start = new Date().toISOString();
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 });
  writeFileSync(base + name + '.original.txt', (result.stdout ?? '') + (result.stderr ?? ''));
  commands[name] = { executable: process.execPath, nodeVersion: process.version, args, exitCode: result.status, timedOut: result.error?.code === 'ETIMEDOUT', log: name + '.original.txt', startedAtUtc: start, endedAtUtc: new Date().toISOString() };
  save('commands.json', commands);
  assert.equal(result.status, 0, name + ' failed; original output preserved');
  if (name === 'smoke') {
    const root = result.stdout.match(/^DrillRoot: (.+)$/m)?.[1].trim();
    assert.ok(root && root.includes('ModeDB-Device-Drill-'));
    const report = JSON.parse(readFileSync(join(root, 'smoke-report.json'), 'utf8'));
    assertDeviceSmoke(report);
    assert.equal(report.sourceSha256, source);
    copyFileSync(join(root, 'smoke-report.json'), base + 'smoke-report.json');
  }
  process.stdout.write(name + ': passed\n');
}
assert.equal(sourceFingerprint(), source, 'DEVICE_SOURCE_CHANGED_DURING_CHECKS');
process.stdout.write('PREPARATION_PASSED_ACTUAL_DEVICES_PENDING\n');

/** Scoped tooling checks; public synthetic fixture only, no live configuration. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const scripts = ['scripts/security-device-drill.mjs', 'scripts/security-device-drill-contract.mjs', 'scripts/security-device-drill-browser.mjs', 'scripts/security-device-drill-runner.mjs', 'scripts/security-device-drill-evidence.mjs', 'scripts/security-release-evidence.mjs'];
function run(executable, args) {
  const result = spawnSync(executable, args, { encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  process.stdout.write(JSON.stringify({ executable, args, exitCode: result.status }) + '\n');
  process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
  assert.equal(result.status, 0);
}
for (const path of scripts) run(process.execPath, ['--check', path]);
run(process.execPath, ['node_modules/eslint/bin/eslint.js', ...scripts]);
run(process.execPath, ['node_modules/prettier/bin/prettier.cjs', '--check', ...scripts, 'docs/security-v1/windows-device-drill-guide.md']);
run(process.execPath, ['scripts/assert-no-security-material.mjs']);
run(process.execPath, ['scripts/assert-no-build-artifacts-in-src.mjs']);
run(process.execPath, ['scripts/assert-sdk-client-only.mjs']);
run('git', ['diff', '--check']);
const root = mkdtempSync(join(tmpdir(), 'ModeDB-Device-Drill-'));
mkdirSync(join(root, '中文路径'));
const runId = randomUUID(), rpId = `drill-${runId}.example.test`, ticket = join(root, '中文路径/connection.json');
writeFileSync(ticket, JSON.stringify({ format: 'modeldb.windows-device-drill.v1', runId, serverAddress: '192.168.1.10', clientAddress: '192.168.1.11', port: 49177, rpId, origin: `https://${rpId}:49177`, spkiSha256: 'a'.repeat(64), sourceSha256: 'b'.repeat(64), expiresAtUtc: new Date(Date.now() + 3600000).toISOString() }));
const wrapper = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/security-device-drill.ps1', '-Action', 'Client', '-Ticket', ticket, '-Pin', 'c'.repeat(64)], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
writeFileSync('docs/security-v1-deliveries/evidence/SEC-M7-D34/powershell-unicode.original.txt', (wrapper.stdout ?? '') + (wrapper.stderr ?? ''));
assert.equal(wrapper.status, 1);
assert.ok(wrapper.stdout.includes('DEVICE_PIN_MISMATCH_OBTAIN_FROM_A_SEPARATELY'), 'POWERSHELL_UNICODE_ARGUMENTS_FAILED');
process.stdout.write('POWERSHELL_UNICODE_PATH_AND_PIN_REJECTION_PASSED\n');

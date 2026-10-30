/** Revalidate tooling after style-only brace fixes, preserving prior successful raw output. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
const base = 'docs/security-v1-deliveries/evidence/SEC-M7-D28/', commands = [];
for (const [name, files] of [
  ['tools', ['test/unit/security-release-evidence.test.mjs', 'test/unit/security-authentication-report.test.mjs', 'test/unit/security-authentication-resilience-report.test.mjs']],
  ['candidate-report', ['test/unit/security-browser-candidate-report.test.mjs']],
]) {
  const args = ['node_modules/tsx/dist/cli.mjs', '--test', '--test-reporter=tap', ...files];
  const previous = name + '-before-style-' + Date.now() + '.original.txt'; writeFileSync(base + previous, readFileSync(base + name + '.original.txt'), { flag: 'wx' });
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  const log = name + '-after-style-' + Date.now() + '.original.txt'; writeFileSync(base + log, (result.stdout ?? '') + (result.stderr ?? ''), { flag: 'wx' });
  commands.push({ command: [process.execPath, ...args], exitCode: result.status, log, previous });
  assert.equal(result.status, 0); copyFileSync(base + log, base + name + '.original.txt');
}
writeFileSync(base + 'tools-followup-commands.json', JSON.stringify(commands, null, 2) + '\n'); console.log(JSON.stringify({ ok: true, groups: commands.length }));

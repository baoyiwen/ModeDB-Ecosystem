/** Fixed development checks; no user instance or configuration accepted. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream, readFileSync, writeFileSync } from 'node:fs';
const base = 'docs/security-v1-deliveries/evidence/SEC-M7-D30/';
const previous = JSON.parse(
  readFileSync('docs/security-v1-deliveries/evidence/SEC-M7-D29/unit.command.json', 'utf8'),
);
const modes = {
  unit: [
    'node_modules/tsx/dist/cli.mjs',
    '--test',
    '--test-concurrency=1',
    '--test-timeout=120000',
    '--test-reporter=tap',
    ...previous.command.filter((p) => p.startsWith('test/')),
    'test/unit/security-recipient-delivery.test.ts',
    'test/unit/security-recipient-delivery-report.test.mjs',
    'test/unit/security-backup.test.ts',
    'test/unit/security-asset.test.ts',
    'test/unit/security-designer-asset.test.ts',
  ],
  'receipt-tools': [
    'node_modules/tsx/dist/cli.mjs',
    '--test',
    '--test-reporter=tap',
    'test/unit/security-release-evidence.test.mjs',
    'test/unit/security-browser-candidate-report.test.mjs',
    'test/unit/security-recipient-evidence.test.mjs',
    'test/unit/security-recipient-delivery-evidence.test.mjs',
  ],
  types: ['scripts/security-registration-storage-check.mjs'],
  consumer: ['scripts/security-registration-consumer-check.mjs'],
};
const mode = process.argv[2];
assert.ok(process.argv.length === 3 && Object.hasOwn(modes, mode));
const stream = createWriteStream(base + mode + '.original.txt', { flags: 'wx' });
const args = modes[mode],
  child = spawn(process.execPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.pipe(stream, { end: false });
child.stderr.pipe(stream, { end: false });
let timedOut = false;
const timer = setTimeout(
  () => {
    timedOut = true;
    child.kill();
  },
  mode === 'unit' ? 1200000 : 300000,
);
const exitCode = await new Promise((done, fail) => {
  child.once('error', fail);
  child.once('close', done);
}).finally(() => clearTimeout(timer));
await new Promise((done) => stream.end(done));
const result = { command: [process.execPath, ...args], node: process.version, exitCode, timedOut };
writeFileSync(base + mode + '.command.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ mode, ...result }));
if (exitCode !== 0 || timedOut) process.exitCode = 1;

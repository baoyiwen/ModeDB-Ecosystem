/** Fixed development checks; accepts no configuration or instance input. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream, writeFileSync } from 'node:fs';
const base = 'docs/security-v1-deliveries/evidence/SEC-M7-D31/';
const modes = {
  unit: [
    'node_modules/tsx/dist/cli.mjs',
    '--test',
    '--test-concurrency=1',
    '--test-timeout=120000',
    '--test-reporter=tap',
    ...[
      'security-registry',
      'security-registration-storage',
      'security-registration-runtime',
      'security-session-parent',
      'security-authentication',
      'security-authentication-storage',
      'security-identity-admin',
      'security-recipient-keys',
      'security-recipient-delivery',
      'security-protection',
      'security-hosting',
    ].map((n) => 'test/unit/' + n + '.test.ts'),
  ],
  'receipt-tools': [
    'node_modules/tsx/dist/cli.mjs',
    '--test',
    '--test-reporter=tap',
    ...[
      'security-release-evidence',
      'security-browser-candidate-report',
      'security-recipient-evidence',
      'security-recipient-delivery-evidence',
      'security-install-contract',
      'security-install-evidence',
      'security-release-apps',
    ].map((n) => 'test/unit/' + n + '.test.mjs'),
  ],
};
const mode = process.argv[2];
assert.ok(process.argv.length === 3 && Object.hasOwn(modes, mode));
const args = modes[mode],
  stream = createWriteStream(base + mode + '.original.txt', { flags: 'wx' });
const child = spawn(process.execPath, args, {
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.pipe(stream, { end: false });
child.stderr.pipe(stream, { end: false });
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  child.kill();
}, 1200000);
const exitCode = await new Promise((done, fail) => {
  child.once('error', fail);
  child.once('close', done);
}).finally(() => clearTimeout(timer));
await new Promise((done) => stream.end(done));
const result = { command: [process.execPath, ...args], node: process.version, exitCode, timedOut };
writeFileSync(base + mode + '.command.json', JSON.stringify(result, null, 2) + '\n');
process.stdout.write(JSON.stringify({ mode, ...result }) + '\n');
if (exitCode !== 0 || timedOut) process.exitCode = 1;

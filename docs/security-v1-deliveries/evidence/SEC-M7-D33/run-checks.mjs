/** Scoped verification; uses fresh declarations and temporary native/browser fixtures. */
import { spawn } from 'node:child_process';
import { createWriteStream, writeFileSync } from 'node:fs';
const base = 'docs/security-v1-deliveries/evidence/SEC-M7-D33/';
const code = [
  'scripts/security-performance-check.mjs',
  'scripts/security-performance-contract.mjs',
  'scripts/security-performance-evidence.mjs',
  'scripts/security-release-evidence.mjs',
  'scripts/security-registration-storage-check.mjs',
  'packages/server/src/security/public-rejection-audit.ts',
  'packages/server/src/security/registration-service.ts',
  'packages/server/src/security/authentication-service.ts',
  'packages/server/src/security/registration-routes.ts',
  'packages/server/src/security/authentication-routes.ts',
];
const tests = [
  'security-public-rejection-audit',
  'security-performance-contract',
  'security-performance-evidence',
  'security-release-evidence',
].map(
  (n) => 'test/unit/' + n + '.test.' + (n === 'security-public-rejection-audit' ? 'ts' : 'mjs'),
);
const affected = [
  'security-registration-runtime',
  'security-registration-integration-report',
  'security-authentication',
  'security-authentication-resilience',
  'security-dynamic-authorization',
  'security-registry-http',
  'security-protection',
  'security-network',
].map((n) => 'test/unit/' + n + '.test.ts');
affected[1] = 'test/unit/security-registration-integration-report.test.mjs';
const commands = [
  ['tools', ['node_modules/tsx/dist/cli.mjs', '--test', '--test-reporter=tap', ...tests]],
  [
    'affected',
    [
      'node_modules/tsx/dist/cli.mjs',
      '--test',
      '--test-reporter=tap',
      '--test-concurrency=1',
      ...affected,
    ],
  ],
  [
    'browser',
    [
      'node_modules/tsx/dist/cli.mjs',
      '--test',
      '--test-reporter=tap',
      'test/integration/security-authentication-browser.test.ts',
    ],
  ],
  ['types', ['scripts/security-registration-storage-check.mjs']],
  ['lint', ['node_modules/eslint/bin/eslint.js', ...code]],
  ['format', ['node_modules/prettier/bin/prettier.cjs', '--check', ...code, 'package.json']],
  ['material-guard', ['scripts/assert-no-security-material.mjs']],
  ['source-guard', ['scripts/assert-no-build-artifacts-in-src.mjs']],
];
const results = [];
for (const [name, args] of commands) {
  const log = name + '.original.txt',
    stream = createWriteStream(base + log, { flags: 'wx' });
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
  }, 600000);
  const exitCode = await new Promise((done, fail) => {
    child.once('error', fail);
    child.once('close', done);
  }).finally(() => clearTimeout(timer));
  await new Promise((done) => stream.end(done));
  results.push({ name, command: [process.execPath, ...args], exitCode, timedOut, log });
  writeFileSync(base + 'checks.json', JSON.stringify(results, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ name, exitCode, timedOut }) + '\n');
  if (exitCode !== 0 || timedOut) {
    process.exitCode = 1;
    break;
  }
}

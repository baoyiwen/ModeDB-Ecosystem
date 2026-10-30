/** Final tool negatives and source formatting after measurement-driver review. */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const base = 'docs/security-v1-deliveries/evidence/SEC-M7-D33/',
  checks = JSON.parse(readFileSync(base + 'checks.json'));
const commands = [
  [
    'tools-final',
    [
      'node_modules/tsx/dist/cli.mjs',
      '--test',
      '--test-reporter=tap',
      'test/unit/security-public-rejection-audit.test.ts',
      'test/unit/security-performance-contract.test.mjs',
      'test/unit/security-performance-evidence.test.mjs',
      'test/unit/security-release-evidence.test.mjs',
    ],
  ],
  [
    'final-lint',
    [
      'node_modules/eslint/bin/eslint.js',
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
    ],
  ],
];
for (const [name, args] of commands) {
  const result = spawnSync(process.execPath, args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120000,
    }),
    log = name + '.original.txt';
  writeFileSync(
    base + log,
    (result.stdout ?? '') + (result.stderr ?? '') + (result.error ? String(result.error) : ''),
    { flag: 'wx' },
  );
  checks.push({
    name,
    command: [process.execPath, ...args],
    exitCode: result.status,
    timedOut: result.error?.code === 'ETIMEDOUT',
    log,
  });
  writeFileSync(base + 'checks.json', JSON.stringify(checks, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ name, exitCode: result.status }) + '\n');
  if (result.status !== 0) {
    process.exitCode = 1;
    break;
  }
}

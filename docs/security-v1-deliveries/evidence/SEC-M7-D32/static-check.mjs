/** Limited development checks, no instance or local configuration reads. */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const base = 'docs/security-v1-deliveries/evidence/SEC-M7-D32/';
const code = [
  'security-full-check',
  'security-full-contract',
  'security-full-evidence',
  'security-regression-contract',
  'security-release-regression',
  'security-release-evidence',
  'security-authentication-resilience-check',
  'security-registration-storage-check',
].map((n) => 'scripts/' + n + '.mjs');
const documents = [
  'docs/security-v1/release-guide.md',
  'docs/security-v1/overview.md',
  'docs/security-v1/user-guide.md',
  'docs/security-v1/AGENTS.md',
  'docs/security-v1-plan.md',
  'docs/security-v1-milestones.md',
  'docs/security-v1-deliveries/SEC-M7.md',
  'test/README.md',
  'package.json',
];
const evidence = [
  'static-check.mjs',
  'document-check.mjs',
  'finalize-receipt.mjs',
  'archive-full.mjs',
  'finish-documents.mjs',
].map((n) => base + n);
const tests = [
  'test/unit/security-full-contract.test.mjs',
  'test/unit/security-full-evidence.test.mjs',
  'test/unit/security-regression-contract.test.mjs',
  'test/unit/security-registered-recovery.test.ts',
  'test/fixtures/security-full-report.mjs',
];
const commands = [
  ['lint', process.execPath, ['node_modules/eslint/bin/eslint.js', ...code]],
  [
    'format',
    process.execPath,
    ['node_modules/prettier/bin/prettier.cjs', '--check', ...code, ...documents, ...evidence],
  ],
  ['diff', 'git', ['diff', '--check', '--', ...code, ...documents, ...evidence, ...tests]],
  ['material-guard', process.execPath, ['scripts/assert-no-security-material.mjs']],
  ['source-artifacts', process.execPath, ['scripts/assert-no-build-artifacts-in-src.mjs']],
  ['sdk-client-boundary', process.execPath, ['scripts/assert-sdk-client-only.mjs']],
];
const results = [];
for (const [name, executable, args] of commands) {
  const result = spawnSync(executable, args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 180000,
    }),
    log = name + '.original.txt';
  writeFileSync(
    base + log,
    (result.stdout ?? '') + (result.stderr ?? '') + (result.error ? String(result.error) : ''),
  );
  results.push({ command: [executable, ...args], exitCode: result.status, log });
  process.stdout.write(JSON.stringify({ name, exitCode: result.status, log }) + '\n');
}
writeFileSync(base + 'static-commands.json', JSON.stringify(results, null, 2) + '\n');
if (results.some((r) => r.exitCode !== 0)) process.exitCode = 1;

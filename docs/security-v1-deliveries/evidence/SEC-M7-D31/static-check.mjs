/** Current development files only; no config or runtime directory. */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const base = 'docs/security-v1-deliveries/evidence/SEC-M7-D31/';
const code = [
  'minify-module',
  'obfuscate-dist',
  'security-release-candidate',
  'security-install-check',
  'security-install-contract',
  'security-installed-upgrade',
  'security-install-evidence',
  'security-release-evidence',
].map((n) => 'scripts/' + n + '.mjs');
const documents = [
  'docs/security-v1/device-registration-protocol-contract.md',
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
  'run-check.mjs',
].map((n) => base + n);
const tests = [
  'test/unit/security-install-contract.test.mjs',
  'test/unit/security-install-evidence.test.mjs',
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

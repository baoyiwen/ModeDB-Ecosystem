/** Only the changed development files. No config or runtime directory is opened. */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const base = 'docs/security-v1-deliveries/evidence/SEC-M7-D30/';
const code = [
  'packages/shared/src/security-contracts.ts',
  'packages/server/src/security/recipient-delivery.ts',
  'packages/server/src/security/security-registry.ts',
  'packages/server/src/cli-recipient-delivery.ts',
  'packages/server/src/cli-recipient-list.ts',
  'packages/server/src/cli-backup-security.ts',
  'packages/server/src/cli-asset.ts',
  'packages/server/src/cli-security.ts',
  'scripts/security-recipient-delivery-check.mjs',
  'scripts/security-recipient-delivery-evidence.mjs',
  'scripts/security-release-evidence.mjs',
  'scripts/security-registration-storage-check.mjs',
];
const documents = [
  'docs/security-v1/recipient-key-contract.md',
  'docs/security-v1/device-registration-proposal.md',
  'docs/security-v1/device-registration-protocol-contract.md',
  'docs/security-v1/device-registration-runtime-guide.md',
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
].map((name) => base + name);
const tests = [
  'test/fixtures/security-recipient-delivery.ts',
  'test/unit/security-recipient-delivery.test.ts',
  'test/unit/security-recipient-delivery-report.test.mjs',
  'test/unit/security-recipient-delivery-evidence.test.mjs',
  'test/integration/security-recipient-delivery-native.test.ts',
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
  });
  const log = name + '.original.txt';
  writeFileSync(
    base + log,
    (result.stdout ?? '') + (result.stderr ?? '') + (result.error ? String(result.error) : ''),
  );
  results.push({ command: [executable, ...args], exitCode: result.status, log });
  console.log(JSON.stringify({ name, exitCode: result.status, log }));
}
writeFileSync(base + 'static-commands.json', JSON.stringify(results, null, 2) + '\n');
if (results.some((r) => r.exitCode !== 0)) process.exitCode = 1;

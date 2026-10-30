/** Restricted development checks. Does not load configuration or runtime material. */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const base = 'docs/security-v1-deliveries/evidence/SEC-M7-D29/';
const code = [
  'packages/shared/src/recipient-keys.ts',
  'packages/shared/src/index.ts',
  'packages/server/src/security/recipient-keys.ts',
  'packages/server/src/security/security-registry.ts',
  'packages/sdk/src/security-center.ts',
  'packages/sdk/src/index.ts',
  'scripts/security-recipient-key.ts',
  'scripts/security-recipient-check.mjs',
  'scripts/security-recipient-evidence.mjs',
  'scripts/security-release-evidence.mjs',
  'scripts/security-registration-consumer-check.mjs',
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
  'docs/security-v1-identity-contract.md',
  'docs/security-v1-plan.md',
  'docs/security-v1-milestones.md',
  'docs/security-v1-deliveries/SEC-M7.md',
  'apps/model-designer/AGENTS.md',
  'test/README.md',
  'package.json',
];
const evidenceScripts = ['static-check.mjs', 'document-check.mjs', 'finalize-receipt.mjs'].map(
  (name) => base + name,
);
const changed = [
  ...code,
  ...documents,
  ...evidenceScripts,
  'apps/model-designer/src/components/RecipientKeysPanel.tsx',
  'apps/model-designer/src/components/recipient-keys.css',
  'apps/model-designer/src/components/SecurityCenterWorkspace.tsx',
  ...['zh', 'en', 'ja'].map(
    (locale) => 'apps/model-designer/src/i18n/locales/' + locale + '/ui.json',
  ),
  'test/unit/security-hosting.test.ts',
  'test/unit/security-recipient-keys.test.ts',
  'test/unit/security-recipient-report.test.mjs',
  'test/unit/security-recipient-evidence.test.mjs',
  'test/integration/security-recipient-keys-browser.test.ts',
];
const commands = [
  ['lint', process.execPath, ['node_modules/eslint/bin/eslint.js', ...code]],
  [
    'format',
    process.execPath,
    [
      'node_modules/prettier/bin/prettier.cjs',
      '--check',
      ...code,
      ...documents,
      ...evidenceScripts,
    ],
  ],
  ['diff', 'git', ['diff', '--check', '--', ...changed]],
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

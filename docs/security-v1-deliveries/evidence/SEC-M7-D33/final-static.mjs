/** Record final scoped documentation/format/diff checks without changing frozen sources. */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const base = 'docs/security-v1-deliveries/evidence/SEC-M7-D33/';
const helpers = readdirSync(base)
  .filter((p) => p.endsWith('.mjs'))
  .map((p) => base + p);
const docs = [
  'docs/security-v1/performance-guide.md',
  'docs/security-v1/overview.md',
  'docs/security-v1/user-guide.md',
  'docs/security-v1/release-guide.md',
  'docs/security-v1/device-registration-runtime-guide.md',
  'docs/security-v1/device-registration-deployment-contract.md',
  'docs/security-v1-plan.md',
  'docs/security-v1/AGENTS.md',
  'docs/security-v1-milestones.md',
  'docs/security-v1-deliveries/SEC-M7.md',
  'test/README.md',
  base + 'README.md',
];
const checks = JSON.parse(readFileSync(base + 'checks.json'));
const code = [
  ...new Set(
    checks
      .filter((c) => ['lint', 'format'].includes(c.name))
      .flatMap((c) => c.command.slice(c.name === 'format' ? 4 : 3)),
  ),
];
const commands = [
  ['documents', process.execPath, [base + 'document-check.mjs']],
  [
    'document-format',
    process.execPath,
    ['node_modules/prettier/bin/prettier.cjs', '--check', ...docs, ...helpers],
  ],
  ...helpers.map((path, i) => ['helper-syntax-' + i, process.execPath, ['--check', path]]),
  [
    'scoped-diff',
    'git',
    ['diff', '--check', '--', ...docs, ...code, 'test/unit/security-registration-runtime.test.ts'],
  ],
];
for (const [name, executable, args] of commands) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000,
  });
  const log = name + '.original.txt';
  writeFileSync(
    base + log,
    (result.stdout ?? '') + (result.stderr ?? '') + (result.error ? String(result.error) : ''),
    { flag: 'wx' },
  );
  checks.push({
    name,
    command: [executable, ...args],
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

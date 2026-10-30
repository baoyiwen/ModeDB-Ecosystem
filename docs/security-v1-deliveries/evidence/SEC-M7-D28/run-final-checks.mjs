/** Scoped static/types, retaining each attempt; writes evidence only. No live material. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, copyFileSync } from 'node:fs';
const base = 'docs/security-v1-deliveries/evidence/SEC-M7-D28/';
const sources = ['scripts/security-browser-candidate-check.mjs', 'scripts/security-browser-candidate-evidence.mjs', 'scripts/security-release-evidence.mjs', 'scripts/security-registration-storage-check.mjs'];
const docs = ['docs/security-v1/device-registration-protocol-contract.md', 'docs/security-v1/device-registration-runtime-guide.md', 'docs/security-v1/overview.md', 'docs/security-v1/user-guide.md', 'docs/security-v1-plan.md', 'docs/security-v1/AGENTS.md', 'docs/security-v1-milestones.md', 'docs/security-v1-deliveries/SEC-M7.md', 'test/README.md'];
const commands = [];
function run(args, name, command = process.execPath) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  const log = name + '-' + Date.now() + '.original.txt'; writeFileSync(base + log, (result.stdout ?? '') + (result.stderr ?? ''), { flag: 'wx' });
  commands.push({ command: [command, ...args], exitCode: result.status, log });
  console.log(JSON.stringify({ name, exitCode: result.status, log })); assert.equal(result.status, 0, result.error?.message ?? 'Failed: ' + name);
  return log;
}
if (process.argv[2] === 'types') {
  copyFileSync(base + run(['scripts/security-registration-storage-check.mjs'], 'types'), base + 'types.original.txt');
  writeFileSync(base + 'types.command.json', JSON.stringify(commands, null, 2) + '\n');
} else if (process.argv[2] === 'consumer') {
  copyFileSync(base + run(['scripts/security-registration-consumer-check.mjs'], 'consumer'), base + 'consumer-native.original.txt');
  writeFileSync(base + 'consumer.command.json', JSON.stringify(commands, null, 2) + '\n');
} else if (process.argv[2] === 'format') {
  run(['node_modules/prettier/bin/prettier.cjs', '--write', ...docs], 'format-write');
} else {
  assert.equal(process.argv.length, 2);
  run(['node_modules/eslint/bin/eslint.js', ...sources], 'lint');
  run(['node_modules/prettier/bin/prettier.cjs', '--check', ...sources, ...docs, 'package.json'], 'format');
  run(['diff', '--check', '--', ...sources, ...docs, 'package.json', 'test/integration/security-hostile-browser.test.ts', 'test/integration/security-designer-identity-browser.test.ts', 'test/integration/security-public-clients-browser.test.ts', 'test/fixtures/security-browser-save.ts', 'test/unit/security-browser-candidate-report.test.mjs', 'test/unit/security-release-evidence.test.mjs'], 'diff', 'git');
  run(['scripts/assert-no-security-material.mjs'], 'material-guard');
  writeFileSync(base + 'static-commands.json', JSON.stringify(commands, null, 2) + '\n');
}

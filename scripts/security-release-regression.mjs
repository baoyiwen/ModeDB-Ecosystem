/** Repeat the full regression using only fresh, synthetic temporary workspaces. */
import { spawn } from 'node:child_process';
import {
  createWriteStream,
  mkdtempSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const runner = join(repository, 'node_modules/tsx/dist/cli.mjs');
const root = mkdtempSync(join(tmpdir(), 'ModeDB-Regression-'));
// Fault fixtures launch `node --import tsx` from cwd. Give those children the
// existing dependency runtime without copying or changing the repository.
symlinkSync(
  realpathSync(join(repository, 'node_modules')),
  join(root, 'node_modules'),
  process.platform === 'win32' ? 'junction' : 'dir',
);
const units = readdirSync(join(repository, 'test/unit'))
  .filter((name) => /\.test\.tsx?$/.test(name))
  .sort();
const integrations = [
  'e2e-engine-workflow',
  'relate-conserved-forest',
  'children-tree-query',
  'group-lateral-attach',
  'multi-branch-network',
  'protocol-operations',
];
const results = [];
process.stdout.write(`RegressionRoot: ${root}\n`);
async function run(name, args, cwd = root) {
  const log = join(root, name + '.log');
  const stream = createWriteStream(log, { flags: 'wx' });
  const start = performance.now();
  const child = spawn(process.execPath, [runner, ...args], {
    cwd,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      MODELDB_HOME: join(root, 'unused-home'),
      TSX_TSCONFIG_PATH: join(repository, 'tsconfig.json'),
    },
  });
  child.stdout.pipe(stream, { end: false });
  child.stderr.pipe(stream, { end: false });
  const code = await new Promise((done, fail) => {
    child.once('error', fail);
    child.once('close', done);
  });
  await new Promise((done) => stream.end(done));
  results.push({ name, exitCode: code, durationMs: performance.now() - start, log });
  process.stdout.write(`${name}: ${code === 0 ? 'PASS' : 'FAIL'}\n`);
}
// Unit fault fixtures intentionally resolve child code relative to the repository;
// their instance directories are already mkdtemp fixtures. Engine scripts use cwd
// for their writable `data/`, so only those must run from the new temporary root.
await run(
  'unit',
  ['--test', '--test-concurrency=3', ...units.map((name) => join(repository, 'test/unit', name))],
  repository,
);
for (const name of integrations) {
  await run(name, [join(repository, 'test/integration', name + '.ts')]);
}
const report = join(root, 'regression.json');
writeFileSync(
  report,
  JSON.stringify(
    {
      format: 'modeldb.security-regression.v1',
      timestampUtc: new Date().toISOString(),
      unitFiles: units,
      integrationScripts: integrations,
      results,
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
);
process.stdout.write(`Report: ${report}\n`);
process.exitCode = results.every((result) => result.exitCode === 0) ? 0 : 1;

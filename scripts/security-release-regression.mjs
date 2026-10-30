/** Repeat the full regression using only fresh, synthetic temporary workspaces. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  createWriteStream,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  engineIntegrations,
  parseRequiredTap,
  assertRegressionReport,
} from './security-regression-contract.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const runner = join(repository, 'node_modules/tsx/dist/cli.mjs');
export async function checkFullRegression() {
  const root = mkdtempSync(join(tmpdir(), 'ModeDB-Regression-'));
  // Fault fixtures launch `node --import tsx` from cwd. Give those children the
  // existing dependency runtime without copying or changing the repository.
  symlinkSync(
    realpathSync(join(repository, 'node_modules')),
    join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const units = readdirSync(join(repository, 'test/unit'))
    .filter((name) => /\.test\.(?:tsx?|mjs)$/.test(name))
    .sort();
  const integrations = engineIntegrations;
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
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        child.kill();
      },
      name === 'unit' ? 1800000 : 180000,
    );
    const code = await new Promise((done, fail) => {
      child.once('error', fail);
      child.once('close', done);
    }).finally(() => clearTimeout(timer));
    await new Promise((done) => stream.end(done));
    results.push({ name, exitCode: code, timedOut, durationMs: performance.now() - start, log });
    process.stdout.write(`${name}: ${code === 0 ? 'PASS' : 'FAIL'}\n`);
  }
  // Unit fault fixtures intentionally resolve child code relative to the repository;
  // their instance directories are already mkdtemp fixtures. Engine scripts use cwd
  // for their writable `data/`, so only those must run from the new temporary root.
  await run(
    'unit',
    [
      '--test',
      '--test-reporter=tap',
      '--test-concurrency=3',
      '--test-timeout=120000',
      ...units.map((name) => join(repository, 'test/unit', name)),
    ],
    repository,
  );
  for (const name of integrations) {
    await run(name, [join(repository, 'test/integration', name + '.ts')]);
  }
  const report = join(root, 'regression.json');
  const unitLog = readFileSync(join(root, 'unit.log'), 'utf8');
  let unit, errorCode;
  try {
    assert.ok(
      results.every((r) => r.exitCode === 0 && !r.timedOut),
      'REGRESSION_COMMAND_FAILED',
    );
    unit = parseRequiredTap(unitLog, results[0].exitCode);
  } catch (error) {
    errorCode = String(error.message).split('\n')[0];
  }
  const result = {
    format: 'modeldb.security-regression.v1',
    ok: !errorCode,
    timestampUtc: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    unitFiles: units,
    unit,
    integrationScripts: integrations,
    results,
    ...(errorCode ? { errorCode } : {}),
  };
  if (result.ok) {
    assertRegressionReport(result);
  }
  writeFileSync(report, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(`Report: ${report}\n`);
  return { ...result, root, report };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 2, 'Usage: node scripts/security-release-regression.mjs');
  const result = await checkFullRegression();
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (!result.ok) {
    process.exitCode = 1;
  }
}

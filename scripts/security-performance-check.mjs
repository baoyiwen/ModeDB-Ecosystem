/** DR-P4.5: exploration, preregistration and independent confirmation, entirely synthetic. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fullSourceSnapshot, assertNoPublicSecrets } from './security-full-contract.mjs';
import { buildHostedDesigner } from './security-hosting-build.mjs';
import {
  method,
  digest,
  summarize,
  assertMeasurements,
  assertPerformanceReport,
} from './security-performance-contract.mjs';
const repository = fileURLToPath(new URL('../', import.meta.url));
const save = (path, value) =>
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
function publicJson(path, format) {
  const bytes = readFileSync(path);
  assertNoPublicSecrets(bytes);
  const value = JSON.parse(bytes);
  assert.equal(value.format, format);
  return value;
}
function candidateManifest(root) {
  const files = [];
  function walk(dir) {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name),
        stat = lstatSync(path);
      assert.equal(stat.isSymbolicLink(), false);
      if (stat.isDirectory()) {
        walk(path);
      } else {
        assertNoPublicSecrets(readFileSync(path));
        files.push({
          path: relative(root, path).replaceAll('\\', '/'),
          sha256: digest(readFileSync(path).toString('base64')),
        });
      }
    }
  }
  walk(root);
  return files;
}

export function registerPerformance(explorationPath) {
  const exploration = publicJson(explorationPath, 'modeldb.security-performance.v1');
  assertMeasurements(exploration, 3);
  assert.equal(exploration.ok, true);
  assert.equal(exploration.phase, 'explore');
  assert.equal(exploration.sourceUnchanged, true);
  assert.deepEqual(exploration.method, method);
  assert.equal(
    digest(fullSourceSnapshot(repository)),
    exploration.sourceSha256,
    'PERFORMANCE_EXPLORATION_SOURCE_CHANGED',
  );
  const limits = {};
  for (const [key, row] of Object.entries(exploration.summary)) {
    assert.equal(row.failures, 0);
    // Fixed registration rule, chosen before independent confirmation: 50% exploration headroom,
    // rounded to 250 ms, with hard ceilings. It cannot silently widen for a slow confirmation.
    const ceiling = key.endsWith('.login')
      ? 20000
      : key.endsWith('.registrationProof')
        ? 15000
        : 10000;
    const registered = (value) => Math.max(500, Math.ceil((value * 1.5) / 250) * 250);
    limits[key] = {
      clientP95Ms: registered(row.clientMs.p95),
      serverP95Ms: registered(row.serverMs.p95),
    };
    assert.ok(limits[key].clientP95Ms <= ceiling, 'PERFORMANCE_EXPLORATION_TOO_SLOW: ' + key);
  }
  const registration = {
    format: 'modeldb.security-performance-registration.v1',
    registeredAt: new Date().toISOString(),
    methodSha256: digest(method),
    sourceSha256: exploration.sourceSha256,
    candidateSha256: exploration.candidateSha256,
    nodeVersion: exploration.nodeVersion,
    explorationSha256: digest(exploration),
    limits,
    nodeRssMiB: 1024,
    nodeCpuMaxMs: 10000,
    queueMaxMs: 1000,
    localRepairMaxMs: 15000,
    floodMaxRequestMs: 60000,
  };
  const output = join(resolve(explorationPath, '..'), 'registration.json');
  save(output, registration);
  return { ok: true, registration: output, registrationSha256: digest(registration) };
}

export async function checkPerformance(phase, registrationPath) {
  assert.equal(process.platform, 'win32', 'PERFORMANCE_NATIVE_WINDOWS_REQUIRED');
  assert.ok(['explore', 'confirm'].includes(phase));
  const root = mkdtempSync(join(tmpdir(), 'ModeDB-Performance-'));
  const sources = fullSourceSnapshot(repository),
    sourceSha256 = digest(sources),
    startedAt = new Date().toISOString();
  const registration =
    phase === 'confirm'
      ? publicJson(registrationPath, 'modeldb.security-performance-registration.v1')
      : undefined;
  if (registration) {
    assert.equal(registration.sourceSha256, sourceSha256);
    assert.equal(registration.nodeVersion, process.version);
    assert.equal(registration.methodSha256, digest(method));
  }
  save(join(root, 'source-manifest.json'), {
    format: 'modeldb.performance-source.v1',
    sources,
    sha256: sourceSha256,
  });
  const samples = [],
    blocks = [];
  let flood, errorCode, candidateSha256;
  const run = async (args) => {
    const child = spawn(
      process.execPath,
      [
        join(repository, 'node_modules/tsx/dist/cli.mjs'),
        join(repository, 'test/fixtures/security-performance.mjs'),
        ...args,
      ],
      {
        cwd: repository,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: { ...process.env, MODELDB_HOME: join(root, 'unused-home') },
      },
    );
    child.stderr.resume();
    let result, code;
    child.on('message', (m) => {
      if (m.type === 'sample') {
        samples.push(m.sample);
      } else if (m.type === 'result') {
        result = m.result;
      } else if (m.type === 'fatal') {
        code = m.code;
        process.stdout.write(
          JSON.stringify({ event: 'failure', code: m.code, diagnostic: m.diagnostic }) + '\n',
        );
      } else if (m.type === 'diagnostic') {
        process.stdout.write(JSON.stringify(m) + '\n');
      } else if (m.type === 'progress') {
        process.stdout.write(JSON.stringify(m) + '\n');
      }
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 1800000);
    const exit = await new Promise((done, fail) => {
      child.once('error', fail);
      child.once('close', done);
    }).finally(() => clearTimeout(timer));
    if (timedOut) {
      throw Error('PERFORMANCE_WORKLOAD_TIMEOUT');
    }
    if (exit !== 0) {
      throw Error(code ?? 'PERFORMANCE_WORKLOAD_FAILED');
    }
    if (!result) {
      throw Error('PERFORMANCE_WORKLOAD_RESULT_REQUIRED');
    }
    return result;
  };
  try {
    const build = join(root, 'designer');
    await buildHostedDesigner(build);
    const candidate = candidateManifest(build);
    candidateSha256 = digest(candidate);
    save(join(root, 'candidate-manifest.json'), {
      format: 'modeldb.performance-candidate.v1',
      files: candidate,
      sha256: candidateSha256,
    });
    if (registration) {
      assert.equal(candidateSha256, registration.candidateSha256, 'PERFORMANCE_CANDIDATE_CHANGED');
    }
    for (let block = 0; block < 4; block++) {
      const group = method.order[block];
      process.stdout.write(
        JSON.stringify({ event: 'block-start', phase, block, group, root }) + '\n',
      );
      await run([
        'block',
        join(root, 'block-' + block),
        build,
        group,
        String(block),
        phase === 'explore' ? '3' : '15',
      ]);
      blocks.push({ block, group, completed: true });
      save(
        join(root, 'block-' + block + '.json'),
        samples.filter((s) => s.block === block),
      );
    }
    flood = await run(['flood', join(root, 'flood'), build]);
  } catch (error) {
    errorCode = /^PERFORMANCE_[A-Z0-9_: .-]+$/.test(error.message)
      ? error.message
      : 'PERFORMANCE_CHECK_FAILED';
  }
  const sourceUnchanged = digest(fullSourceSnapshot(repository)) === sourceSha256;
  let candidateUnchanged = false;
  try {
    candidateUnchanged =
      !!candidateSha256 && digest(candidateManifest(join(root, 'designer'))) === candidateSha256;
  } catch {
    errorCode ??= 'PERFORMANCE_CANDIDATE_CHANGED';
  }
  if (!sourceUnchanged) {
    errorCode ??= 'PERFORMANCE_SOURCE_CHANGED';
  }
  if (!candidateUnchanged) {
    errorCode ??= 'PERFORMANCE_CANDIDATE_CHANGED';
  }
  const report = {
    format: 'modeldb.security-performance.v1',
    phase,
    ok: !errorCode && sourceUnchanged && candidateUnchanged,
    root,
    startedAt,
    finishedAt: new Date().toISOString(),
    platform: process.platform,
    nodeVersion: process.version,
    method,
    sourceSha256,
    candidateSha256,
    sourceUnchanged,
    candidateUnchanged,
    blocks,
    samples,
    summary: samples.length ? summarize(samples) : {},
    flood,
    ...(errorCode ? { errorCode } : {}),
    ...(registration
      ? {
          registrationSha256: digest(registration),
          explorationSha256: registration.explorationSha256,
        }
      : {}),
    scope: {
      temporarySyntheticOnly: true,
      liveMaterialRead: false,
      hardwareAuthenticatorTested: false,
      realTwoDeviceTested: false,
      productionCapacityClaimed: false,
      childProcessResourcesMeasured: false,
      frontendChanged: false,
    },
  };
  if (report.ok) {
    try {
      if (phase === 'confirm') {
        assertPerformanceReport(report, registration);
      } else {
        assertMeasurements(report, 3);
      }
    } catch (error) {
      report.ok = false;
      report.errorCode = 'PERFORMANCE_ACCEPTANCE_FAILED';
      report.diagnostic = error.message.split('\n')[0];
    }
  }
  const path = join(root, 'performance.json');
  save(path, report);
  process.stdout.write(
    JSON.stringify({
      ok: report.ok,
      phase,
      report: path,
      sourceSha256,
      errorCode: report.errorCode,
      diagnostic: report.diagnostic,
    }) + '\n',
  );
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    assert.ok(
      (args[0] === 'explore' && args.length === 1) ||
        (args[0] === 'register' && args.length === 2) ||
        (args[0] === 'confirm' && args.length === 2),
      'Usage: node scripts/security-performance-check.mjs explore | register <exploration-report> | confirm <registration>',
    );
    if (args[0] === 'register') {
      process.stdout.write(JSON.stringify(registerPerformance(args[1])) + '\n');
    } else if (!(await checkPerformance(args[0], args[1])).ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  }
}

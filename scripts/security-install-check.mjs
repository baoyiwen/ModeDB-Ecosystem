/** DR-P4.3 one-command fresh build/install and synthetic upgrade/disable acceptance. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  artifactFile,
  assertInstalledUpgradeReport,
  checkInstalledCandidate,
  sha256,
} from './security-install-contract.mjs';
const repository = fileURLToPath(new URL('../', import.meta.url));
export async function checkSecurityInstall() {
  assert.equal(process.platform, 'win32', 'INSTALL_WINDOWS_REQUIRED');
  const root = mkdtempSync(join(tmpdir(), 'ModeDB-Install-Check-'));
  process.stdout.write(JSON.stringify({ event: 'install-start', root }) + '\n');
  const commands = [];
  const run = async (name, args) => {
    const log = join(root, name + '.original.txt'),
      stream = createWriteStream(log, { flags: 'wx' });
    const child = spawn(process.execPath, args, {
      cwd: repository,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, MODELDB_HOME: join(root, 'unused-home') },
    });
    child.stdout.pipe(stream, { end: false });
    child.stderr.pipe(stream, { end: false });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 1200000);
    const exitCode = await new Promise((done, fail) => {
      child.once('error', fail);
      child.once('close', done);
    }).finally(() => clearTimeout(timer));
    await new Promise((done) => stream.end(done));
    commands.push({ name, command: [process.execPath, ...args], log, exitCode, timedOut });
    writeFileSync(join(root, 'commands.json'), JSON.stringify(commands, null, 2) + '\n');
    assert.equal(timedOut, false, 'INSTALL_TIMEOUT');
    assert.equal(exitCode, 0, 'INSTALL_COMMAND_FAILED: ' + name);
    process.stdout.write(JSON.stringify({ event: name + '-passed', root }) + '\n');
    return readFileSync(log, 'utf8');
  };
  let releaseRoot, errorCode, result;
  try {
    const output = await run('candidate', [
      join(repository, 'scripts/security-release-candidate.mjs'),
    ]);
    const matches = [...output.matchAll(/^SUCCESS: (.+release-candidate\.json)\r?$/gm)];
    assert.equal(matches.length, 1, 'INSTALL_CANDIDATE_REQUIRED');
    releaseRoot = resolve(matches[0][1], '..');
    const candidate = checkInstalledCandidate(releaseRoot);
    await run('upgrade', [join(repository, 'scripts/security-installed-upgrade.mjs'), releaseRoot]);
    const upgrade = JSON.parse(
      readFileSync(artifactFile(releaseRoot, 'installed-upgrade.json'), 'utf8'),
    );
    assertInstalledUpgradeReport(upgrade);
    assert.equal(upgrade.releaseManifestSha256, candidate.manifestSha256);
    for (const source of candidate.manifest.sourceFiles) {
      assert.equal(
        sha256(readFileSync(artifactFile(repository, source.path))),
        source.sha256,
        'INSTALL_SOURCE_CHANGED: ' + source.path,
      );
    }
    checkInstalledCandidate(releaseRoot);
    result = {
      releaseManifestSha256: candidate.manifestSha256,
      packages: candidate.manifest.packages.length,
      frontends: candidate.manifest.apps.length,
      sourceFiles: candidate.manifest.sourceFiles.length,
      upgrade,
      checks: {
        freshCandidate: true,
        offlineInstall: true,
        cliAndBin: true,
        strictConsumers: true,
        installedUpgrade: true,
        sourceUnchanged: true,
        artifactsUnchanged: true,
      },
    };
  } catch (error) {
    errorCode = String(error.message).split('\n')[0];
  }
  const report = {
    format: 'modeldb.security-install-check.v1',
    task: 'DR-P4.3',
    ok: !errorCode,
    node: process.version,
    platform: process.platform,
    root,
    releaseRoot,
    commands,
    ...result,
    ...(errorCode ? { errorCode } : {}),
    scope: {
      temporarySyntheticOnly: true,
      liveMaterialRead: false,
      realTwoDeviceTested: false,
      frontendChanged: false,
      performanceTested: false,
      fullHistoricalPackageDowngradeTested: false,
    },
  };
  const reportPath = join(root, 'install-check.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  return { ...report, report: reportPath };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert.equal(process.argv.length, 2, 'Usage: node scripts/security-install-check.mjs');
    const result = await checkSecurityInstall();
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (!result.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(String(error.message) + '\n');
    process.exitCode = 1;
  }
}

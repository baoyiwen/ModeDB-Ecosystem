import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { VaultSecurityError } from '@mode-db/common';
import { recoveryDrillErrorCode } from '../../scripts/security-recovery-drill.js';
import { runManagedRecoveryDrill } from '../../scripts/security-recovery-drill-runner.js';
import { SecurityError } from '../../packages/server/src/security/security-errors.js';

const wrapper = fileURLToPath(new URL('../../scripts/security-recovery-drill.ps1', import.meta.url));
const repository = fileURLToPath(new URL('../../', import.meta.url));
const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const windowsOnly = { skip: process.platform !== 'win32' };
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

it('exposes only stable drill, security and filesystem error codes', () => {
  assert.equal(recoveryDrillErrorCode(new SecurityError('SECURITY_INSTANCE_BUSY')), 'SECURITY_INSTANCE_BUSY');
  assert.equal(recoveryDrillErrorCode(new VaultSecurityError('VAULT_PROTECTION_UNAVAILABLE')), 'VAULT_PROTECTION_UNAVAILABLE');
  assert.equal(recoveryDrillErrorCode(Object.assign(new Error('private path and secret'), { code: 'EACCES' })), 'EACCES');
  assert.equal(recoveryDrillErrorCode(new Error('RECOVERY_DRILL_INVALID_FIXTURE')), 'RECOVERY_DRILL_INVALID_FIXTURE');
  for (const error of [new Error('Bearer test-secret'), new Error('SECRET_VALUE'), { code: 'SECRET_VALUE' }, null]) {
    assert.equal(recoveryDrillErrorCode(error), 'RECOVERY_DRILL_FAILED');
  }
});

it('checks the actual Windows token before creating a managed drill directory', windowsOnly, () => {
  const root = mkdtempSync(join(tmpdir(), 'modedb-drill-token-check-'));
  try {
    const token = spawnSync(powershell, ['-NoProfile', '-Command',
      '$identity = [Security.Principal.WindowsIdentity]::GetCurrent(); try { $principal = New-Object Security.Principal.WindowsPrincipal($identity); $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } finally { $identity.Dispose() }'],
      { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(token.status, 0, token.stderr);
    assert.match(token.stdout.trim(), /^(True|False)$/);
    const target = join(root, 'fresh receiver');
    const result = spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapper,
      '-Action', 'Receive', '-DrillRoot', target, '-SkipBuild'],
      { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    if (token.stdout.trim() === 'True') {
      assert.equal(result.status, 1);
      assert.match(result.stdout, /RECOVERY_DRILL_NON_ELEVATED_REQUIRED/);
      assert.equal(existsSync(target), false);
    } else {
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /SUCCESS: Receive/);
      assert.equal(existsSync(join(target, 'drill-session.json')), true);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('runs PowerShell from another directory, preserves runs and records independent-environment refusal', windowsOnly, () => {
  const root = mkdtempSync(join(tmpdir(), 'modedb-wrapper-test-'));
  function invoke(action: string, target: string) {
    return spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapper,
      '-Action', action, '-DrillRoot', target, '-SkipBuild'], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024,
    });
  }
  try {
    const source = join(root, 'source run with spaces');
    const receiver = join(root, 'receiver run with spaces');
    const prepared = invoke('Prepare', source);
    assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
    assert.match(prepared.stdout, /SUCCESS: Prepare/);
    assert.equal(invoke('Receive', receiver).status, 0);
    for (const name of ['manifest.json', 'material.mdrecovery', 'synthetic.mld']) {
      copyFileSync(join(source, 'fixture', name), join(receiver, 'fixture', name));
    }
    copyFileSync(join(source, 'secret', 'phrase.txt'), join(receiver, 'secret', 'phrase.txt'));
    const originalVault = digest(join(receiver, 'fixture', 'synthetic.mld'));
    const originalPackage = digest(join(receiver, 'fixture', 'material.mdrecovery'));
    const phrase = readFileSync(join(receiver, 'secret', 'phrase.txt'), 'utf8');
    const rejected = invoke('Verify', receiver);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stdout, /RECOVERY_DRILL_REQUIRES_INDEPENDENT_WINDOWS_ENVIRONMENT/);
    assert.doesNotMatch(rejected.stdout, /SUCCESS: Verify/);
    const reports = () => readdirSync(receiver).filter(name => name.startsWith('verify-'));
    const report = JSON.parse(readFileSync(join(receiver, reports()[0]), 'utf8'));
    assert.equal(report.status, 'failed');
    assert.equal(report.step, 'verify.independent-environment');
    assert.match(report.sourceFingerprint, /^[a-f0-9]{64}$/);
    assert.match(report.buildFingerprint, /^[a-f0-9]{64}$/);
    const sourceReport = JSON.parse(readFileSync(join(source, readdirSync(source).find(name => name.startsWith('prepare-'))!), 'utf8'));
    assert.equal(report.sourceFingerprint, sourceReport.sourceFingerprint);
    assert.equal(report.buildFingerprint, sourceReport.buildFingerprint);
    assert.equal(invoke('Verify', receiver).status, 1);
    assert.equal(reports().length, 2);
    const manifestPath = join(receiver, 'fixture', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.sourceEnvironmentDigest = '0'.repeat(64);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const edited = invoke('Verify', receiver);
    assert.equal(edited.status, 1);
    assert.match(edited.stdout, /RECOVERY_DRILL_DATA_MISMATCH/);
    const failure = reports().map(name => JSON.parse(readFileSync(join(receiver, name), 'utf8')))
      .find(item => item.errorCode === 'RECOVERY_DRILL_DATA_MISMATCH');
    assert.equal(failure.step, 'verify.synthetic-data');
    assert.equal(digest(join(receiver, 'fixture', 'synthetic.mld')), originalVault);
    assert.equal(digest(join(receiver, 'fixture', 'material.mdrecovery')), originalPackage);
    const beforeRetry = readdirSync(receiver).sort();
    const retry = invoke('Prepare', receiver);
    assert.equal(retry.status, 1);
    assert.match(retry.stdout, /EEXIST/);
    assert.deepEqual(readdirSync(receiver).sort(), beforeRetry);
    for (const output of [prepared.stdout, rejected.stdout, edited.stdout, JSON.stringify(report), JSON.stringify(sourceReport)]) {
      assert.equal(output.includes(phrase), false);
      assert.equal(output.includes('protectedKey'), false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('receives in a Chinese temp path under PowerShell 5.1 CP936 and restores both encodings', windowsOnly, () => {
  const root = mkdtempSync(join(tmpdir(), 'modedb-drill-encoding-'));
  const chineseTemp = join(root, '中文用户', '临时目录');
  mkdirSync(chineseTemp, { recursive: true });
  try {
    const command = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::GetEncoding(936)
$OutputEncoding = [Text.Encoding]::GetEncoding(936)
& '${wrapper.replace(/'/g, "''")}' -Action Receive -SkipBuild
$drillStatus = $LASTEXITCODE
Write-Output ('CONSOLE_CODEPAGE:' + [Console]::OutputEncoding.CodePage)
Write-Output ('PIPELINE_CODEPAGE:' + $OutputEncoding.CodePage)
exit $drillStatus
`;
    const result = spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
      Buffer.from(command, 'utf16le').toString('base64')], {
      env: { ...process.env, TEMP: chineseTemp, TMP: chineseTemp },
      encoding: 'buffer', windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024,
    });
    const output = new TextDecoder('gbk').decode(result.stdout);
    assert.equal(result.status, 0, output + result.stderr.toString());
    assert.match(output, /SUCCESS: Receive/);
    assert.match(output, /CONSOLE_CODEPAGE:936/);
    assert.match(output, /PIPELINE_CODEPAGE:936/);
    const sessions = readdirSync(chineseTemp).filter(name => name.startsWith('ModeDB-Recovery-Drill-'));
    assert.equal(sessions.length, 1);
    const receiver = join(chineseTemp, sessions[0]);
    assert.ok(output.includes(`DrillRoot: ${receiver}`), 'the returned path must round-trip without corruption');
    assert.equal(existsSync(join(receiver, 'drill-session.json')), true);
    assert.equal(existsSync(join(receiver, 'secret', 'phrase.txt')), false);
    const reports = readdirSync(receiver).filter(name => name.startsWith('receive-'));
    assert.equal(reports.length, 1);
    const report = JSON.parse(readFileSync(join(receiver, reports[0]), 'utf8'));
    assert.equal(report.status, 'succeeded');
    assert.equal(report.result.readyToReceive, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('runs both CLI entries and the PowerShell wrapper through a code-directory junction', windowsOnly, () => {
  const root = mkdtempSync(join(tmpdir(), 'modedb-drill-entry-'));
  const alias = join(root, 'source alias');
  try {
    symlinkSync(repository, alias, 'junction');
    const runner = spawnSync(process.execPath, [join(alias, 'node_modules/tsx/dist/cli.mjs'),
      join(alias, 'scripts/security-recovery-drill-runner.ts'), 'receive', '--root', join(root, 'cli receiver')], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000,
    });
    assert.equal(runner.status, 0, runner.stdout + runner.stderr);
    const result = JSON.parse(runner.stdout);
    assert.equal(result.ok, true);
    assert.equal(result.result.readyToReceive, true);
    const legacy = spawnSync(process.execPath, [join(alias, 'node_modules/tsx/dist/cli.mjs'),
      join(alias, 'scripts/security-recovery-drill.ts'), 'invalid'], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000,
    });
    assert.equal(legacy.status, 1, legacy.stdout + legacy.stderr);
    assert.match(legacy.stderr, /RECOVERY_DRILL_INVALID_ARGUMENTS/);
    const wrapped = spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      join(alias, 'scripts/security-recovery-drill.ps1'), '-Action', 'Receive',
      '-DrillRoot', join(root, 'wrapped receiver'), '-SkipBuild'], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000,
    });
    assert.equal(wrapped.status, 0, wrapped.stdout + wrapped.stderr);
    assert.match(wrapped.stdout, /SUCCESS: Receive/);
    // Code aliases may resolve, but recovery-material aliases must still be rejected.
    const linkedData = join(root, 'linked receiver');
    symlinkSync(result.drillRoot, linkedData, 'junction');
    try {
      const refused = runManagedRecoveryDrill('verify', linkedData);
      assert.equal(refused.ok, false);
      if (refused.ok) throw new Error('expected refusal');
      assert.equal(refused.errorCode, 'SECURITY_INVALID_REQUEST');
    } finally { unlinkSync(linkedData); }
  } finally {
    if (existsSync(alias)) unlinkSync(alias);
    rmSync(root, { recursive: true, force: true });
  }
});

it('preserves incomplete receiver files and reports the precise verification stage', windowsOnly, () => {
  const root = mkdtempSync(join(tmpdir(), 'modedb-incomplete-drill-'));
  try {
    const receiver = join(root, 'receiver');
    assert.equal(runManagedRecoveryDrill('receive', receiver).ok, true);
    const result = runManagedRecoveryDrill('verify', receiver);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error('expected refusal');
    assert.equal(result.errorCode, 'ENOENT');
    assert.equal(result.step, 'verify.fixture');
    assert.equal(existsSync(join(receiver, 'secret', 'phrase.txt')), false);
    assert.equal(existsSync(join(receiver, 'fixture')), true);
    assert.equal(JSON.parse(readFileSync(result.report!, 'utf8')).status, 'failed');
    const unknown = join(root, 'unknown-existing-directory');
    mkdirSync(unknown);
    writeFileSync(join(unknown, 'keep.txt'), 'preserve');
    assert.equal(runManagedRecoveryDrill('verify', unknown).ok, false);
    assert.deepEqual(readdirSync(unknown), ['keep.txt']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('rejects repository roots, missing verification targets and invalid PowerShell actions', windowsOnly, () => {
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const refused = runManagedRecoveryDrill('prepare', repository);
  assert.equal(refused.ok, false);
  if (refused.ok) throw new Error('expected refusal');
  assert.equal(refused.errorCode, 'RECOVERY_DRILL_EXTERNAL_DIRECTORY_REQUIRED');
  const relative = runManagedRecoveryDrill('prepare', 'relative-drill');
  assert.equal(relative.ok, false);
  if (relative.ok) throw new Error('expected refusal');
  assert.equal(relative.errorCode, 'RECOVERY_DRILL_ABSOLUTE_DIRECTORY_REQUIRED');
  assert.equal(runManagedRecoveryDrill('verify').ok, false);
  for (const args of [['-Action', 'Verify'], ['-Action', 'Invalid']]) {
    const result = spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapper, ...args, '-SkipBuild'], {
      encoding: 'utf8', windowsHide: true, timeout: 10000,
    });
    assert.notEqual(result.status, 0);
  }
});

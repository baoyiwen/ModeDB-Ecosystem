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

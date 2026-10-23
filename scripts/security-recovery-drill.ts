/** Isolated, synthetic Windows recovery acceptance harness. Never loads repository configuration. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AtlasSingleVault, readAtlasVaultKeyReference } from '@mode-db/core';
import { LocalVaultKeyProvider } from '../packages/server/src/security/local-vault-key-provider.js';
import { SecurityRegistry } from '../packages/server/src/security/security-registry.js';
import { WindowsSecretProtector } from '../packages/server/src/security/windows-secret-protector.js';
import {
  assertRecoveryPath,
  checkRecoveryPackageDependencies,
  createRecoveryPackageFile,
  readRecoveryPassphraseFile,
  restoreRecoveryPackageFile,
  verifyRecoveryPackageFile,
} from '../packages/server/src/security/recovery-material.js';

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
function environmentDigest(): string {
  return hash(`${hostname()}\n${new WindowsSecretProtector().currentIdentity()}`);
}
function within(root: string, path: string): boolean {
  const part = relative(root, path);
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}
interface DrillManifest {
  format: 'modeldb.recovery-drill.v1';
  runId: string;
  sourceEnvironmentDigest: string;
  sourceInstanceId: string;
  recoveryKeyId: string;
  vaultDigest: string;
}
/** Generates only synthetic data and writes no source OS-protected key store into the fixture. */
export function prepareRecoveryDrill(
  fixturePath: string,
  passphrasePath: string,
): { prepared: true; runId: string } {
  const fixture = assertRecoveryPath(fixturePath),
    secret = assertRecoveryPath(passphrasePath);
  if (existsSync(fixture) || existsSync(secret) || within(fixture, secret)) {
    throw new Error('RECOVERY_DRILL_INVALID_TARGET');
  }
  const protector = new WindowsSecretProtector();
  protector.ensureDirectory(dirname(secret));
  protector.ensureDirectory(fixture);
  const source = mkdtempSync(join(tmpdir(), 'modedb-cross-machine-source-'));
  try {
    const provider = new LocalVaultKeyProvider(join(source, 'security'));
    const key = provider.resolveKey('synthetic');
    const runId = randomUUID();
    const sourceEnvironmentDigest = environmentDigest();
    const vault = new AtlasSingleVault();
    vault.set('recovery-drill', runId);
    vault.set('source-environment', sourceEnvironmentDigest);
    try {
      vault.saveSync(join(fixture, 'synthetic.mld'), key);
    } finally {
      key.key.fill(0);
    }
    const phrase = randomBytes(48).toString('base64url');
    writeFileSync(secret, phrase, { flag: 'wx', mode: 0o600 });
    const pkg = createRecoveryPackageFile(provider, join(fixture, 'material.mdrecovery'), phrase);
    const manifest: DrillManifest = {
      format: 'modeldb.recovery-drill.v1',
      runId,
      sourceEnvironmentDigest,
      sourceInstanceId: provider.getIdentity(true).instanceId,
      recoveryKeyId: pkg.recoveryKeyId,
      vaultDigest: hash(readFileSync(join(fixture, 'synthetic.mld'))),
    };
    writeFileSync(join(fixture, 'manifest.json'), JSON.stringify(manifest, null, 2), {
      flag: 'wx',
      mode: 0o600,
    });
    return { prepared: true, runId };
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
}
/** Must execute under another Windows machine/user. A same-environment run cannot produce a pass. */
export function verifyRecoveryDrill(
  fixturePath: string,
  passphrasePath: string,
): {
  format: 'modeldb.recovery-drill-result.v1';
  runId: string;
  independentOsEnvironment: true;
  restored: true;
  emptyAccessLedger: true;
  wrongPassphraseRejected: true;
  tamperedPackageRejected: true;
} {
  const fixture = assertRecoveryPath(fixturePath),
    secret = assertRecoveryPath(passphrasePath);
  const manifestPath = assertRecoveryPath(join(fixture, 'manifest.json'));
  if (!lstatSync(manifestPath).isFile() || lstatSync(manifestPath).size > 4096) {
    throw new Error('RECOVERY_DRILL_INVALID_FIXTURE');
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as DrillManifest;
  if (
    manifest.format !== 'modeldb.recovery-drill.v1' ||
    !/^[a-f0-9-]{36}$/.test(manifest.runId) ||
    !/^[a-f0-9]{64}$/.test(manifest.sourceEnvironmentDigest) ||
    !/^[a-f0-9]{64}$/.test(manifest.vaultDigest)
  ) {
    throw new Error('RECOVERY_DRILL_INVALID_FIXTURE');
  }
  if (manifest.sourceEnvironmentDigest === environmentDigest()) {
    throw new Error('RECOVERY_DRILL_REQUIRES_INDEPENDENT_WINDOWS_ENVIRONMENT');
  }
  const protector = new WindowsSecretProtector();
  const phrase = readRecoveryPassphraseFile(secret, (path) => protector.ensureDirectory(path));
  const packagePath = assertRecoveryPath(join(fixture, 'material.mdrecovery'));
  const vaultPath = assertRecoveryPath(join(fixture, 'synthetic.mld'));
  if (
    lstatSync(vaultPath).size > 1024 * 1024 ||
    hash(readFileSync(vaultPath)) !== manifest.vaultDigest
  ) {
    throw new Error('RECOVERY_DRILL_INVALID_FIXTURE');
  }
  const verified = verifyRecoveryPackageFile(packagePath, phrase);
  if (
    verified.recoveryKeyId !== manifest.recoveryKeyId ||
    verified.sourceInstanceId !== manifest.sourceInstanceId ||
    !checkRecoveryPackageDependencies(packagePath, phrase, [vaultPath]).covered
  ) {
    throw new Error('RECOVERY_DRILL_INVALID_FIXTURE');
  }
  const target = mkdtempSync(join(tmpdir(), 'modedb-cross-machine-target-'));
  const protectedHome = join(target, 'protected');
  protector.ensureDirectory(protectedHome);
  try {
    const directory = join(protectedHome, 'security');
    restoreRecoveryPackageFile(packagePath, phrase, directory);
    const provider = new LocalVaultKeyProvider(directory);
    const copy = join(target, 'restored.mld');
    copyFileSync(vaultPath, copy);
    const key = provider.resolveKey('synthetic', readAtlasVaultKeyReference(copy)!);
    try {
      const vault = new AtlasSingleVault();
      if (
        !vault.loadSync(copy, key) ||
        vault.get('recovery-drill') !== manifest.runId ||
        vault.get('source-environment') !== manifest.sourceEnvironmentDigest ||
        vault.get('source-environment') === environmentDigest()
      ) {
        throw new Error('RECOVERY_DRILL_DATA_MISMATCH');
      }
    } finally {
      key.key.fill(0);
    }
    const registry = SecurityRegistry.open(directory);
    try {
      if (registry.status().credentials !== 0 || registry.status().principals !== 0) {
        throw new Error('RECOVERY_DRILL_ACCESS_STATE_IMPORTED');
      }
    } finally {
      registry.close();
    }
    let wrongPassphraseRejected = false;
    try {
      restoreRecoveryPackageFile(
        packagePath,
        phrase + '-wrong',
        join(protectedHome, 'wrong-password'),
      );
    } catch {
      wrongPassphraseRejected = !existsSync(join(protectedHome, 'wrong-password'));
    }
    const tampered = JSON.parse(readFileSync(packagePath, 'utf8'));
    const parts = tampered.jwe.split('.');
    parts[3] = (parts[3][0] === 'A' ? 'B' : 'A') + parts[3].slice(1);
    tampered.jwe = parts.join('.');
    const badPath = join(target, 'tampered.mdrecovery');
    writeFileSync(badPath, JSON.stringify(tampered));
    let tamperedPackageRejected = false;
    try {
      restoreRecoveryPackageFile(badPath, phrase, join(protectedHome, 'tampered'));
    } catch {
      tamperedPackageRejected = !existsSync(join(protectedHome, 'tampered'));
    }
    if (
      !wrongPassphraseRejected ||
      !tamperedPackageRejected ||
      hash(readFileSync(vaultPath)) !== manifest.vaultDigest
    ) {
      throw new Error('RECOVERY_DRILL_REJECTION_FAILED');
    }
    return {
      format: 'modeldb.recovery-drill-result.v1',
      runId: manifest.runId,
      independentOsEnvironment: true,
      restored: true,
      emptyAccessLedger: true,
      wrongPassphraseRejected: true,
      tamperedPackageRejected: true,
    };
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [action, fixtureFlag, fixture, secretFlag, secret] = process.argv.slice(2);
    if (
      !['prepare', 'verify'].includes(action) ||
      fixtureFlag !== '--fixture' ||
      secretFlag !== '--passphrase-file' ||
      !fixture ||
      !secret ||
      process.argv.length !== 7
    ) {
      throw new Error('RECOVERY_DRILL_INVALID_ARGUMENTS');
    }
    const result =
      action === 'prepare'
        ? prepareRecoveryDrill(fixture, secret)
        : verifyRecoveryDrill(fixture, secret);
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    const message =
      error instanceof Error && /^RECOVERY_DRILL_[A-Z_]+$/.test(error.message)
        ? error.message
        : 'RECOVERY_DRILL_FAILED';
    process.stderr.write(message + '\n');
    process.exitCode = 1;
  }
}

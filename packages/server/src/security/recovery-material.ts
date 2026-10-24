import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  randomUUID,
  scryptSync,
} from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  readdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  acquireFileLeaseSync,
  assertFlatGraphSegment,
  fileDigest,
  isVaultKeyReference,
  readAtomicFileSync,
  vaultKeyReferenceAAD,
  writeAtomicFileSync,
  type AtomicCommitPoint,
  type VaultKeyReference,
} from '@mode-db/common';
import { readAtlasVaultKeyReference, AtlasSingleVault } from '@mode-db/core';
import { LocalVaultKeyProvider, type LocalRecoveryMaterial } from './local-vault-key-provider.js';
import { SecurityError } from './security-errors.js';
import type { SecurityRegistry } from './security-registry.js';

const FORMAT = 'modeldb.recovery.v1';
const MAX_PACKAGE_BYTES = 128 * 1024 * 1024;
const SCRYPT = { N: 16384, r: 8, p: 1 } as const;
const ID = /^[a-zA-Z0-9_-]{1,96}$/;
interface EncryptedBlock {
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
}
interface Metadata {
  readonly format: typeof FORMAT;
  readonly version: 1;
  readonly sourceInstanceId: string;
  readonly createdAt: string;
  readonly recoveryKeyId: string;
  readonly recipientPublicKey: string;
  readonly dependencies: {
    readonly masterKeyIds: readonly string[];
    readonly databaseIds: readonly string[];
    readonly keyIds: readonly string[];
  };
}
export interface RecoveryPackageV1 extends Metadata {
  readonly suite: 'JWE';
  readonly privateKey: {
    readonly kdf: 'scrypt';
    readonly salt: string;
    readonly N: number;
    readonly r: number;
    readonly p: number;
    readonly encryptedPkcs8: EncryptedBlock;
  };
  /** RFC 7516 Compact JWE, RSA-OAEP-256 / A256GCM. */
  readonly jwe: string;
}
const invalid = (): never => {
  throw new SecurityError('SECURITY_INVALID_REQUEST');
};
const failed = (): never => {
  throw new SecurityError('SECURITY_MAINTENANCE_FAILED');
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalid();
  }
  return value as Record<string, unknown>;
}
function exact(value: unknown, names: readonly string[]): Record<string, unknown> {
  const result = object(value);
  if (Object.keys(result).length !== names.length || names.some((name) => !(name in result))) {
    invalid();
  }
  return result;
}
function requirePassphrase(value: string): void {
  if (typeof value !== 'string' || value.length < 12 || value.length > 1024) {
    invalid();
  }
}
const b64 = (value: Uint8Array): string => Buffer.from(value).toString('base64url');
function fromB64(value: unknown, max: number, length?: number): Buffer {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9_-]+$/.test(value) ||
    value.length > Math.ceil((max * 4) / 3)
  ) {
    return invalid();
  }
  const bytes = Buffer.from(value, 'base64url');
  if (
    !bytes.length ||
    bytes.length > max ||
    b64(bytes) !== value ||
    (length !== undefined && bytes.length !== length)
  ) {
    invalid();
  }
  return bytes;
}
function metadata(value: Metadata): Metadata {
  return {
    format: value.format,
    version: value.version,
    sourceInstanceId: value.sourceInstanceId,
    createdAt: value.createdAt,
    recoveryKeyId: value.recoveryKeyId,
    recipientPublicKey: value.recipientPublicKey,
    dependencies: value.dependencies,
  };
}
function header(value: Omit<RecoveryPackageV1, 'jwe'>): string {
  return b64(
    Buffer.from(
      JSON.stringify({
        alg: 'RSA-OAEP-256',
        enc: 'A256GCM',
        typ: FORMAT,
        kid: value.recoveryKeyId,
        metadata: metadata(value),
        privateKey: value.privateKey,
      }),
    ),
  );
}
function encrypt(key: Uint8Array, plain: Uint8Array, aad: string): EncryptedBlock {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { iv: b64(iv), tag: b64(cipher.getAuthTag()), ciphertext: b64(ciphertext) };
}
function validateBlock(value: unknown, max: number): EncryptedBlock {
  const block = exact(value, ['iv', 'tag', 'ciphertext']);
  fromB64(block.iv, 12, 12);
  fromB64(block.tag, 16, 16);
  fromB64(block.ciphertext, max);
  return block as unknown as EncryptedBlock;
}
function decrypt(key: Uint8Array, block: EncryptedBlock, aad: string): Buffer {
  const cipher = createDecipheriv('aes-256-gcm', key, fromB64(block.iv, 12, 12));
  cipher.setAAD(Buffer.from(aad));
  cipher.setAuthTag(fromB64(block.tag, 16, 16));
  try {
    return Buffer.concat([
      cipher.update(fromB64(block.ciphertext, MAX_PACKAGE_BYTES)),
      cipher.final(),
    ]);
  } catch {
    return failed();
  }
}
function clear(material: LocalRecoveryMaterial | undefined): void {
  material?.masterKeys.forEach((entry) => entry.key.fill(0));
  material?.databases.forEach((entry) => entry.key.fill(0));
}
function dependencies(material: LocalRecoveryMaterial): Metadata['dependencies'] {
  return {
    masterKeyIds: material.masterKeys.map((entry) => entry.masterKeyId),
    databaseIds: [...new Set(material.databases.map((entry) => entry.reference.databaseId))],
    keyIds: material.databases.map((entry) => entry.reference.keyId),
  };
}
function encodeMaterial(material: LocalRecoveryMaterial): Buffer {
  return Buffer.from(
    JSON.stringify({
      ...material,
      masterKeys: material.masterKeys.map((entry) => ({ ...entry, key: b64(entry.key) })),
      databases: material.databases.map((entry) => ({ ...entry, key: b64(entry.key) })),
    }),
  );
}
function decodeMaterial(plain: Buffer, pkg: RecoveryPackageV1): LocalRecoveryMaterial {
  const keys: Buffer[] = [];
  try {
    const payload = exact(JSON.parse(plain.toString('utf8')), [
      'version',
      'instanceId',
      'currentMasterKeyId',
      'masterKeys',
      'databases',
    ]);
    if (
      payload.version !== 1 ||
      payload.instanceId !== pkg.sourceInstanceId ||
      typeof payload.currentMasterKeyId !== 'string' ||
      !ID.test(payload.currentMasterKeyId) ||
      !Array.isArray(payload.masterKeys) ||
      !payload.masterKeys.length ||
      payload.masterKeys.length > 1000 ||
      !Array.isArray(payload.databases) ||
      payload.databases.length > 10000
    ) {
      invalid();
    }
    const masterKeys = (payload.masterKeys as unknown[]).map((raw) => {
      const entry = object(raw);
      exact(
        entry,
        entry.retainedAt === undefined
          ? ['masterKeyId', 'key']
          : ['masterKeyId', 'key', 'retainedAt'],
      );
      if (
        typeof entry.masterKeyId !== 'string' ||
        !ID.test(entry.masterKeyId) ||
        (entry.retainedAt !== undefined &&
          (typeof entry.retainedAt !== 'string' || !Number.isFinite(Date.parse(entry.retainedAt))))
      ) {
        invalid();
      }
      const key = fromB64(entry.key, 32, 32);
      keys.push(key);
      return {
        masterKeyId: entry.masterKeyId as string,
        retainedAt: entry.retainedAt as string | undefined,
        key,
      };
    });
    const databases = (payload.databases as unknown[]).map((raw) => {
      const entry = exact(raw, ['reference', 'envelopeMasterKeyId', 'key']);
      const reference = entry.reference;
      exact(reference, ['instanceId', 'databaseId', 'keyId', 'keyVersion']);
      if (
        !isVaultKeyReference(reference) ||
        reference.instanceId !== payload.instanceId ||
        !masterKeys.some((master) => master.masterKeyId === entry.envelopeMasterKeyId)
      ) {
        invalid();
      }
      const key = fromB64(entry.key, 32, 32);
      keys.push(key);
      return {
        reference: reference as VaultKeyReference,
        envelopeMasterKeyId: entry.envelopeMasterKeyId as string,
        key,
      };
    });
    if (
      masterKeys[0]?.masterKeyId !== payload.currentMasterKeyId ||
      new Set(masterKeys.map((entry) => entry.masterKeyId)).size !== masterKeys.length ||
      new Set(databases.map((entry) => entry.reference.keyId)).size !== databases.length
    ) {
      invalid();
    }
    const result: LocalRecoveryMaterial = {
      version: 1,
      instanceId: payload.instanceId as string,
      currentMasterKeyId: payload.currentMasterKeyId as string,
      masterKeys,
      databases,
    };
    if (JSON.stringify(dependencies(result)) !== JSON.stringify(pkg.dependencies)) {
      invalid();
    }
    return result;
  } catch {
    keys.forEach((key) => key.fill(0));
    return failed();
  }
}
/** Reject junctions/symlinks in every component before accessing maintenance files. */
export function assertRecoveryPath(path: string): string {
  const target = resolve(path);
  if (process.platform === 'win32') {
    const components = target
      .slice(target.indexOf(':') + 1)
      .split(/[\\/]/)
      .filter(Boolean);
    if (
      target.startsWith('\\\\') ||
      components.some(
        (component) =>
          /[\x00-\x1f<>:"|?*]/.test(component) ||
          /[. ]$/.test(component) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(component),
      )
    ) {
      invalid();
    }
  }
  for (let current = target; ; current = dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      invalid();
    }
    if (dirname(current) === current) {
      break;
    }
  }
  return target;
}
function readBounded(path: string, max: number): Buffer {
  const target = assertRecoveryPath(path);
  if (!lstatSync(target).isFile() || lstatSync(target).nlink !== 1) {
    invalid();
  }
  const fd = openSync(target, 'r');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > max) {
      throw new SecurityError('SECURITY_RESPONSE_LIMIT');
    }
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (count === 0) {
        invalid();
      }
      offset += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, null) !== 0) {
      throw new SecurityError('SECURITY_RESPONSE_LIMIT');
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}
export function readRecoveryPassphraseFile(
  path: string,
  verifyDirectory: (path: string) => void,
): string {
  const target = assertRecoveryPath(path);
  verifyDirectory(dirname(target));
  const bytes = readBounded(target, 4096);
  try {
    const value = bytes.toString('utf8').replace(/\r?\n$/, '');
    requirePassphrase(value);
    return value;
  } finally {
    bytes.fill(0);
  }
}
function loadPackage(path: string): RecoveryPackageV1 {
  try {
    const pkg = exact(JSON.parse(readBounded(path, MAX_PACKAGE_BYTES).toString('utf8')), [
      'format',
      'version',
      'suite',
      'sourceInstanceId',
      'createdAt',
      'recoveryKeyId',
      'recipientPublicKey',
      'dependencies',
      'privateKey',
      'jwe',
    ]);
    if (
      pkg.format !== FORMAT ||
      pkg.version !== 1 ||
      pkg.suite !== 'JWE' ||
      typeof pkg.sourceInstanceId !== 'string' ||
      !ID.test(pkg.sourceInstanceId) ||
      typeof pkg.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(pkg.createdAt)) ||
      typeof pkg.recoveryKeyId !== 'string' ||
      !/^[a-f0-9]{64}$/.test(pkg.recoveryKeyId)
    ) {
      invalid();
    }
    const publicBytes = fromB64(pkg.recipientPublicKey, 1024);
    const publicKey = createPublicKey({ key: publicBytes, format: 'der', type: 'spki' });
    if (
      publicKey.asymmetricKeyType !== 'rsa' ||
      publicKey.asymmetricKeyDetails?.modulusLength !== 3072 ||
      createHash('sha256').update(publicBytes).digest('hex') !== pkg.recoveryKeyId
    ) {
      invalid();
    }
    const deps = exact(pkg.dependencies, ['masterKeyIds', 'databaseIds', 'keyIds']);
    for (const [name, limit] of [
      ['masterKeyIds', 1000],
      ['databaseIds', 10000],
      ['keyIds', 10000],
    ] as const) {
      const values = deps[name];
      if (
        !Array.isArray(values) ||
        values.length > limit ||
        values.some((value) => typeof value !== 'string' || !ID.test(value)) ||
        new Set(values).size !== values.length
      ) {
        invalid();
      }
    }
    const privateKey = exact(pkg.privateKey, ['kdf', 'salt', 'N', 'r', 'p', 'encryptedPkcs8']);
    if (
      privateKey.kdf !== 'scrypt' ||
      privateKey.N !== SCRYPT.N ||
      privateKey.r !== SCRYPT.r ||
      privateKey.p !== SCRYPT.p
    ) {
      invalid();
    }
    fromB64(privateKey.salt, 16, 16);
    validateBlock(privateKey.encryptedPkcs8, 4096);
    if (typeof pkg.jwe !== 'string') {
      invalid();
    }
    const parts = (pkg.jwe as string).split('.');
    if (parts.length !== 5 || parts[0] !== header(pkg as unknown as RecoveryPackageV1)) {
      invalid();
    }
    fromB64(parts[1], 384, 384);
    fromB64(parts[2], 12, 12);
    fromB64(parts[3], MAX_PACKAGE_BYTES);
    fromB64(parts[4], 16, 16);
    return pkg as unknown as RecoveryPackageV1;
  } catch (error) {
    if (error instanceof SecurityError) {
      throw error;
    }
    return invalid();
  }
}
function openPackage(pkg: RecoveryPackageV1, passphrase: string): LocalRecoveryMaterial {
  requirePassphrase(passphrase);
  const passKey = scryptSync(passphrase, fromB64(pkg.privateKey.salt, 16, 16), 32, SCRYPT);
  let privateBytes: Buffer | undefined;
  let cek: Buffer | undefined;
  let plain: Buffer | undefined;
  try {
    privateBytes = decrypt(passKey, pkg.privateKey.encryptedPkcs8, JSON.stringify(metadata(pkg)));
    const privateKey = createPrivateKey({ key: privateBytes, format: 'der', type: 'pkcs8' });
    const publicBytes = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
    if (b64(publicBytes) !== pkg.recipientPublicKey) {
      return failed();
    }
    const [protectedHeader, encryptedKey, iv, ciphertext, tag] = pkg.jwe.split('.');
    cek = privateDecrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      fromB64(encryptedKey, 384, 384),
    );
    if (cek.length !== 32) {
      return failed();
    }
    plain = decrypt(cek, { iv, ciphertext, tag }, protectedHeader);
    return decodeMaterial(plain, pkg);
  } catch {
    return failed();
  } finally {
    passKey.fill(0);
    privateBytes?.fill(0);
    cek?.fill(0);
    plain?.fill(0);
  }
}
function packageMaterial(material: LocalRecoveryMaterial, passphrase: string): RecoveryPackageV1 {
  requirePassphrase(passphrase);
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 3072,
    publicExponent: 65537,
  });
  const publicBytes = publicKey.export({ format: 'der', type: 'spki' });
  const privateBytes = privateKey.export({ format: 'der', type: 'pkcs8' });
  const salt = randomBytes(16);
  const cek = randomBytes(32);
  const passKey = scryptSync(passphrase, salt, 32, SCRYPT);
  const plain = encodeMaterial(material);
  try {
    const meta: Metadata = {
      format: FORMAT,
      version: 1,
      sourceInstanceId: material.instanceId,
      createdAt: new Date().toISOString(),
      recoveryKeyId: createHash('sha256').update(publicBytes).digest('hex'),
      recipientPublicKey: b64(publicBytes),
      dependencies: dependencies(material),
    };
    const partial: Omit<RecoveryPackageV1, 'jwe'> = {
      ...meta,
      suite: 'JWE',
      privateKey: {
        kdf: 'scrypt',
        salt: b64(salt),
        ...SCRYPT,
        encryptedPkcs8: encrypt(passKey, privateBytes, JSON.stringify(meta)),
      },
    };
    const protectedHeader = header(partial);
    const encryptedKey = publicEncrypt(
      { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      cek,
    );
    const block = encrypt(cek, plain, protectedHeader);
    return {
      ...partial,
      jwe: [protectedHeader, b64(encryptedKey), block.iv, block.ciphertext, block.tag].join('.'),
    };
  } finally {
    privateBytes.fill(0);
    cek.fill(0);
    passKey.fill(0);
    plain.fill(0);
  }
}
function within(root: string, path: string): boolean {
  const part = relative(root, path);
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}
function acquireMaintenance(
  provider: LocalVaultKeyProvider,
  registry?: SecurityRegistry,
): () => void {
  const directory = assertRecoveryPath(provider.getSecurityDirectory());
  provider.verifyProtection(false);
  let releaseInstance: (() => void) | undefined;
  try {
    if (registry) {
      registry.assertMaintenanceOwnership(directory);
    } else {
      releaseInstance = acquireFileLeaseSync(join(directory, 'instance-owner'));
    }
    provider.verifyProtection();
    const releaseKeys = acquireFileLeaseSync(join(directory, 'key-maintenance'));
    return () => {
      releaseKeys();
      releaseInstance?.();
    };
  } catch {
    releaseInstance?.();
    throw new SecurityError('SECURITY_INSTANCE_BUSY');
  }
}
export function createRecoveryPackageFile(
  provider: LocalVaultKeyProvider,
  output: string,
  passphrase: string,
  securityDirectory?: string,
  registry?: SecurityRegistry,
): { path: string; recoveryKeyId: string; databases: number; historicalKeys: number } {
  const target = assertRecoveryPath(output);
  const directory = assertRecoveryPath(provider.getSecurityDirectory());
  if (securityDirectory && realpathSync(securityDirectory) !== realpathSync(directory)) {
    invalid();
  }
  const outputParent = realpathSync(dirname(target));
  if (within(realpathSync(directory), join(outputParent, basename(target))) || existsSync(target)) {
    invalid();
  }
  provider.verifyOutputDirectory(outputParent);
  const release = acquireMaintenance(provider, registry);
  let material: LocalRecoveryMaterial | undefined;
  let created = false;
  let fd: number | undefined;
  try {
    material = provider.exportRecoveryMaterial();
    const pkg = packageMaterial(material, passphrase);
    const bytes = Buffer.from(JSON.stringify(pkg));
    if (bytes.length > MAX_PACKAGE_BYTES) {
      throw new SecurityError('SECURITY_RESPONSE_LIMIT');
    }
    fd = openSync(target, 'wx', 0o600);
    created = true;
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    verifyRecoveryPackageFile(target, passphrase);
    return {
      path: target,
      recoveryKeyId: pkg.recoveryKeyId,
      databases: material.databases.length,
      historicalKeys: material.masterKeys.length,
    };
  } catch (error) {
    if (fd !== undefined) {
      closeSync(fd);
    }
    if (created) {
      unlinkSync(target);
    }
    if (error instanceof SecurityError) {
      throw error;
    }
    return failed();
  } finally {
    clear(material);
    release();
  }
}
export function verifyRecoveryPackageFile(
  packagePath: string,
  passphrase: string,
): {
  recoveryKeyId: string;
  sourceInstanceId: string;
  databases: number;
  historicalKeys: number;
} {
  const pkg = loadPackage(packagePath);
  const material = openPackage(pkg, passphrase);
  try {
    return {
      recoveryKeyId: pkg.recoveryKeyId,
      sourceInstanceId: pkg.sourceInstanceId,
      databases: material.databases.length,
      historicalKeys: material.masterKeys.length,
    };
  } finally {
    clear(material);
  }
}
/** Authenticate coverage of explicitly supplied current Vaults and historical backups. */
export function checkRecoveryPackageDependencies(
  packagePath: string,
  passphrase: string,
  vaultPaths: readonly string[],
): {
  checked: number;
  covered: boolean;
  missing: readonly VaultKeyReference[];
} {
  if (!vaultPaths.length || vaultPaths.length > 10000) {
    invalid();
  }
  const material = openPackage(loadPackage(packagePath), passphrase);
  try {
    const missing: VaultKeyReference[] = [];
    for (const path of vaultPaths) {
      const reference = readAtlasVaultKeyReference(assertRecoveryPath(path));
      if (!reference) {
        throw new SecurityError('SECURITY_NOT_FOUND');
      }
      if (
        !material.databases.some(
          (entry) => vaultKeyReferenceAAD(entry.reference) === vaultKeyReferenceAAD(reference),
        )
      ) {
        missing.push(reference);
      }
    }
    return { checked: vaultPaths.length, covered: missing.length === 0, missing };
  } finally {
    clear(material);
  }
}
export function restoreRecoveryPackageFile(
  packagePath: string,
  passphrase: string,
  targetSecurityDirectory: string,
  protector?: ConstructorParameters<typeof LocalVaultKeyProvider>[1],
  onPoint?: (point: 'staged' | 'published') => void,
): { instanceId: string; masterKeyId: string; databases: number; alreadyRestored?: true } {
  const target = assertRecoveryPath(targetSecurityDirectory);
  if (!existsSync(dirname(target))) {
    invalid();
  }
  const pkg = loadPackage(packagePath);
  const material = openPackage(pkg, passphrase);
  let release: (() => void) | undefined;
  const staging = join(dirname(target), `.${basename(target)}.recovery-${randomUUID()}`);
  try {
    new LocalVaultKeyProvider(staging, protector).verifyOutputDirectory(dirname(target));
    release = acquireFileLeaseSync(`${target}.restore`);
    if (existsSync(target)) {
      // A crash after publication can leave the sibling lease behind. Only this exact,
      // verified recovery result may be acknowledged; other existing targets fail closed.
      if (!lstatSync(target).isDirectory() || !existsSync(join(target, 'recovery.receipt'))) {
        invalid();
      }
      const receipt = exact(
        JSON.parse(readBounded(join(target, 'recovery.receipt'), 4096).toString('utf8')),
        ['version', 'action', 'timestampUtc', 'recoveryKeyId', 'instanceId', 'masterKeyId', 'keys'],
      );
      if (
        receipt.version !== 1 ||
        receipt.action !== 'recovery.restore.completed' ||
        receipt.recoveryKeyId !== pkg.recoveryKeyId ||
        receipt.instanceId !== material.instanceId ||
        receipt.keys !== material.databases.length
      ) {
        invalid();
      }
      const allowed = new Set([
        'instance.key',
        'recovery.receipt',
        ...material.databases.map((entry) => `${entry.reference.keyId}.dek`),
      ]);
      if (readdirSync(target).some((name) => !allowed.has(name))) {
        invalid();
      }
      const published = new LocalVaultKeyProvider(target, protector);
      published.verifyProtection();
      const identity = published.getIdentity(true);
      if (
        identity.instanceId !== receipt.instanceId ||
        identity.masterKeyId !== receipt.masterKeyId
      ) {
        invalid();
      }
      for (const entry of material.databases) {
        const resolved = published.resolveKey('recovery', entry.reference);
        try {
          if (!Buffer.from(resolved.key).equals(entry.key)) {
            failed();
          }
        } finally {
          resolved.key.fill(0);
        }
      }
      return { ...identity, databases: material.databases.length, alreadyRestored: true };
    }
    if (material.masterKeys.length >= 1000) {
      throw new SecurityError('SECURITY_RESPONSE_LIMIT');
    }
    const provider = new LocalVaultKeyProvider(staging, protector);
    const result = provider.restoreRecoveryMaterial(material);
    for (const entry of material.databases) {
      provider.resolveKey('recovery', entry.reference).key.fill(0);
    }
    writeAtomicFileSync(
      join(staging, 'recovery.receipt'),
      Buffer.from(
        JSON.stringify({
          version: 1,
          action: 'recovery.restore.completed',
          timestampUtc: new Date().toISOString(),
          recoveryKeyId: pkg.recoveryKeyId,
          instanceId: result.instanceId,
          masterKeyId: result.masterKeyId,
          keys: result.databases,
        }),
      ),
      null,
      (bytes) => {
        JSON.parse(bytes.toString('utf8'));
      },
    );
    provider.verifyProtection();
    onPoint?.('staged');
    if (existsSync(target)) {
      invalid();
    }
    renameSync(staging, target);
    onPoint?.('published');
    return result;
  } catch (error) {
    if (error instanceof SecurityError) {
      throw error;
    }
    return failed();
  } finally {
    clear(material);
    // Only this invocation's random sibling staging directory can be removed.
    if (
      dirname(staging) === dirname(target) &&
      existsSync(staging) &&
      !lstatSync(staging).isSymbolicLink()
    ) {
      rmSync(staging, { recursive: true });
    }
    release?.();
  }
}
export type DatabaseRotationPoint = 'prepared' | AtomicCommitPoint | 'rewrapped' | 'completed';
/** Owns the offline instance lease, or verifies the registry lease supplied by the CLI. */
export function rotateDatabaseVaultKey(
  vaultPath: string,
  atlas: string,
  provider: LocalVaultKeyProvider,
  statePath: string,
  onPoint?: (point: DatabaseRotationPoint) => void,
  registry?: SecurityRegistry,
): { oldReference: VaultKeyReference; newReference: VaultKeyReference } {
  assertFlatGraphSegment(atlas, 'atlas');
  const path = assertRecoveryPath(vaultPath);
  const directory = assertRecoveryPath(provider.getSecurityDirectory());
  const taskPath = assertRecoveryPath(statePath);
  if (taskPath !== join(directory, 'database-key-rotation.json') || within(directory, path)) {
    invalid();
  }
  const release = acquireMaintenance(provider, registry);
  let oldMaterial: ReturnType<LocalVaultKeyProvider['resolveKey']> | undefined;
  let newMaterial: ReturnType<LocalVaultKeyProvider['resolveKey']> | undefined;
  try {
    const validate = (bytes: Buffer): void => {
      const task = exact(JSON.parse(bytes.toString('utf8')), [
        'version',
        'vaultPath',
        'atlas',
        'oldReference',
        'newReference',
        'previousDigest',
      ]);
      if (
        task.version !== 1 ||
        task.vaultPath !== path ||
        task.atlas !== atlas ||
        !isVaultKeyReference(task.oldReference) ||
        !isVaultKeyReference(task.newReference)
      ) {
        invalid();
      }
      if (typeof task.previousDigest !== 'string' || !/^[a-f0-9]{64}$/.test(task.previousDigest)) {
        invalid();
      }
      const old = task.oldReference as VaultKeyReference,
        next = task.newReference as VaultKeyReference;
      if (
        old.instanceId !== next.instanceId ||
        old.databaseId !== next.databaseId ||
        next.keyVersion !== old.keyVersion + 1 ||
        next.keyId === old.keyId
      ) {
        invalid();
      }
    };
    if (
      !existsSync(taskPath) &&
      existsSync(taskPath + '.pending') &&
      !existsSync(taskPath + '.commit')
    ) {
      const staged = readBounded(taskPath + '.pending', 8192);
      validate(staged);
      renameSync(taskPath + '.pending', taskPath);
    }
    for (const suffix of ['', '.pending', '.commit']) {
      if (existsSync(taskPath + suffix)) {
        readBounded(taskPath + suffix, 8192);
      }
    }
    const bytes = readAtomicFileSync(taskPath, validate);
    let state = bytes
      ? (JSON.parse(bytes.toString('utf8')) as {
          version: 1;
          vaultPath: string;
          atlas: string;
          oldReference: VaultKeyReference;
          newReference: VaultKeyReference;
          previousDigest: string;
        })
      : undefined;
    const oldReference = state?.oldReference ?? readAtlasVaultKeyReference(path);
    if (!oldReference) {
      throw new SecurityError('SECURITY_NOT_FOUND');
    }
    oldMaterial = provider.resolveKey(atlas, oldReference);
    if (state) {
      newMaterial = provider.resolveKey(atlas, state.newReference);
    } else {
      if (!new AtlasSingleVault().loadSync(path, oldMaterial)) {
        throw new SecurityError('SECURITY_NOT_FOUND');
      }
      const disk = statfsSync(dirname(path));
      const size = lstatSync(path).size;
      if (disk.bavail * disk.bsize < size * 2 + 1024 * 1024) {
        failed();
      }
      newMaterial = provider.prepareDatabaseKeyRotation(oldReference);
      state = {
        version: 1,
        vaultPath: path,
        atlas,
        oldReference,
        newReference: newMaterial.reference,
        previousDigest: fileDigest(readFileSync(path)),
      };
      writeAtomicFileSync(taskPath, Buffer.from(JSON.stringify(state)), null, validate);
      onPoint?.('prepared');
    }
    new AtlasSingleVault().saveRekeyedSync(
      path,
      oldMaterial,
      newMaterial,
      onPoint,
      state.previousDigest,
    );
    onPoint?.('rewrapped');
    if (!new AtlasSingleVault().loadSync(path, newMaterial)) {
      failed();
    }
    provider.finalizeDatabaseKeyRotation(oldReference, newMaterial.reference);
    onPoint?.('completed');
    unlinkSync(taskPath);
    return { oldReference, newReference: newMaterial.reference };
  } catch (error) {
    if (error instanceof SecurityError) {
      throw error;
    }
    return failed();
  } finally {
    oldMaterial?.key.fill(0);
    newMaterial?.key.fill(0);
    release();
  }
}

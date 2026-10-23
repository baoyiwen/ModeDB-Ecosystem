import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  assertFlatGraphSegment,
  acquireFileLeaseSync,
  fileDigest,
  isVaultKeyReference,
  readAtomicFileSync,
  vaultKeyReferenceAAD,
  VaultSecurityError,
  writeAtomicFileSync,
  type VaultKeyMaterial,
  type VaultKeyProvider,
  type VaultKeyReference,
} from '@mode-db/common';
import { WindowsSecretProtector, type SecretProtector } from './windows-secret-protector.js';

interface MasterRecord {
  version: 1;
  instanceId: string;
  masterKeyId: string;
  protector: string;
  protectedKey: string;
  history?: { masterKeyId: string; protectedKey: string; retainedAt: string }[];
  rotation?: {
    id: string;
    phase: 'rewrapping' | 'completed';
    startedAt: string;
    completedAt?: string;
  };
}
interface KeyEnvelope {
  version: 1;
  reference: VaultKeyReference;
  masterKeyId: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface RecoveryMasterKeyMaterial {
  readonly masterKeyId: string;
  readonly retainedAt?: string;
  readonly key: Buffer;
}

export interface RecoveryDatabaseKeyMaterial {
  readonly reference: VaultKeyReference;
  readonly envelopeMasterKeyId: string;
  readonly key: Buffer;
}

/** Secret material held only in memory while creating or applying a recovery package. */
export interface LocalRecoveryMaterial {
  readonly version: 1;
  readonly instanceId: string;
  readonly currentMasterKeyId: string;
  readonly masterKeys: readonly RecoveryMasterKeyMaterial[];
  readonly databases: readonly RecoveryDatabaseKeyMaterial[];
}

/** Independent per-instance IMK and per-database DEK store. Startup/DDL only. */
export class LocalVaultKeyProvider implements VaultKeyProvider {
  private master?: { record: MasterRecord; key: Buffer };
  private readonly directory: string;

  constructor(
    directory: string,
    private readonly protector: SecretProtector = new WindowsSecretProtector(),
  ) {
    this.directory = resolve(directory);
  }

  getSecurityDirectory(): string {
    return this.directory;
  }

  verifyProtection(verifyFiles = true): void {
    if (this.protector instanceof WindowsSecretProtector) {
      this.protector.ensureDirectory(this.directory, verifyFiles);
    } else {
      this.protector.ensureDirectory(this.directory);
    }
  }

  verifyOutputDirectory(path: string): void {
    if (this.protector instanceof WindowsSecretProtector) {
      this.protector.ensureDirectory(path, false);
    } else {
      this.protector.ensureDirectory(path);
    }
  }

  /** Public key-domain identity; never exposes master key material. */
  getIdentity(requireExisting = false): { instanceId: string; masterKeyId: string } {
    const { record } = this.getMaster(requireExisting);
    return { instanceId: record.instanceId, masterKeyId: record.masterKeyId };
  }

  maintenanceStatus(): {
    instanceId: string;
    masterKeyId: string;
    retainedMasterKeys: number;
    rotation?: MasterRecord['rotation'];
  } {
    const { record } = this.getMaster(true);
    return {
      instanceId: record.instanceId,
      masterKeyId: record.masterKeyId,
      retainedMasterKeys: record.history?.length ?? 0,
      rotation: record.rotation,
    };
  }

  /** Export every historical IMK and DEK dependency for portable recovery. */
  exportRecoveryMaterial(): LocalRecoveryMaterial {
    const master = this.getMaster(true);
    const masterKeys: RecoveryMasterKeyMaterial[] = [];
    const current = Buffer.from(master.key);
    masterKeys.push({ masterKeyId: master.record.masterKeyId, key: current });
    const databases: RecoveryDatabaseKeyMaterial[] = [];
    try {
      for (const entry of master.record.history ?? []) {
        const key = this.protector.unprotect(
          entry.protectedKey,
          `modeldb-imk-v1:${master.record.instanceId}:${entry.masterKeyId}`,
        );
        if (key.length !== 32) {
          key.fill(0);
          throw new VaultSecurityError('VAULT_KEY_UNAVAILABLE');
        }
        masterKeys.push({ masterKeyId: entry.masterKeyId, retainedAt: entry.retainedAt, key });
      }
      const names = new Set(
        readdirSync(this.directory)
          .filter((entry) => /^[a-zA-Z0-9_-]+\.dek(?:\.(?:pending|commit))?$/.test(entry))
          .map((entry) => entry.replace(/\.(?:pending|commit)$/, '')),
      );
      if (names.size > 10000 || masterKeys.length > 1000) {
        throw new VaultSecurityError('VAULT_KEY_UNAVAILABLE');
      }
      for (const name of names) {
        const path = join(this.directory, name);
        this.assertRegular(path);
        const bytes = readAtomicFileSync(path, (candidate) => {
          const ref = (JSON.parse(candidate.toString('utf8')) as KeyEnvelope).reference;
          if (!isVaultKeyReference(ref) || name !== `${ref.keyId}.dek`) {
            throw new VaultSecurityError('VAULT_KEY_MISMATCH');
          }
          this.unwrap(candidate, master, ref).fill(0);
        });
        if (!bytes) {
          throw new VaultSecurityError('VAULT_KEY_UNAVAILABLE');
        }
        const envelope = JSON.parse(bytes.toString('utf8')) as KeyEnvelope;
        if (
          !isVaultKeyReference(envelope.reference) ||
          envelope.reference.instanceId !== master.record.instanceId ||
          name !== `${envelope.reference.keyId}.dek`
        ) {
          throw new VaultSecurityError('VAULT_KEY_MISMATCH');
        }
        const key = this.unwrap(bytes, master, envelope.reference);
        databases.push({
          reference: envelope.reference,
          envelopeMasterKeyId: envelope.masterKeyId,
          key,
        });
      }
      return {
        version: 1,
        instanceId: master.record.instanceId,
        currentMasterKeyId: master.record.masterKeyId,
        masterKeys,
        databases,
      };
    } catch (error) {
      for (const item of masterKeys) {
        item.key.fill(0);
      }
      for (const item of databases) {
        item.key.fill(0);
      }
      if (error instanceof VaultSecurityError) {
        throw error;
      }
      throw new VaultSecurityError('VAULT_KEY_UNAVAILABLE');
    }
  }

  /** Rewrap recovered DEKs under a fresh target IMK while preserving Vault references. */
  restoreRecoveryMaterial(material: LocalRecoveryMaterial): {
    instanceId: string;
    masterKeyId: string;
    databases: number;
  } {
    if (
      material.version !== 1 ||
      !/^[a-zA-Z0-9_-]{1,96}$/.test(material.instanceId) ||
      material.masterKeys.length < 1 ||
      material.masterKeys.length >= 1000 ||
      material.databases.length > 10000 ||
      material.masterKeys[0]?.masterKeyId !== material.currentMasterKeyId ||
      material.masterKeys.some((entry) => entry.key.length !== 32) ||
      new Set(material.masterKeys.map((entry) => entry.masterKeyId)).size !==
        material.masterKeys.length ||
      new Set(material.databases.map((entry) => entry.reference.keyId)).size !==
        material.databases.length ||
      material.databases.some(
        (entry) =>
          entry.key.length !== 32 ||
          !isVaultKeyReference(entry.reference) ||
          entry.reference.instanceId !== material.instanceId,
      )
    ) {
      throw new VaultSecurityError('VAULT_KEY_MISMATCH');
    }
    this.protector.ensureDirectory(this.directory);
    const release = acquireFileLeaseSync(join(this.directory, 'key-maintenance'));
    const created: string[] = [];
    try {
      this.protector.ensureDirectory(this.directory);
      if (readdirSync(this.directory).some((name) => name !== 'key-maintenance.lock')) {
        throw new VaultSecurityError('VAULT_KEY_UNAVAILABLE');
      }
      const targetMasterKeyId = randomUUID();
      const targetKey = randomBytes(32);
      try {
        const history = material.masterKeys.map((entry) => ({
          masterKeyId: entry.masterKeyId,
          protectedKey: this.protector.protect(
            entry.key,
            `modeldb-imk-v1:${material.instanceId}:${entry.masterKeyId}`,
          ),
          retainedAt: entry.retainedAt ?? new Date().toISOString(),
        }));
        const record: MasterRecord = {
          version: 1,
          instanceId: material.instanceId,
          masterKeyId: targetMasterKeyId,
          protector: this.protector.id,
          protectedKey: this.protector.protect(
            targetKey,
            `modeldb-imk-v1:${material.instanceId}:${targetMasterKeyId}`,
          ),
          history,
        };
        const masterPath = join(this.directory, 'instance.key');
        writeAtomicFileSync(masterPath, Buffer.from(JSON.stringify(record)), null, (bytes) => {
          JSON.parse(bytes.toString('utf8'));
        });
        created.push(masterPath);
        for (const entry of material.databases) {
          const envelope = this.wrap(entry.reference, entry.key, targetMasterKeyId, targetKey);
          const path = join(this.directory, `${entry.reference.keyId}.dek`);
          writeAtomicFileSync(path, Buffer.from(JSON.stringify(envelope)), null, (bytes) => {
            this.unwrapWithKey(bytes, targetKey, targetMasterKeyId, entry.reference).fill(0);
          });
          created.push(path);
        }
      } finally {
        targetKey.fill(0);
      }
      return {
        instanceId: material.instanceId,
        masterKeyId: targetMasterKeyId,
        databases: material.databases.length,
      };
    } catch (error) {
      for (const path of created.reverse()) {
        for (const suffix of ['', '.pending', '.commit']) {
          try {
            unlinkSync(path + suffix);
          } catch {
            /* best effort cleanup of this new target */
          }
        }
      }
      if (error instanceof VaultSecurityError) {
        throw error;
      }
      throw new VaultSecurityError('VAULT_KEY_UNAVAILABLE');
    } finally {
      release();
    }
  }

  /** Prepare a new DEK envelope; old envelopes remain available for retained backups. */
  prepareDatabaseKeyRotation(existing: VaultKeyReference): VaultKeyMaterial {
    const old = this.resolveKey('rotation', existing);
    try {
      this.assertDatabaseKeyCapacity();
      const next: VaultKeyReference = {
        ...existing,
        keyId: randomUUID(),
        keyVersion: existing.keyVersion + 1,
      };
      const master = this.getMaster(true);
      const key = randomBytes(32);
      const path = join(this.directory, `${next.keyId}.dek`);
      const envelope = this.wrap(next, key, master.record.masterKeyId, master.key);
      try {
        writeAtomicFileSync(path, Buffer.from(JSON.stringify(envelope)), null, (bytes) => {
          this.unwrapWithKey(bytes, master.key, master.record.masterKeyId, next).fill(0);
        });
      } catch {
        key.fill(0);
        throw new VaultSecurityError('VAULT_KEY_UNAVAILABLE');
      }
      return { reference: next, key };
    } finally {
      old.key.fill(0);
    }
  }

  /** Validate promotion. Never destroy historical keys without a proven dependency-free policy. */
  finalizeDatabaseKeyRotation(existing: VaultKeyReference, replacement: VaultKeyReference): void {
    if (
      existing.instanceId !== replacement.instanceId ||
      existing.databaseId !== replacement.databaseId ||
      replacement.keyVersion <= existing.keyVersion
    ) {
      throw new VaultSecurityError('VAULT_KEY_MISMATCH');
    }
    const next = this.resolveKey('rotation', replacement);
    next.key.fill(0);
  }

  /** Atomic promotion retains every old IMK before any envelope changes. Retrying resumes the same task. */
  rotateMaster(
    onPoint?: (point: 'promoted' | 'rewrapped' | 'completed') => void,
  ): ReturnType<LocalVaultKeyProvider['maintenanceStatus']> {
    const release = acquireFileLeaseSync(join(this.directory, 'key-maintenance'));
    try {
      let master = this.getMaster(true);
      const path = join(this.directory, 'instance.key');
      const saveMaster = (record: MasterRecord): void => {
        const serialized = Buffer.from(JSON.stringify(record));
        if (serialized.length > 1024 * 1024) {
          throw new VaultSecurityError('VAULT_KEY_UNAVAILABLE');
        }
        const previous = readAtomicFileSync(path, () => undefined);
        if (!previous) {
          throw new VaultSecurityError('VAULT_KEY_UNAVAILABLE');
        }
        writeAtomicFileSync(path, serialized, fileDigest(previous), (bytes) => {
          const value = JSON.parse(bytes.toString()) as MasterRecord;
          const key = this.protector.unprotect(
            value.protectedKey,
            `modeldb-imk-v1:${value.instanceId}:${value.masterKeyId}`,
          );
          try {
            if (key.length !== 32) {
              throw new VaultSecurityError('VAULT_KEY_UNAVAILABLE');
            }
          } finally {
            key.fill(0);
          }
        });
        this.master?.key.fill(0);
        this.master = undefined;
      };
      if (master.record.rotation?.phase !== 'rewrapping') {
        if ((master.record.history?.length ?? 0) >= 1000) {
          throw new VaultSecurityError('VAULT_KEY_UNAVAILABLE');
        }
        const key = randomBytes(32);
        const masterKeyId = randomUUID();
        const startedAt = new Date().toISOString();
        try {
          saveMaster({
            ...master.record,
            masterKeyId,
            protectedKey: this.protector.protect(
              key,
              `modeldb-imk-v1:${master.record.instanceId}:${masterKeyId}`,
            ),
            history: [
              ...(master.record.history ?? []),
              {
                masterKeyId: master.record.masterKeyId,
                protectedKey: master.record.protectedKey,
                retainedAt: startedAt,
              },
            ],
            rotation: { id: randomUUID(), phase: 'rewrapping', startedAt },
          });
        } finally {
          key.fill(0);
        }
        onPoint?.('promoted');
        master = this.getMaster(true);
      }
      const names = new Set(
        readdirSync(this.directory)
          .filter((name) => /^[a-zA-Z0-9_-]+\.dek(?:\.(?:pending|commit))?$/.test(name))
          .map((name) => name.replace(/\.(?:pending|commit)$/, '')),
      );
      for (const name of names) {
        const envelopePath = join(this.directory, name);
        this.assertRegular(envelopePath);
        let reference: VaultKeyReference | undefined;
        const bytes = readAtomicFileSync(envelopePath, (raw) => {
          const candidate = (JSON.parse(raw.toString()) as KeyEnvelope).reference;
          if (
            !isVaultKeyReference(candidate) ||
            candidate.instanceId !== master.record.instanceId
          ) {
            throw new VaultSecurityError('VAULT_KEY_MISMATCH');
          }
          reference = candidate;
          this.unwrap(raw, master, candidate).fill(0);
        });
        if (!bytes || !reference) {
          throw new VaultSecurityError('VAULT_KEY_UNAVAILABLE');
        }
        if (
          (JSON.parse(bytes.toString()) as KeyEnvelope).masterKeyId === master.record.masterKeyId
        ) {
          continue;
        }
        const key = this.unwrap(bytes, master, reference);
        try {
          const iv = randomBytes(12);
          const cipher = createCipheriv('aes-256-gcm', master.key, iv);
          cipher.setAAD(Buffer.from(vaultKeyReferenceAAD(reference) + master.record.masterKeyId));
          const ciphertext = Buffer.concat([cipher.update(key), cipher.final()]);
          const envelope: KeyEnvelope = {
            version: 1,
            reference,
            masterKeyId: master.record.masterKeyId,
            iv: iv.toString('base64'),
            tag: cipher.getAuthTag().toString('base64'),
            ciphertext: ciphertext.toString('base64'),
          };
          writeAtomicFileSync(
            envelopePath,
            Buffer.from(JSON.stringify(envelope)),
            fileDigest(bytes),
            (raw) => {
              this.unwrap(raw, master, reference!).fill(0);
            },
          );
        } finally {
          key.fill(0);
        }
        onPoint?.('rewrapped');
      }
      saveMaster({
        ...master.record,
        rotation: {
          ...master.record.rotation!,
          phase: 'completed',
          completedAt: new Date().toISOString(),
        },
      });
      onPoint?.('completed');
      return this.maintenanceStatus();
    } finally {
      release();
    }
  }

  resolveKey(atlas: string, existing?: VaultKeyReference): VaultKeyMaterial {
    try {
      return this.resolve(atlas, existing);
    } catch (error) {
      if (error instanceof VaultSecurityError) {
        throw error;
      }
      throw new VaultSecurityError('VAULT_KEY_UNAVAILABLE');
    }
  }

  private resolve(atlas: string, existing?: VaultKeyReference): VaultKeyMaterial {
    assertFlatGraphSegment(atlas, 'atlas');
    if (existing && !isVaultKeyReference(existing)) {
      throw new VaultSecurityError('VAULT_KEY_MISMATCH');
    }
    const master = this.getMaster(existing !== undefined);
    if (existing) {
      if (existing.instanceId !== master.record.instanceId) {
        throw new VaultSecurityError('VAULT_KEY_MISMATCH');
      }
      const path = join(this.directory, `${existing.keyId}.dek`);
      this.assertRegular(path);
      let key: Buffer | undefined;
      const loaded = readAtomicFileSync(path, (bytes) => {
        key = this.unwrap(bytes, master, existing);
      });
      if (!loaded || !key) {
        throw new VaultSecurityError('VAULT_KEY_UNAVAILABLE');
      }
      return { reference: existing, key };
    }
    this.assertDatabaseKeyCapacity();
    const reference: VaultKeyReference = {
      instanceId: master.record.instanceId,
      databaseId: randomUUID(),
      keyId: randomUUID(),
      keyVersion: 1,
    };
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', master.key, iv);
    cipher.setAAD(Buffer.from(vaultKeyReferenceAAD(reference) + master.record.masterKeyId));
    const encrypted = Buffer.concat([cipher.update(key), cipher.final()]);
    const envelope: KeyEnvelope = {
      version: 1,
      reference,
      masterKeyId: master.record.masterKeyId,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: encrypted.toString('base64'),
    };
    const path = join(this.directory, `${reference.keyId}.dek`);
    writeAtomicFileSync(path, Buffer.from(JSON.stringify(envelope)), null, (bytes) => {
      this.unwrap(bytes, master, reference).fill(0);
    });
    return { reference, key };
  }

  private getMaster(requireExisting: boolean): { record: MasterRecord; key: Buffer } {
    if (
      ['', '.pending', '.commit'].some((suffix) =>
        existsSync(join(dirname(this.directory), 'security-reset.pending' + suffix)),
      )
    ) {
      throw new VaultSecurityError('VAULT_KEY_UNAVAILABLE');
    }
    // A second provider may have promoted the master; cached material must never create new old-key envelopes.
    this.master?.key.fill(0);
    this.master = undefined;
    this.protector.ensureDirectory(this.directory);
    const path = join(this.directory, 'instance.key');
    this.assertRegular(path);
    const parse = (bytes: Buffer): MasterRecord => {
      try {
        if (bytes.length > 1024 * 1024) {
          throw new Error();
        }
        const record = JSON.parse(bytes.toString('utf8')) as MasterRecord;
        if (
          record.version !== 1 ||
          record.protector !== this.protector.id ||
          typeof record.instanceId !== 'string' ||
          typeof record.masterKeyId !== 'string' ||
          !/^[a-zA-Z0-9_-]{1,96}$/.test(record.instanceId) ||
          !/^[a-zA-Z0-9_-]{1,96}$/.test(record.masterKeyId) ||
          typeof record.protectedKey !== 'string'
        ) {
          throw new Error();
        }
        if (
          record.history !== undefined &&
          (!Array.isArray(record.history) ||
            record.history.length > 1000 ||
            record.history.some(
              (entry) =>
                !/^[a-zA-Z0-9_-]{1,96}$/.test(entry.masterKeyId) ||
                typeof entry.protectedKey !== 'string' ||
                !Number.isFinite(Date.parse(entry.retainedAt)),
            ))
        ) {
          throw new Error();
        }
        const ids = [
          record.masterKeyId,
          ...(record.history ?? []).map((entry) => entry.masterKeyId),
        ];
        if (new Set(ids).size !== ids.length) {
          throw new Error();
        }
        if (
          record.rotation !== undefined &&
          (!['rewrapping', 'completed'].includes(record.rotation.phase) ||
            !/^[a-f0-9-]{36}$/.test(record.rotation.id) ||
            !Number.isFinite(Date.parse(record.rotation.startedAt)))
        ) {
          throw new Error();
        }
        return record;
      } catch {
        throw new VaultSecurityError('VAULT_KEY_UNAVAILABLE');
      }
    };
    const validate = (candidate: Buffer): void => {
      const record = parse(candidate);
      let secret: Buffer | undefined;
      try {
        secret = this.protector.unprotect(
          record.protectedKey,
          `modeldb-imk-v1:${record.instanceId}:${record.masterKeyId}`,
        );
        if (secret.length !== 32) {
          throw new Error();
        }
      } catch {
        throw new VaultSecurityError('VAULT_KEY_UNAVAILABLE');
      } finally {
        secret?.fill(0);
      }
    };
    let bytes = readAtomicFileSync(path, (candidate) => {
      validate(candidate);
    });
    if (!bytes) {
      if (
        requireExisting ||
        readdirSync(this.directory).some((name) => /\.dek(?:\.|$)/.test(name))
      ) {
        throw new VaultSecurityError('VAULT_KEY_UNAVAILABLE');
      }
      const instanceId = randomUUID();
      const masterKeyId = randomUUID();
      const secret = randomBytes(32);
      try {
        const record: MasterRecord = {
          version: 1,
          instanceId,
          masterKeyId,
          protector: this.protector.id,
          protectedKey: this.protector.protect(
            secret,
            `modeldb-imk-v1:${instanceId}:${masterKeyId}`,
          ),
        };
        bytes = Buffer.from(JSON.stringify(record));
        writeAtomicFileSync(path, bytes, null, (candidate) => {
          validate(candidate);
        });
      } finally {
        secret.fill(0);
      }
    }
    const record = parse(bytes);
    let key: Buffer;
    try {
      key = this.protector.unprotect(
        record.protectedKey,
        `modeldb-imk-v1:${record.instanceId}:${record.masterKeyId}`,
      );
    } catch {
      throw new VaultSecurityError('VAULT_KEY_UNAVAILABLE');
    }
    if (key.length !== 32) {
      key.fill(0);
      throw new VaultSecurityError('VAULT_KEY_UNAVAILABLE');
    }
    this.master = { record, key };
    return this.master;
  }

  private unwrap(
    bytes: Buffer,
    master: { record: MasterRecord; key: Buffer },
    reference: VaultKeyReference,
  ): Buffer {
    try {
      if (bytes.length > 16384) {
        throw new Error();
      }
      const envelope = JSON.parse(bytes.toString('utf8')) as KeyEnvelope;
      if (
        envelope.version !== 1 ||
        vaultKeyReferenceAAD(envelope.reference) !== vaultKeyReferenceAAD(reference)
      ) {
        throw new Error();
      }
      const iv = Buffer.from(envelope.iv, 'base64');
      const tag = Buffer.from(envelope.tag, 'base64');
      const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
      if (iv.length !== 12 || tag.length !== 16 || ciphertext.length !== 32) {
        throw new Error();
      }
      let historicalKey: Buffer | undefined;
      try {
        if (envelope.masterKeyId !== master.record.masterKeyId) {
          const historical = master.record.history?.find(
            (entry) => entry.masterKeyId === envelope.masterKeyId,
          );
          if (!historical) {
            throw new Error();
          }
          historicalKey = this.protector.unprotect(
            historical.protectedKey,
            `modeldb-imk-v1:${master.record.instanceId}:${historical.masterKeyId}`,
          );
          if (historicalKey.length !== 32) {
            throw new Error();
          }
        }
        const decipher = createDecipheriv('aes-256-gcm', historicalKey ?? master.key, iv);
        decipher.setAAD(Buffer.from(vaultKeyReferenceAAD(reference) + envelope.masterKeyId));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      } finally {
        historicalKey?.fill(0);
      }
    } catch {
      throw new VaultSecurityError('VAULT_KEY_UNAVAILABLE');
    }
  }

  private wrap(
    reference: VaultKeyReference,
    key: Buffer,
    masterKeyId: string,
    masterKey: Uint8Array,
  ): KeyEnvelope {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
    cipher.setAAD(Buffer.from(vaultKeyReferenceAAD(reference) + masterKeyId));
    const ciphertext = Buffer.concat([cipher.update(key), cipher.final()]);
    return {
      version: 1,
      reference: { ...reference },
      masterKeyId,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  }

  private unwrapWithKey(
    bytes: Buffer,
    masterKey: Uint8Array,
    masterKeyId: string,
    reference: VaultKeyReference,
  ): Buffer {
    try {
      const envelope = JSON.parse(bytes.toString('utf8')) as KeyEnvelope;
      if (
        envelope.version !== 1 ||
        !isVaultKeyReference(envelope.reference) ||
        vaultKeyReferenceAAD(envelope.reference) !== vaultKeyReferenceAAD(reference) ||
        envelope.masterKeyId !== masterKeyId
      ) {
        throw new Error();
      }
      const iv = Buffer.from(envelope.iv, 'base64');
      const tag = Buffer.from(envelope.tag, 'base64');
      const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
      if (iv.length !== 12 || tag.length !== 16 || ciphertext.length !== 32) {
        throw new Error();
      }
      const decipher = createDecipheriv('aes-256-gcm', masterKey, iv);
      decipher.setAAD(Buffer.from(vaultKeyReferenceAAD(reference) + masterKeyId));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new VaultSecurityError('VAULT_KEY_UNAVAILABLE');
    }
  }

  private assertDatabaseKeyCapacity(): void {
    const names = new Set(
      readdirSync(this.directory)
        .filter((name) => /^[a-zA-Z0-9_-]+\.dek(?:\.(?:pending|commit))?$/.test(name))
        .map((name) => name.replace(/\.(?:pending|commit)$/, '')),
    );
    if (names.size >= 10000) {
      throw new VaultSecurityError('VAULT_KEY_UNAVAILABLE');
    }
  }

  private assertRegular(path: string): void {
    if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) {
      throw new VaultSecurityError('VAULT_KEY_UNAVAILABLE');
    }
  }
}

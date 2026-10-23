import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  rmdirSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { acquireFileLeaseSync, writeAtomicFileSync } from '@mode-db/common';
import type { LocalVaultKeyProvider } from './local-vault-key-provider.js';
import type { SecurityRegistry } from './security-registry.js';
import { SecurityError } from './security-errors.js';
import { WindowsSecretProtector, type SecretProtector } from './windows-secret-protector.js';

const MAX_RESET_BYTES = 128 * 1024 * 1024;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Reset always runs offline under the registry lease. HTTP/IPC can only inspect its target. */
export class SecurityMaintenance {
  constructor(
    private readonly registry: SecurityRegistry,
    private readonly keys: LocalVaultKeyProvider,
    private readonly directory: string,
    private readonly workspace: string,
    private readonly protector: SecretProtector = new WindowsSecretProtector(),
  ) {}

  status(): {
    keys: ReturnType<LocalVaultKeyProvider['maintenanceStatus']>;
    reset: { instanceId: string; target: string; offlineRequired: true };
  } {
    return {
      keys: this.keys.maintenanceStatus(),
      reset: {
        instanceId: this.registry.status().instanceId,
        target: realpathSync(this.workspace),
        offlineRequired: true,
      },
    };
  }

  rotateMaster(): ReturnType<LocalVaultKeyProvider['maintenanceStatus']> {
    this.registry.recordMaintenance('master.rotate.started');
    const result = this.keys.rotateMaster();
    this.registry.recordMaintenance('master.rotate.completed');
    return result;
  }

  resumeRotation(): void {
    if (this.keys.maintenanceStatus().rotation?.phase === 'rewrapping') {
      this.rotateMaster();
    }
  }

  /** Caller must own the registry exclusively, have verified OS ACL, and must not start a listener. */
  factoryReset(
    input: { instanceId: string; target: string; yes: boolean },
    onPoint?: (point: 'backed-up' | 'marked' | 'deleted') => void,
  ): { reset: true; backup: string; files: number } {
    const release = acquireFileLeaseSync(join(this.directory, 'key-maintenance'));
    try {
      return this.reset(input, release, onPoint);
    } finally {
      release();
    }
  }

  private reset(
    input: { instanceId: string; target: string; yes: boolean },
    release: () => void,
    onPoint?: (point: 'backed-up' | 'marked' | 'deleted') => void,
  ): { reset: true; backup: string; files: number } {
    const directory = realpathSync(this.directory);
    const workspace = realpathSync(this.workspace);
    const within = (root: string, path: string) => {
      const part = relative(root, path);
      return part === '' || (!part.startsWith(`..${sep}`) && part !== '..' && !isAbsolute(part));
    };
    if (
      !input.yes ||
      input.instanceId !== this.registry.status().instanceId ||
      resolve(input.target) !== workspace ||
      directory === parse(directory).root ||
      workspace === parse(workspace).root ||
      within(directory, workspace) ||
      within(workspace, directory) ||
      within(workspace, dirname(directory))
    ) {
      throw new SecurityError('SECURITY_CONFIRMATION_REQUIRED');
    }
    // Reject junctions in every supplied path component, including the target itself.
    const noLinks = (path: string): void => {
      for (let entry = resolve(path); ; entry = dirname(entry)) {
        if (lstatSync(entry).isSymbolicLink()) {
          throw new SecurityError('SECURITY_INVALID_REQUEST');
        }
        if (dirname(entry) === entry) {
          break;
        }
      }
    };
    noLinks(this.directory);
    noLinks(this.workspace);
    noLinks(input.target);
    const backupDirectory = join(dirname(directory), 'reset-backups');
    if (
      within(workspace, backupDirectory) ||
      within(backupDirectory, workspace) ||
      within(directory, backupDirectory)
    ) {
      throw new SecurityError('SECURITY_INVALID_REQUEST');
    }
    if (existsSync(backupDirectory)) {
      noLinks(backupDirectory);
    }
    const scan = (root: string) => {
      const files: string[] = [];
      const directories: string[] = [];
      let bytes = 0;
      const visit = (path: string): void => {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) {
          throw new SecurityError('SECURITY_INVALID_REQUEST');
        }
        if (stat.isDirectory()) {
          if (directories.length >= 10000 || relative(root, path).split(sep).length > 128) {
            throw new SecurityError('SECURITY_RESPONSE_LIMIT');
          }
          directories.push(path);
          for (const name of readdirSync(path)) {
            visit(join(path, name));
          }
        } else if (stat.isFile()) {
          if (
            root === directory &&
            dirname(path) === directory &&
            /^(instance-owner|key-maintenance)\.(lock|reclaim)$/.test(basename(path))
          ) {
            return;
          }
          bytes += stat.size;
          if (bytes > MAX_RESET_BYTES || files.length >= 10000) {
            throw new SecurityError('SECURITY_RESPONSE_LIMIT');
          }
          files.push(path);
        } else {
          throw new SecurityError('SECURITY_INVALID_REQUEST');
        }
      };
      visit(root);
      return { files, directories, bytes };
    };
    const firstData = scan(workspace);
    const firstSecurity = scan(directory);
    if (firstData.bytes + firstSecurity.bytes > MAX_RESET_BYTES) {
      throw new SecurityError('SECURITY_RESPONSE_LIMIT');
    }
    this.registry.recordMaintenance('factory.reset.prepared');
    this.registry.recordMaintenance('factory.reset.started');
    const data = scan(workspace);
    const security = scan(directory);
    if (
      data.bytes + security.bytes > MAX_RESET_BYTES ||
      data.files.length + security.files.length > 10000
    ) {
      throw new SecurityError('SECURITY_RESPONSE_LIMIT');
    }
    const records = [
      ...data.files.map((path) => ({
        path,
        root: 'workspace',
        relative: relative(workspace, path),
      })),
      ...security.files.map((path) => ({
        path,
        root: 'security',
        relative: relative(directory, path),
      })),
    ];
    let totalBytes = 0;
    const content = records.map((record) => {
      noLinks(record.path);
      const bytes = readFileSync(record.path);
      totalBytes += bytes.length;
      if (totalBytes > MAX_RESET_BYTES) {
        throw new SecurityError('SECURITY_RESPONSE_LIMIT');
      }
      return {
        root: record.root,
        relative: record.relative,
        hash: digest(bytes),
        data: bytes.toString('base64'),
      };
    });
    this.protector.ensureDirectory(backupDirectory);
    noLinks(backupDirectory);
    const backup = join(backupDirectory, `${randomUUID()}.mdreset`);
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const instanceId = input.instanceId;
    const plaintext = Buffer.from(JSON.stringify({ version: 1, instanceId, workspace, content }));
    try {
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(`modeldb-reset-v1:${instanceId}`));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const archive = {
        version: 1,
        instanceId,
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        key: this.protector.protect(key, `modeldb-reset-v1:${instanceId}`),
        ciphertext: ciphertext.toString('base64'),
      };
      const validate = (bytes: Buffer): void => {
        const parsed = JSON.parse(bytes.toString()) as typeof archive;
        const backupKey = this.protector.unprotect(parsed.key, `modeldb-reset-v1:${instanceId}`);
        let verified: Buffer | undefined;
        try {
          const decipher = createDecipheriv(
            'aes-256-gcm',
            backupKey,
            Buffer.from(parsed.iv, 'base64'),
          );
          decipher.setAAD(Buffer.from(`modeldb-reset-v1:${instanceId}`));
          decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
          verified = Buffer.concat([
            decipher.update(Buffer.from(parsed.ciphertext, 'base64')),
            decipher.final(),
          ]);
          if (!verified.equals(plaintext)) {
            throw new Error();
          }
        } finally {
          backupKey.fill(0);
          verified?.fill(0);
        }
      };
      writeAtomicFileSync(backup, Buffer.from(JSON.stringify(archive)), null, validate);
      validate(readFileSync(backup));
    } catch {
      throw new SecurityError('SECURITY_MAINTENANCE_FAILED');
    } finally {
      key.fill(0);
      plaintext.fill(0);
    }
    onPoint?.('backed-up');
    // A durable tombstone blocks startup after any interrupted deletion. Backup remains outside both targets.
    const marker = join(dirname(directory), 'security-reset.pending');
    if (existsSync(marker)) {
      throw new SecurityError('SECURITY_MAINTENANCE_FAILED');
    }
    writeAtomicFileSync(
      marker,
      Buffer.from(JSON.stringify({ version: 1, instanceId, workspace, backup })),
      null,
      () => undefined,
    );
    onPoint?.('marked');
    for (let i = 0; i < records.length; i++) {
      noLinks(records[i]!.path);
      if (digest(readFileSync(records[i]!.path)) !== content[i]!.hash) {
        throw new SecurityError('SECURITY_MAINTENANCE_FAILED');
      }
    }
    for (let i = 0; i < records.length; i++) {
      const record = records[i]!;
      noLinks(record.path);
      if (digest(readFileSync(record.path)) !== content[i]!.hash) {
        throw new SecurityError('SECURITY_MAINTENANCE_FAILED');
      }
      unlinkSync(record.path);
      onPoint?.('deleted');
    }
    this.registry.close();
    release();
    for (const root of [data, security]) {
      for (const path of root.directories.reverse()) {
        if (readdirSync(path).length !== 0) {
          throw new SecurityError('SECURITY_MAINTENANCE_FAILED');
        }
        rmdirSync(path);
      }
    }
    writeAtomicFileSync(
      `${backup}.receipt`,
      Buffer.from(
        JSON.stringify({ version: 1, instanceId, result: 'completed', files: records.length }),
      ),
      null,
      () => undefined,
    );
    unlinkSync(marker);
    return { reset: true, backup, files: records.length };
  }
}

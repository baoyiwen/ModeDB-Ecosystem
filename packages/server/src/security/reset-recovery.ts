import { createDecipheriv, createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { acquireFileLeaseSync, readAtomicFileSync, writeAtomicFileSync } from '@mode-db/common';
import { SecurityError } from './security-errors.js';
import { WindowsSecretProtector, type SecretProtector } from './windows-secret-protector.js';

const MAX_BYTES = 128 * 1024 * 1024;
const MAX_ARCHIVE = 240 * 1024 * 1024;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const fail = (): never => {
  throw new SecurityError('SECURITY_MAINTENANCE_FAILED');
};
const check = (condition: unknown): void => {
  if (!condition) {
    fail();
  }
};
const ownsLock = (name: string) => /^(instance-owner|key-maintenance)\.(lock|reclaim)$/.test(name);
const inside = (root: string, target: string) => {
  const part = relative(root, target);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep));
};
function noLinks(path: string): string {
  const full = resolve(path);
  for (let at = full; ; at = dirname(at)) {
    try {
      check(!lstatSync(at).isSymbolicLink());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    if (dirname(at) === at) {
      break;
    }
  }
  return full;
}
function read(path: string, max: number): Buffer {
  noLinks(path);
  check(lstatSync(path).isFile() && lstatSync(path).size <= max);
  const bytes = readFileSync(path);
  check(bytes.length <= max);
  return bytes;
}
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  check(value && typeof value === 'object' && !Array.isArray(value));
  const obj = value as Record<string, unknown>;
  check(Object.keys(obj).sort().join() === [...keys].sort().join());
  return obj;
}
function base64(value: unknown, max: number, size?: number): Buffer {
  check(typeof value === 'string' && value.length <= Math.ceil(max / 3) * 4);
  const bytes = Buffer.from(value as string, 'base64');
  check(
    bytes.toString('base64') === value &&
      bytes.length <= max &&
      (size === undefined || bytes.length === size),
  );
  return bytes;
}
interface Entry {
  root: 'workspace' | 'security';
  relative: string;
  hash: string;
  bytes: Buffer;
}
interface Archive {
  instanceId: string;
  workspace: string;
  digest: string;
  entries: Entry[];
}

/** Authenticate the old v1 reset archive; its paths never choose a write/delete target. */
function openArchive(path: string, protector: SecretProtector): Archive {
  const bytes = read(path, MAX_ARCHIVE);
  const pkg = exact(JSON.parse(bytes.toString('utf8')), [
    'version',
    'instanceId',
    'iv',
    'tag',
    'key',
    'ciphertext',
  ]);
  check(
    pkg.version === 1 &&
      typeof pkg.instanceId === 'string' &&
      /^[A-Za-z0-9_-]{1,96}$/.test(pkg.instanceId),
  );
  check(typeof pkg.key === 'string' && pkg.key.length <= 16384);
  const key = protector.unprotect(pkg.key as string, `modeldb-reset-v1:${pkg.instanceId}`);
  let plaintext: Buffer | undefined;
  const entries: Entry[] = [];
  try {
    check(key.length === 32);
    const cipher = createDecipheriv('aes-256-gcm', key, base64(pkg.iv, 12, 12));
    cipher.setAAD(Buffer.from(`modeldb-reset-v1:${pkg.instanceId}`));
    cipher.setAuthTag(base64(pkg.tag, 16, 16));
    plaintext = Buffer.concat([
      cipher.update(base64(pkg.ciphertext, 180 * 1024 * 1024)),
      cipher.final(),
    ]);
    const body = exact(JSON.parse(plaintext.toString('utf8')), [
      'version',
      'instanceId',
      'workspace',
      'content',
    ]);
    check(
      body.version === 1 &&
        body.instanceId === pkg.instanceId &&
        typeof body.workspace === 'string' &&
        isAbsolute(body.workspace),
    );
    check(Array.isArray(body.content) && body.content.length <= 10000);
    const names = new Set<string>();
    let total = 0;
    for (const raw of body.content as unknown[]) {
      const row = exact(raw, ['root', 'relative', 'hash', 'data']);
      check(row.root === 'workspace' || row.root === 'security');
      check(
        typeof row.relative === 'string' && row.relative.length > 0 && row.relative.length <= 32767,
      );
      const parts = (row.relative as string).split(/[\\/]/);
      check(
        parts.length <= 128 &&
          parts.every(
            (part) =>
              part.length > 0 &&
              part !== '.' &&
              part !== '..' &&
              !/[<>:"|?*\x00-\x1f]/.test(part) &&
              !/[. ]$/.test(part) &&
              !/^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/i.test(part),
          ),
      );
      const name = parts.join(sep);
      check(row.root !== 'security' || (parts.length === 1 && !ownsLock(name)));
      const identity = row.root + ':' + name.toLowerCase();
      check(!names.has(identity));
      names.add(identity);
      const data = base64(row.data, MAX_BYTES);
      total += data.length;
      check(
        total <= MAX_BYTES &&
          typeof row.hash === 'string' &&
          /^[a-f0-9]{64}$/.test(row.hash) &&
          hash(data) === row.hash,
      );
      entries.push({
        root: row.root as Entry['root'],
        relative: name,
        hash: row.hash as string,
        bytes: data,
      });
    }
    for (const name of names) {
      const [root, ...tail] = name.split(':');
      let at = tail.join(':');
      while (dirname(at) !== '.') {
        at = dirname(at);
        check(!names.has(root + ':' + at));
      }
    }
    return {
      instanceId: pkg.instanceId as string,
      workspace: resolve(body.workspace as string),
      digest: hash(bytes),
      entries,
    };
  } catch (error) {
    for (const entry of entries) {
      entry.bytes.fill(0);
    }
    throw error;
  } finally {
    key.fill(0);
    plaintext?.fill(0);
  }
}
export interface ResetRecoveryInput {
  readonly directory: string;
  readonly workspace: string;
  readonly instanceId: string;
  readonly archive: string;
  readonly yes: boolean;
}
function openProtectedArchive(
  input: Omit<ResetRecoveryInput, 'yes'>,
  protector: SecretProtector,
): Archive {
  const backup = noLinks(input.archive),
    directory = noLinks(input.directory);
  check(
    dirname(backup) === join(dirname(directory), 'reset-backups') &&
      /^[0-9a-f-]{36}\.mdreset$/i.test(basename(backup)),
  );
  // Verification never creates a missing archive directory or changes its ACL.
  check(lstatSync(backup).isFile());
  protector.ensureDirectory(dirname(backup));
  return openArchive(backup, protector);
}
function confirmed(
  input: ResetRecoveryInput,
  archive: Archive,
): { directory: string; workspace: string; backup: string } {
  const directory = noLinks(input.directory),
    workspace = noLinks(input.workspace),
    backup = noLinks(input.archive);
  if (
    !input.yes ||
    input.instanceId !== archive.instanceId ||
    workspace !== archive.workspace ||
    directory === parse(directory).root ||
    workspace === parse(workspace).root ||
    inside(workspace, directory) ||
    inside(directory, workspace) ||
    inside(workspace, dirname(directory)) ||
    inside(directory, backup) ||
    inside(workspace, backup)
  ) {
    throw new SecurityError('SECURITY_CONFIRMATION_REQUIRED');
  }
  check(
    dirname(backup) === join(dirname(directory), 'reset-backups') &&
      /^[0-9a-f-]{36}\.mdreset$/i.test(basename(backup)),
  );
  return { directory, workspace, backup };
}
function erase(archive: Archive): void {
  for (const entry of archive.entries) {
    entry.bytes.fill(0);
  }
}

/** Only accepts the exact configured target and authenticates all remaining files before deletion. */
export function resumeFactoryReset(
  input: ResetRecoveryInput,
  protector: SecretProtector = new WindowsSecretProtector(),
  onPoint?: (point: string) => void,
) {
  let archive: Archive | undefined;
  const releases: (() => void)[] = [];
  try {
    archive = openProtectedArchive(input, protector);
    const { directory, workspace, backup } = confirmed(input, archive);
    const marker = join(dirname(directory), 'security-reset.pending');
    const validate = (bytes: Buffer) => {
      const value = exact(JSON.parse(bytes.toString('utf8')), [
        'version',
        'instanceId',
        'workspace',
        'backup',
      ]);
      check(
        value.version === 1 &&
          value.instanceId === input.instanceId &&
          value.workspace === workspace &&
          value.backup === backup,
      );
    };
    releases.push(acquireFileLeaseSync(join(dirname(backup), 'reset-recovery')));
    if (existsSync(directory)) {
      protector.ensureDirectory(directory);
      releases.push(acquireFileLeaseSync(join(directory, 'instance-owner')));
      releases.push(acquireFileLeaseSync(join(directory, 'key-maintenance')));
    }
    // A dead initial writer may have stopped before its first marker intent. Authenticate
    // that precise candidate before promoting it; deletion cannot yet have started.
    if (!existsSync(marker) && existsSync(marker + '.pending') && !existsSync(marker + '.commit')) {
      validate(read(marker + '.pending', 65536));
      renameSync(marker + '.pending', marker);
    }
    noLinks(marker);
    if (!readAtomicFileSync(marker, validate)) {
      fail();
    }
    const remaining: { path: string; expected: Entry }[] = [];
    const directories: string[] = [];
    let count = 0;
    for (const [kind, root] of [
      ['workspace', workspace],
      ['security', directory],
    ] as const) {
      const expected = new Map(
        archive.entries
          .filter((e) => e.root === kind)
          .map((e) => [resolve(root, e.relative).toLowerCase(), e]),
      );
      const walk = (at: string, depth: number): void => {
        noLinks(at);
        const stat = lstatSync(at);
        check(++count <= 30000 && depth <= 128);
        if (stat.isDirectory()) {
          directories.push(at);
          for (const name of readdirSync(at)) {
            walk(join(at, name), depth + 1);
          }
        } else {
          check(stat.isFile());
          if (kind === 'security' && dirname(at) === directory && ownsLock(basename(at))) {
            return;
          }
          const entry = expected.get(at.toLowerCase());
          check(entry && hash(read(at, MAX_BYTES)) === entry.hash);
          remaining.push({ path: at, expected: entry! });
        }
      };
      if (existsSync(root)) {
        walk(root, 0);
      }
    }
    onPoint?.('verified');
    for (const file of remaining) {
      check(hash(read(file.path, MAX_BYTES)) === file.expected.hash);
      unlinkSync(file.path);
      onPoint?.('deleted');
    }
    while (releases.length > 1) {
      releases.pop()!();
    }
    for (const dir of directories.reverse()) {
      check(readdirSync(dir).length === 0);
      rmdirSync(dir);
    }
    onPoint?.('removed');
    const receipt = Buffer.from(
      JSON.stringify({
        version: 1,
        instanceId: input.instanceId,
        result: 'completed',
        files: archive.entries.length,
      }),
    );
    if (existsSync(backup + '.receipt')) {
      check(read(backup + '.receipt', 65536).equals(receipt));
    } else {
      if (existsSync(backup + '.receipt.pending') && !existsSync(backup + '.receipt.commit')) {
        check(read(backup + '.receipt.pending', 65536).equals(receipt));
        renameSync(backup + '.receipt.pending', backup + '.receipt');
      } else {
        const previous = readAtomicFileSync(backup + '.receipt', (bytes) =>
          check(bytes.equals(receipt)),
        );
        if (!previous) {
          writeAtomicFileSync(backup + '.receipt', receipt, null, (bytes) =>
            check(bytes.equals(receipt)),
          );
        }
      }
    }
    onPoint?.('receipted');
    unlinkSync(marker);
    return { reset: true, backup, files: archive.entries.length };
  } catch (error) {
    if (error instanceof SecurityError) {
      throw error;
    }
    throw new SecurityError('SECURITY_MAINTENANCE_FAILED');
  } finally {
    while (releases.length) {
      releases.pop()!();
    }
    if (archive) {
      erase(archive);
    }
  }
}

export function verifyResetArchive(
  input: Omit<ResetRecoveryInput, 'yes'>,
  protector: SecretProtector = new WindowsSecretProtector(),
) {
  let archive: Archive | undefined;
  try {
    archive = openProtectedArchive(input, protector);
    confirmed({ ...input, yes: true }, archive);
    return {
      verified: true,
      instanceId: archive.instanceId,
      archiveDigest: archive.digest,
      files: archive.entries.length,
      bytes: archive.entries.reduce((sum, entry) => sum + entry.bytes.length, 0),
    };
  } catch (error) {
    if (error instanceof SecurityError) {
      throw error;
    }
    throw new SecurityError('SECURITY_MAINTENANCE_FAILED');
  } finally {
    if (archive) {
      erase(archive);
    }
  }
}

/** Recover data/keys into a new quarantine tree; never replay the archived access ledger. */
export function restoreResetArchive(
  input: ResetRecoveryInput & { readonly output: string },
  protector: SecretProtector = new WindowsSecretProtector(),
  onPoint?: (point: string) => void,
) {
  let archive: Archive | undefined;
  let release: (() => void) | undefined;
  try {
    archive = openProtectedArchive(input, protector);
    const { directory, workspace, backup } = confirmed(input, archive);
    const output = noLinks(input.output);
    check(
      !existsSync(output) &&
        !inside(workspace, output) &&
        !inside(directory, output) &&
        !inside(output, workspace) &&
        !inside(output, directory) &&
        !inside(output, backup),
    );
    // The lease lives in the protected archive directory, so abandoned output is
    // preserved without becoming a writable lock or an executable instance.
    release = acquireFileLeaseSync(join(dirname(backup), 'reset-recovery'));
    protector.ensureDirectory(output);
    const marker = join(output, 'security-reset.pending');
    const state = Buffer.from(
      JSON.stringify({
        version: 1,
        sourceInstanceId: archive.instanceId,
        archiveDigest: archive.digest,
        result: 'restoring',
      }),
    );
    writeAtomicFileSync(marker, state, null, (bytes) => check(bytes.equals(state)));
    const targetSecurity = join(output, 'security'),
      targetWorkspace = join(output, 'workspace');
    protector.ensureDirectory(targetSecurity);
    mkdirSync(targetWorkspace, { mode: 0o700 });
    let files = 0;
    for (const entry of archive.entries) {
      if (entry.root === 'security' && /^(registry\.(mds|ready))($|\.)/i.test(entry.relative)) {
        continue;
      }
      const root = entry.root === 'security' ? targetSecurity : targetWorkspace;
      const path = noLinks(join(root, entry.relative));
      check(inside(root, path));
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeAtomicFileSync(path, entry.bytes, null, (bytes) => check(hash(bytes) === entry.hash));
      files++;
      onPoint?.('restored');
    }
    // Source credentials, sessions and network state are excluded with registry.mds.
    const receipt = Buffer.from(
      JSON.stringify({
        version: 1,
        sourceInstanceId: archive.instanceId,
        archiveDigest: archive.digest,
        result: 'restored',
        files,
        accessLedger: 'excluded',
      }),
    );
    writeAtomicFileSync(join(output, 'reset-restore.receipt'), receipt, null, (bytes) =>
      check(bytes.equals(receipt)),
    );
    unlinkSync(marker);
    return {
      restored: true,
      workspace: targetWorkspace,
      securityDirectory: targetSecurity,
      files,
      accessLedger: 'excluded' as const,
    };
  } catch (error) {
    if (error instanceof SecurityError) {
      throw error;
    }
    throw new SecurityError('SECURITY_MAINTENANCE_FAILED');
  } finally {
    release?.();
    if (archive) {
      erase(archive);
    }
  }
}

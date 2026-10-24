import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { VaultSecurityError } from './vault-keys.js';

/** Durable points exposed for deterministic process/disk failure tests. */
export type AtomicCommitPoint = 'staged' | 'journaled' | 'replaced';

/** Digest used for optimistic write ownership, not as a replacement for AEAD. */
export function fileDigest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function syncDirectory(path: string): void {
  // Windows does not expose POSIX directory fsync through Node. File handles
  // are flushed; the journal remains recoverable across process interruption.
  if (process.platform === 'win32') {
    return;
  }
  const fd = openSync(dirname(path), 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function durableWrite(path: string, bytes: Uint8Array | string): void {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Hold a process-owned file lease until release; never reclaim a live PID. */
export function acquireFileLeaseSync(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (const candidate of [
    path,
    `${path}.pending`,
    `${path}.commit`,
    `${path}.lock`,
    `${path}.reclaim`,
  ]) {
    if (
      existsSync(candidate) &&
      (!lstatSync(candidate).isFile() || lstatSync(candidate).isSymbolicLink())
    ) {
      throw new VaultSecurityError('VAULT_COMMIT_INCOMPLETE');
    }
  }
  const lock = `${path}.lock`;
  const owner = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  if (existsSync(lock)) {
    // Only one contender may reclaim a dead owner's lock. An interrupted
    // reclamation fails closed; never guess ownership from an elapsed timeout.
    const reclaim = `${path}.reclaim`;
    try {
      durableWrite(reclaim, owner);
    } catch {
      throw new VaultSecurityError('VAULT_COMMIT_CONFLICT');
    }
    try {
      const previous = readFileSync(lock, 'utf8');
      const parsed = JSON.parse(previous) as { pid?: number };
      if (!Number.isSafeInteger(parsed.pid) || parsed.pid! <= 0) {
        throw new VaultSecurityError('VAULT_COMMIT_INCOMPLETE');
      }
      try {
        process.kill(parsed.pid!, 0);
        throw new VaultSecurityError('VAULT_COMMIT_CONFLICT');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          throw error;
        }
      }
      if (readFileSync(lock, 'utf8') !== previous) {
        throw new VaultSecurityError('VAULT_COMMIT_CONFLICT');
      }
      unlinkSync(lock);
    } catch (error) {
      if (error instanceof VaultSecurityError) {
        throw error;
      }
      throw new VaultSecurityError('VAULT_COMMIT_CONFLICT');
    } finally {
      if (existsSync(reclaim) && readFileSync(reclaim, 'utf8') === owner) {
        unlinkSync(reclaim);
      }
    }
  }
  if (existsSync(`${path}.reclaim`)) {
    throw new VaultSecurityError('VAULT_COMMIT_INCOMPLETE');
  }
  try {
    durableWrite(lock, owner);
  } catch {
    throw new VaultSecurityError('VAULT_COMMIT_CONFLICT');
  }
  return () => {
    if (existsSync(lock) && readFileSync(lock, 'utf8') === owner) {
      unlinkSync(lock);
    }
  };
}

function withLock<T>(path: string, body: () => T): T {
  const release = acquireFileLeaseSync(path);
  try {
    return body();
  } finally {
    release();
  }
}

function recover(path: string, validate: (bytes: Buffer) => void): Buffer | undefined {
  const stagedPath = `${path}.pending`;
  const journalPath = `${path}.commit`;
  let current = existsSync(path) ? readFileSync(path) : undefined;
  if (existsSync(journalPath)) {
    let journal: { version: number; previous: string | null; next: string };
    try {
      const raw = readFileSync(journalPath);
      if (raw.length > 1024) {
        throw new Error();
      }
      journal = JSON.parse(raw.toString('utf8')) as typeof journal;
      if (
        journal.version !== 1 ||
        !/^[a-f0-9]{64}$/.test(journal.next) ||
        (journal.previous !== null && !/^[a-f0-9]{64}$/.test(journal.previous))
      ) {
        throw new Error();
      }
    } catch {
      throw new VaultSecurityError('VAULT_COMMIT_INCOMPLETE');
    }
    if (!current || fileDigest(current) !== journal.next) {
      if ((current ? fileDigest(current) : null) !== journal.previous || !existsSync(stagedPath)) {
        throw new VaultSecurityError('VAULT_COMMIT_INCOMPLETE');
      }
      const staged = readFileSync(stagedPath);
      if (fileDigest(staged) !== journal.next) {
        throw new VaultSecurityError('VAULT_COMMIT_INCOMPLETE');
      }
      validate(staged);
      renameSync(stagedPath, path);
      syncDirectory(path);
      current = staged;
    } else {
      validate(current);
      if (existsSync(stagedPath)) {
        unlinkSync(stagedPath);
      }
    }
    unlinkSync(journalPath);
    syncDirectory(path);
  } else if (existsSync(stagedPath)) {
    if (!current) {
      throw new VaultSecurityError('VAULT_COMMIT_INCOMPLETE');
    }
    validate(current);
    unlinkSync(stagedPath);
  }
  if (current) {
    validate(current);
  }
  return current;
}

/** Read and recover a journaled file, validating bytes before any replacement. */
export function readAtomicFileSync(
  path: string,
  validate: (bytes: Buffer) => void,
): Buffer | undefined {
  try {
    return withLock(path, () => recover(path, validate));
  } catch (error) {
    if (error instanceof VaultSecurityError) {
      throw error;
    }
    throw new VaultSecurityError('VAULT_COMMIT_INCOMPLETE');
  }
}

/** Commit flushed stage/intent via same-directory rename; reject stale writers. */
export function writeAtomicFileSync(
  path: string,
  bytes: Buffer,
  expectedDigest: string | null,
  validate: (bytes: Buffer) => void,
  onPoint?: (point: AtomicCommitPoint) => void,
): void {
  try {
    withLock(path, () => {
      const current = recover(path, validate);
      if ((current ? fileDigest(current) : null) !== expectedDigest) {
        throw new VaultSecurityError('VAULT_COMMIT_CONFLICT');
      }
      validate(bytes);
      durableWrite(`${path}.pending`, bytes);
      onPoint?.('staged');
      durableWrite(
        `${path}.commit`,
        JSON.stringify({ version: 1, previous: expectedDigest, next: fileDigest(bytes) }),
      );
      syncDirectory(path);
      onPoint?.('journaled');
      renameSync(`${path}.pending`, path);
      syncDirectory(path);
      onPoint?.('replaced');
      unlinkSync(`${path}.commit`);
      syncDirectory(path);
    });
  } catch (error) {
    if (error instanceof VaultSecurityError) {
      throw error;
    }
    throw new VaultSecurityError('VAULT_WRITE_FAILED');
  }
}

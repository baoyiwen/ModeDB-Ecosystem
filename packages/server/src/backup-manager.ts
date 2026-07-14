import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { assertFlatGraphSegment } from '@mode-db/common';

export interface ModelDbBackupFileEntry {
  readonly path: string;
  readonly encoding: 'base64';
  readonly data: string;
}

export interface ModelDbBackupPayload {
  readonly format: 'modeldb.backup.v1';
  readonly database: string;
  readonly createdAt: string;
  readonly kind: 'nested' | 'flat';
  readonly files: readonly ModelDbBackupFileEntry[];
}

export interface ModelDbBackupInfo {
  readonly fileName: string;
  readonly database: string;
  readonly createdAt: string;
  readonly bytes: number;
  readonly path: string;
}

function backupRoot(workspaceRoot: string): string {
  return join(workspaceRoot, 'modeldb', 'backups');
}

function safeTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

function safeFilePart(value: string, fallback: string): string {
  const safe = value
    .trim()
    .replace(/[^A-Za-z0-9_.-]/g, '_')
    .replace(/_+/g, '_');
  return safe || fallback;
}

function assertSafeBackupFileName(fileName: string): void {
  if (!/^[A-Za-z0-9_.-]+\.modeldb-backup\.json$/.test(fileName)) {
    throw new Error('Invalid backup file name.');
  }
}

function validateBackupPayload(payload: ModelDbBackupPayload): ModelDbBackupPayload {
  if (
    payload.format !== 'modeldb.backup.v1' ||
    typeof payload.database !== 'string' ||
    typeof payload.createdAt !== 'string' ||
    (payload.kind !== 'nested' && payload.kind !== 'flat') ||
    !Array.isArray(payload.files)
  ) {
    throw new Error('Invalid ModelDB backup file.');
  }
  assertFlatGraphSegment(payload.database, 'backup database name');
  if (!Number.isFinite(Date.parse(payload.createdAt))) {
    throw new Error('Invalid ModelDB backup creation time.');
  }
  for (const file of payload.files) {
    if (
      !file ||
      typeof file.path !== 'string' ||
      file.encoding !== 'base64' ||
      typeof file.data !== 'string'
    ) {
      throw new Error('Invalid ModelDB backup file entry.');
    }
    targetRelativePath(file.path, payload.database, payload.database);
  }
  return payload;
}

function parseBackupPayload(text: string): ModelDbBackupPayload {
  try {
    return validateBackupPayload(JSON.parse(text) as ModelDbBackupPayload);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('Invalid ModelDB backup JSON.');
    }
    throw error;
  }
}

function databasePaths(
  workspaceRoot: string,
  database: string,
): {
  readonly kind: 'nested' | 'flat';
  readonly rootPath: string;
} | null {
  const nested = join(workspaceRoot, database);
  const nestedVault = join(nested, 'atlas.mld');
  if (existsSync(nestedVault)) {
    return { kind: 'nested', rootPath: nested };
  }
  const flat = join(workspaceRoot, `${database}.mld`);
  if (existsSync(flat)) {
    return { kind: 'flat', rootPath: flat };
  }
  return null;
}

function collectFiles(absPath: string, workspaceRoot: string): ModelDbBackupFileEntry[] {
  const st = statSync(absPath);
  if (st.isFile()) {
    const rel = relative(workspaceRoot, absPath).split(sep).join('/');
    return [{ path: rel, encoding: 'base64', data: readFileSync(absPath).toString('base64') }];
  }

  const out: ModelDbBackupFileEntry[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        const rel = relative(workspaceRoot, abs).split(sep).join('/');
        out.push({ path: rel, encoding: 'base64', data: readFileSync(abs).toString('base64') });
      }
    }
  };
  walk(absPath);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

function readBackupPayload(absPath: string): ModelDbBackupPayload {
  return parseBackupPayload(readFileSync(absPath, 'utf-8'));
}

function targetRelativePath(
  entryPath: string,
  sourceDatabase: string,
  targetDatabase: string,
): string {
  const normalized = entryPath.replace(/\\/g, '/');
  if (normalized === `${sourceDatabase}.mld`) {
    return `${targetDatabase}.mld`;
  }
  const prefix = `${sourceDatabase}/`;
  if (normalized.startsWith(prefix)) {
    const suffix = normalized.slice(prefix.length);
    const segments = suffix.split('/');
    if (
      segments.length === 0 ||
      segments.some(
        (segment) => !segment || segment === '.' || segment === '..' || segment.includes('\0'),
      )
    ) {
      throw new Error(`Backup entry "${entryPath}" contains an invalid relative path.`);
    }
    return `${targetDatabase}/${segments.join('/')}`;
  }
  throw new Error(`Backup entry "${entryPath}" does not belong to database "${sourceDatabase}".`);
}

function assertInsideWorkspace(workspaceRoot: string, target: string): void {
  const root = resolve(workspaceRoot);
  const abs = resolve(target);
  const rel = relative(root, abs);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    return;
  }
  throw new Error('Backup restore target escapes workspace root.');
}

export function createDatabaseBackup(
  workspaceRoot: string,
  database: string,
  reason = 'manual',
): ModelDbBackupInfo {
  const source = databasePaths(workspaceRoot, database);
  if (!source) {
    throw new Error(`Database "${database}" not found.`);
  }
  const root = backupRoot(workspaceRoot);
  mkdirSync(root, { recursive: true });
  const fileName = `${safeFilePart(database, 'database')}-${safeTimestamp()}-${safeFilePart(
    reason,
    'manual',
  )}.modeldb-backup.json`;
  const abs = join(root, fileName);
  const payload: ModelDbBackupPayload = {
    format: 'modeldb.backup.v1',
    database,
    createdAt: new Date().toISOString(),
    kind: source.kind,
    files: collectFiles(source.rootPath, workspaceRoot),
  };
  writeFileSync(abs, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  const st = statSync(abs);
  return { fileName, database, createdAt: payload.createdAt, bytes: st.size, path: abs };
}

export function listDatabaseBackups(
  workspaceRoot: string,
  database?: string,
): readonly ModelDbBackupInfo[] {
  const root = backupRoot(workspaceRoot);
  if (!existsSync(root)) {
    return [];
  }
  const out: ModelDbBackupInfo[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.modeldb-backup.json')) {
      continue;
    }
    const abs = join(root, entry.name);
    try {
      const payload = readBackupPayload(abs);
      if (database && payload.database !== database) {
        continue;
      }
      const st = statSync(abs);
      out.push({
        fileName: entry.name,
        database: payload.database,
        createdAt: payload.createdAt,
        bytes: st.size,
        path: abs,
      });
    } catch {
      continue;
    }
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return out;
}

export function readDatabaseBackupFile(
  workspaceRoot: string,
  backupFileName: string,
): { readonly info: ModelDbBackupInfo; readonly content: Buffer } {
  assertSafeBackupFileName(backupFileName);
  const abs = join(backupRoot(workspaceRoot), backupFileName);
  if (!existsSync(abs)) {
    throw new Error(`Backup "${backupFileName}" not found.`);
  }
  const payload = readBackupPayload(abs);
  const content = readFileSync(abs);
  return {
    info: {
      fileName: backupFileName,
      database: payload.database,
      createdAt: payload.createdAt,
      bytes: content.byteLength,
      path: abs,
    },
    content,
  };
}

export function importDatabaseBackup(
  workspaceRoot: string,
  requestedFileName: string,
  content: Uint8Array,
): ModelDbBackupInfo {
  if (content.byteLength === 0) {
    throw new Error('Backup file is empty.');
  }
  const payload = parseBackupPayload(Buffer.from(content).toString('utf-8'));
  const requestedBase = basename(requestedFileName.trim());
  const requestedStem = requestedBase.replace(/\.modeldb-backup\.json$/i, '');
  const fallbackStem = safeFilePart(payload.database, 'database');
  const safeStem = safeFilePart(requestedStem, fallbackStem);
  const preferredName = `${safeStem}.modeldb-backup.json`;
  assertSafeBackupFileName(preferredName);

  const root = backupRoot(workspaceRoot);
  mkdirSync(root, { recursive: true });
  let fileName = preferredName;
  if (existsSync(join(root, fileName))) {
    fileName = `${safeStem}-${safeTimestamp()}-imported.modeldb-backup.json`;
  }
  const abs = join(root, fileName);
  writeFileSync(abs, Buffer.from(content));
  const st = statSync(abs);
  return {
    fileName,
    database: payload.database,
    createdAt: payload.createdAt,
    bytes: st.size,
    path: abs,
  };
}

export function restoreDatabaseBackup(
  workspaceRoot: string,
  targetDatabase: string,
  backupFileName: string,
): ModelDbBackupInfo {
  assertSafeBackupFileName(backupFileName);
  const abs = join(backupRoot(workspaceRoot), backupFileName);
  if (!existsSync(abs)) {
    throw new Error(`Backup "${backupFileName}" not found.`);
  }
  const payload = readBackupPayload(abs);

  const nested = join(workspaceRoot, targetDatabase);
  const flat = join(workspaceRoot, `${targetDatabase}.mld`);
  if (existsSync(nested)) {
    rmSync(nested, { recursive: true, force: true });
  }
  if (existsSync(flat)) {
    rmSync(flat, { force: true });
  }

  for (const file of payload.files) {
    const rel = targetRelativePath(file.path, payload.database, targetDatabase);
    const target = join(workspaceRoot, rel);
    assertInsideWorkspace(workspaceRoot, target);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(file.data, 'base64'));
  }

  const st = statSync(abs);
  return {
    fileName: backupFileName,
    database: payload.database,
    createdAt: payload.createdAt,
    bytes: st.size,
    path: abs,
  };
}

export function forceResetDatabase(workspaceRoot: string, database: string): void {
  const nested = join(workspaceRoot, database);
  const flat = join(workspaceRoot, `${database}.mld`);
  if (existsSync(nested)) {
    rmSync(nested, { recursive: true, force: true });
  }
  if (existsSync(flat)) {
    rmSync(flat, { force: true });
  }
  mkdirSync(nested, { recursive: true });
}

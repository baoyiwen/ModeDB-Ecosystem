import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

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
  const payload = JSON.parse(readFileSync(absPath, 'utf-8')) as ModelDbBackupPayload;
  if (payload.format !== 'modeldb.backup.v1' || !Array.isArray(payload.files)) {
    throw new Error('Invalid ModelDB backup file.');
  }
  return payload;
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
    return `${targetDatabase}/${normalized.slice(prefix.length)}`;
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

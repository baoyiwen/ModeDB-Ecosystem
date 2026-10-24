/** Managed synthetic drill directories and non-secret evidence for the PowerShell entry point. */
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { arch, release, tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRecoveryDrillEntry } from './security-recovery-drill-entry.js';
import {
  prepareRecoveryDrill,
  recoveryDrillErrorCode,
  verifyRecoveryDrill,
} from './security-recovery-drill.js';
import { assertRecoveryPath } from '../packages/server/src/security/recovery-material.js';
import { WindowsSecretProtector } from '../packages/server/src/security/windows-secret-protector.js';

type Action = 'prepare' | 'receive' | 'verify';
const repository = fileURLToPath(new URL('../', import.meta.url));
const sessionFormat = 'modeldb.recovery-drill-session.v1';
const sourceTrees = [
  'packages/shared/src',
  'packages/common/src',
  'packages/core/authoring',
  'packages/core/facade',
  'packages/core/src',
  'packages/core/templates',
  'packages/server/src',
];
const packages = ['shared', 'common', 'core', 'server'];

function within(root: string, path: string): boolean {
  const part = relative(root, path);
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}

function fingerprint(trees: string[], files: string[], extension: string): string {
  const paths = [...files];
  function collect(directory: string): void {
    for (const entry of readdirSync(join(repository, directory)).sort()) {
      const path = `${directory}/${entry}`;
      const stat = lstatSync(join(repository, path));
      if (stat.isSymbolicLink()) {
        throw new Error('RECOVERY_DRILL_CODE_LINK_REJECTED');
      }
      if (stat.isDirectory()) {
        collect(path);
      } else if (entry.endsWith(extension) && stat.isFile()) {
        paths.push(path);
      }
    }
  }
  trees.forEach(collect);
  const hash = createHash('sha256');
  for (const path of paths.sort()) {
    const target = assertRecoveryPath(join(repository, path));
    if (!lstatSync(target).isFile()) {
      throw new Error('RECOVERY_DRILL_CODE_INVALID');
    }
    // Checkouts may use CRLF or LF; hashes compare logical code, excluding source maps.
    hash.update(path + '\0' + readFileSync(target, 'utf8').replace(/\r\n/g, '\n') + '\0');
  }
  return hash.digest('hex');
}

function evidence() {
  return {
    timestampUtc: new Date().toISOString(),
    platform: process.platform,
    windowsRelease: release(),
    architecture: arch(),
    nodeVersion: process.version,
    fingerprintScope: 'recovery-source-and-build-v1',
    sourceFingerprint: fingerprint(
      sourceTrees,
      [
        'scripts/security-recovery-drill.ts',
        'scripts/security-recovery-drill-runner.ts',
        'scripts/security-recovery-drill-entry.ts',
        'scripts/security-recovery-drill.ps1',
        'packages/core/index.ts',
        'package.json',
        'pnpm-lock.yaml',
        'tsconfig.json',
        ...packages.map((name) => `packages/${name}/package.json`),
      ],
      '.ts',
    ),
    buildFingerprint: fingerprint(
      packages.map((name) => `packages/${name}/dist`),
      [],
      '.js',
    ),
  };
}

function writeNewJson(path: string, value: unknown): void {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function runManagedRecoveryDrill(action: Action, requestedRoot?: string) {
  let step = 'preflight';
  let root: string | undefined;
  let writableReport = false;
  let environment: ReturnType<typeof evidence> | undefined;
  function saveReport(status: 'succeeded' | 'failed', result: unknown, errorCode?: string) {
    if (!root || !writableReport) {
      return undefined;
    }
    const path = join(root, `${action}-${Date.now()}-${randomUUID()}.json`);
    writeNewJson(path, {
      format: 'modeldb.recovery-drill-report.v1',
      action,
      status,
      step,
      ...environment,
      ...(errorCode ? { errorCode } : { result }),
    });
    return path;
  }
  try {
    if (process.platform !== 'win32') {
      throw new Error('RECOVERY_DRILL_WINDOWS_REQUIRED');
    }
    if (action === 'verify' && !requestedRoot) {
      throw new Error('RECOVERY_DRILL_ROOT_REQUIRED');
    }
    step = 'preflight.code-fingerprints';
    environment = evidence();
    step = 'session.root';
    if (requestedRoot && !isAbsolute(requestedRoot)) {
      throw new Error('RECOVERY_DRILL_ABSOLUTE_DIRECTORY_REQUIRED');
    }
    root = assertRecoveryPath(
      requestedRoot ?? join(tmpdir(), `ModeDB-Recovery-Drill-${randomUUID().replaceAll('-', '')}`),
    );
    if (within(repository, root) || within(root, repository)) {
      throw new Error('RECOVERY_DRILL_EXTERNAL_DIRECTORY_REQUIRED');
    }
    const sessionPath = join(root, 'drill-session.json');
    const fixture = join(root, 'fixture');
    const secret = join(root, 'secret', 'phrase.txt');
    if (action === 'verify') {
      const path = assertRecoveryPath(sessionPath);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096) {
        throw new Error('RECOVERY_DRILL_INVALID_SESSION');
      }
      const session = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      if (session.format !== sessionFormat || session.role !== 'receiver') {
        throw new Error('RECOVERY_DRILL_RECEIVER_REQUIRED');
      }
      writableReport = true;
    } else {
      // No recursive mkdir and no reuse: an old instance or failed run is never overwritten.
      mkdirSync(root);
      writableReport = true;
      writeNewJson(sessionPath, {
        format: sessionFormat,
        role: action === 'prepare' ? 'source' : 'receiver',
      });
    }
    let result: unknown;
    if (action === 'prepare') {
      result = prepareRecoveryDrill(fixture, secret, (current) => (step = current));
    } else if (action === 'receive') {
      step = 'receive.protected-directories';
      const protector = new WindowsSecretProtector();
      protector.ensureDirectory(fixture);
      protector.ensureDirectory(join(root, 'secret'));
      result = { readyToReceive: true };
    } else {
      result = verifyRecoveryDrill(fixture, secret, (current) => (step = current));
    }
    step = 'report.write';
    const report = saveReport('succeeded', result);
    return { ok: true as const, action, drillRoot: root, report, result };
  } catch (error) {
    const errorCode = recoveryDrillErrorCode(error);
    let report: string | undefined;
    try {
      report = saveReport('failed', undefined, errorCode);
    } catch {
      // Report failure must not turn a failed operation into success or expose OS error text.
    }
    return { ok: false as const, action, drillRoot: root, report, step, errorCode };
  }
}

if (isRecoveryDrillEntry(import.meta.url)) {
  const [action, flag, root] = process.argv.slice(2);
  if (
    !['prepare', 'receive', 'verify'].includes(action) ||
    (process.argv.length !== 3 &&
      !(process.argv.length === 5 && flag === '--root' && root.length > 0))
  ) {
    process.stdout.write(
      JSON.stringify({ ok: false, errorCode: 'RECOVERY_DRILL_INVALID_ARGUMENTS' }) + '\n',
    );
    process.exitCode = 1;
  } else {
    const result = runManagedRecoveryDrill(action as Action, root);
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exitCode = result.ok ? 0 : 1;
  }
}

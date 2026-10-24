/** Inspect build artifacts without importing server code or changing an existing build. */
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { arch, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const packageNames = ['shared', 'common', 'core', 'server'];

function codePath(path) {
  let current = repository;
  for (const part of path.split('/')) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error('RECOVERY_BUILD_CHECK_CODE_LINK_REJECTED');
    }
  }
  return current;
}

function readCode(path) {
  const target = codePath(path);
  if (!lstatSync(target).isFile()) {
    throw new Error('RECOVERY_BUILD_CHECK_CODE_INVALID');
  }
  return readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
}

function digest(text) {
  return createHash('sha256').update(text).digest('hex');
}

function inspectBuild() {
  const allFiles = [];
  const packages = packageNames.map((name) => {
    const paths = [];
    function collect(directory) {
      for (const entry of readdirSync(codePath(directory)).sort()) {
        const path = `${directory}/${entry}`;
        const stat = lstatSync(codePath(path));
        if (stat.isDirectory()) {
          collect(path);
        } else if (stat.isFile() && entry.endsWith('.js')) {
          paths.push(path);
        }
      }
    }
    collect(`packages/${name}/dist`);
    const hash = createHash('sha256');
    const files = paths.sort().map((path) => {
      const text = readCode(path);
      hash.update(`${path}\0${text}\0`);
      allFiles.push({ path, text });
      const source = path
        .replace('/dist/', name === 'core' ? '/' : '/src/')
        .replace(/\.js$/, '.ts');
      return { path, sha256: digest(text), sourceExists: existsSync(join(repository, source)) };
    });
    return {
      package: name,
      fileCount: files.length,
      fingerprint: hash.digest('hex'),
      extra: files.filter((file) => !file.sourceExists).map((file) => file.path),
      files,
    };
  });
  const buildHash = createHash('sha256');
  allFiles.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const { path, text } of allFiles) {
    buildHash.update(`${path}\0${text}\0`);
  }
  const configs = [
    'tsconfig.json',
    'packages/shared/tsconfig.json',
    'packages/shared/tsconfig.build.json',
    'packages/common/tsconfig.json',
    'packages/core/tsconfig.build.json',
    'packages/server/tsconfig.json',
  ].map((path) => ({ path, sha256: digest(readCode(path)) }));
  // Read only the installed compiler descriptor, including pnpm's dependency link.
  const compiler = JSON.parse(
    readFileSync(join(repository, 'node_modules/typescript/package.json'), 'utf8'),
  );
  return {
    format: 'modeldb.recovery-build-check.v1',
    timestampUtc: new Date().toISOString(),
    platform: process.platform,
    architecture: arch(),
    nodeVersion: process.version,
    typescriptVersion: compiler.version,
    fingerprintScope: 'recovery-source-and-build-v1',
    buildFingerprint: buildHash.digest('hex'),
    fileCount: allFiles.length,
    configs,
    packages,
  };
}

try {
  if (process.argv.length !== 2) {
    throw new Error('RECOVERY_BUILD_CHECK_NO_ARGUMENTS');
  }
  const result = inspectBuild();
  const directory = mkdtempSync(join(tmpdir(), 'ModeDB-Build-Check-'));
  const report = join(directory, 'build-check.json');
  writeFileSync(report, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        report,
        nodeVersion: result.nodeVersion,
        typescriptVersion: result.typescriptVersion,
        buildFingerprint: result.buildFingerprint,
        packages: result.packages.map(({ files: _files, ...summary }) => summary),
      },
      null,
      2,
    ) + '\n',
  );
} catch (error) {
  const message = error instanceof Error ? error.message : '';
  const errorCode = /^RECOVERY_BUILD_CHECK_[A-Z_]+$/.test(message)
    ? message
    : 'RECOVERY_BUILD_CHECK_FAILED';
  process.stderr.write(errorCode + '\n');
  process.exitCode = 1;
}

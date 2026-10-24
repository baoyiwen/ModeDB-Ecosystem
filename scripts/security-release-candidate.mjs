/** Build a local release candidate without reading instance state or reusing dist. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { minify } from 'terser';

const repository = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const names = ['shared', 'common', 'data-kit', 'data-ui', 'sdk', 'core', 'server'];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) =>
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });

function run(command, args, cwd, env = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `RELEASE_COMMAND_FAILED: ${command}\n${result.stdout ?? ''}${result.stderr ?? ''}`,
    );
  }
  return result.stdout;
}

function safeSource(path) {
  let current = repository;
  for (const part of path.split('/')) {
    current = join(current, part);
    assert.ok(!lstatSync(current).isSymbolicLink(), 'RELEASE_SOURCE_LINK_REJECTED');
  }
  return current;
}

function files(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = prefix + entry.name;
      assert.ok(!entry.isSymbolicLink(), 'RELEASE_OUTPUT_LINK_REJECTED');
      return entry.isDirectory() ? files(join(directory, entry.name), path + '/') : [path];
    })
    .sort();
}

function linkDependency(target, dependency, source) {
  const output = join(target, 'node_modules', dependency);
  if (existsSync(output)) {
    return;
  }
  mkdirSync(dirname(output), { recursive: true });
  symlinkSync(realpathSync(source), output, process.platform === 'win32' ? 'junction' : 'dir');
}

function installedDependency(from, dependency) {
  for (let directory = from; ; directory = dirname(directory)) {
    const candidate = join(directory, 'node_modules', dependency);
    if (existsSync(join(candidate, 'package.json'))) {
      return realpathSync(candidate);
    }
    if (dirname(directory) === directory) {
      return undefined;
    }
  }
}

// Snapshot installed third-party code into local tarballs, without lifecycle hooks,
// registry access, development dependencies or node_modules links inside archives.
function offlineDependencies(root, manifests) {
  const directory = join(root, 'offline-dependencies');
  mkdirSync(directory);
  const snapshots = new Map();
  const overrides = {};
  const peers = {};
  const developmentTypes = {};
  function visit(source) {
    const descriptor = json(join(source, 'package.json'));
    const key = `${descriptor.name}@${descriptor.version}`;
    if (snapshots.has(key)) {
      return snapshots.get(key);
    }
    const id = sha256(key).slice(0, 20);
    const packageRoot = join(directory, id, 'package');
    mkdirSync(packageRoot, { recursive: true });
    function copy(input, output) {
      for (const entry of readdirSync(input, { withFileTypes: true })) {
        if (['node_modules', '.git'].includes(entry.name)) {
          continue;
        }
        assert.ok(!entry.isSymbolicLink(), 'RELEASE_DEPENDENCY_LINK_REJECTED');
        const target = join(output, entry.name);
        if (entry.isDirectory()) {
          mkdirSync(target);
          copy(join(input, entry.name), target);
        } else if (entry.isFile()) {
          copyFileSync(join(input, entry.name), target);
        }
      }
    }
    copy(source, packageRoot);
    const archive = join(directory, id + '.tgz');
    run('tar', ['-czf', archive, '-C', dirname(packageRoot), 'package'], root);
    const snapshot = {
      name: descriptor.name,
      version: descriptor.version,
      archive: relative(root, archive).replaceAll('\\', '/'),
      sha256: sha256(readFileSync(archive)),
    };
    snapshots.set(key, snapshot);
    for (const dependency of Object.keys({
      ...descriptor.dependencies,
      ...descriptor.optionalDependencies,
    })) {
      const found = installedDependency(source, dependency);
      if (!found) {
        assert.ok(
          dependency in (descriptor.optionalDependencies ?? {}),
          `RELEASE_DEPENDENCY_MISSING: ${dependency}`,
        );
        continue;
      }
      const child = visit(found);
      overrides[`${key}>${dependency}`] = 'file:' + join(root, child.archive).replaceAll('\\', '/');
    }
    return snapshot;
  }
  for (const [name, descriptor] of Object.entries(manifests)) {
    for (const dependency of Object.keys({
      ...descriptor.dependencies,
      ...descriptor.optionalDependencies,
      ...descriptor.peerDependencies,
    })) {
      if (dependency.startsWith('@mode-db/')) {
        continue;
      }
      const found = installedDependency(join(repository, 'packages', name), dependency);
      assert.ok(found, `RELEASE_DEPENDENCY_MISSING: ${dependency}`);
      const snapshot = visit(found);
      const location = 'file:' + join(root, snapshot.archive).replaceAll('\\', '/');
      overrides[`${descriptor.name}@${descriptor.version}>${dependency}`] = location;
      if (dependency in (descriptor.peerDependencies ?? {})) {
        peers[dependency] = location;
      }
    }
  }
  for (const dependency of ['@types/node', '@types/ws', '@types/react', '@types/react-dom']) {
    const found = [
      join(repository, 'node_modules', dependency),
      join(repository, 'packages/data-ui/node_modules', dependency),
    ].find(existsSync);
    assert.ok(found, `RELEASE_CONSUMER_TYPES_MISSING: ${dependency}`);
    const snapshot = visit(realpathSync(found));
    const location = 'file:' + join(root, snapshot.archive).replaceAll('\\', '/');
    developmentTypes[dependency] = location;
    overrides[dependency] = location;
  }
  return { snapshots: [...snapshots.values()], overrides, peers, developmentTypes };
}

async function main() {
  assert.equal(process.argv.length, 2, 'RELEASE_NO_ARGUMENTS');
  const root = mkdtempSync(join(tmpdir(), 'ModeDB-Release-'));
  process.stdout.write(`ReleaseRoot: ${root}\n`);
  const stage = join(root, 'stage');
  const artifacts = join(root, 'artifacts');
  mkdirSync(stage);
  mkdirSync(artifacts);
  const pnpm =
    process.env.MODELDB_PNPM_CLI ??
    [
      process.env.npm_execpath,
      resolve(dirname(process.execPath), 'node_modules/pnpm/bin/pnpm.cjs'),
      resolve(dirname(process.execPath), 'node_modules/pnpm/bin/pnpm.mjs'),
      resolve(dirname(process.execPath), '../node_modules/pnpm/bin/pnpm.mjs'),
      join(repository, 'node_modules/pnpm/bin/pnpm.cjs'),
    ].find((path) => path && /pnpm\.(mjs|cjs|js)$/.test(path) && existsSync(path));
  assert.ok(pnpm && existsSync(pnpm), 'RELEASE_PNPM_CLI_REQUIRED');
  const inventory = run(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--exclude=/security/'],
    repository,
  ).split('\0');
  const manifests = Object.fromEntries(
    names.map((name) => [name, json(safeSource(`packages/${name}/package.json`))]),
  );
  const sources = [];
  for (const name of names) {
    const target = join(stage, 'packages', name);
    mkdirSync(target, { recursive: true });
    sources.push({
      path: `packages/${name}/package.json`,
      sha256: sha256(readFileSync(safeSource(`packages/${name}/package.json`))),
    });
    const manifest = structuredClone(manifests[name]);
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [dependency, version] of Object.entries(manifest[field] ?? {})) {
        if (version.startsWith('workspace:')) {
          const local = manifests[dependency.replace('@mode-db/', '')];
          assert.ok(local, 'RELEASE_UNKNOWN_WORKSPACE_DEPENDENCY');
          manifest[field][dependency] =
            version === 'workspace:^' ? '^' + local.version : local.version;
        }
      }
    }
    // Pack lifecycle must never invoke source builds or external publication.
    manifest.scripts = Object.fromEntries(
      Object.entries(manifest.scripts ?? {}).filter(([key]) =>
        ['postinstall', 'postuninstall'].includes(key),
      ),
    );
    delete manifest.devDependencies;
    save(join(target, 'package.json'), manifest);
    const allowed = [
      ...manifests[name].files.filter((path) => path !== 'dist'),
      'tsconfig.json',
      'tsconfig.build.json',
    ];
    if (name === 'server') {
      allowed.push('src');
    }
    if (name === 'data-ui') {
      allowed.push('scripts/copy-css.mjs');
    }
    const prefix = `packages/${name}/`;
    for (const path of inventory.filter((path) => path.startsWith(prefix))) {
      const local = path.slice(prefix.length);
      if (!allowed.some((item) => local === item || local.startsWith(item + '/'))) {
        continue;
      }
      assert.ok(
        !/(^|\/)(node_modules|dist|modeldb)(\/|$)/.test(local) ||
          local === 'templates/modeldb/AGENTS.md',
        'RELEASE_UNSAFE_INPUT',
      );
      const source = safeSource(path);
      if (!lstatSync(source).isFile()) {
        continue;
      }
      const output = join(target, local);
      mkdirSync(dirname(output), { recursive: true });
      copyFileSync(source, output);
      sources.push({ path, sha256: sha256(readFileSync(source)) });
    }
    for (const dependency of Object.keys({
      ...manifests[name].dependencies,
      ...manifests[name].optionalDependencies,
      ...manifests[name].peerDependencies,
      ...manifests[name].devDependencies,
    })) {
      const source = dependency.startsWith('@mode-db/')
        ? join(stage, 'packages', dependency.replace('@mode-db/', ''))
        : [
            join(repository, 'packages', name, 'node_modules', dependency),
            join(repository, 'node_modules', dependency),
          ].find(existsSync);
      // All local package directories exist before realpath is needed below.
      if (source && !dependency.startsWith('@mode-db/')) {
        linkDependency(target, dependency, source);
      }
    }
    for (const type of readdirSync(join(repository, 'node_modules/@types'))) {
      linkDependency(target, '@types/' + type, join(repository, 'node_modules/@types', type));
    }
  }
  for (const name of names) {
    for (const dependency of Object.keys(manifests[name].dependencies ?? {}).filter((name) =>
      name.startsWith('@mode-db/'),
    )) {
      linkDependency(
        join(stage, 'packages', name),
        dependency,
        join(stage, 'packages', dependency.replace('@mode-db/', '')),
      );
    }
  }
  const packages = [];
  const browserDependencies = [];
  for (const name of names) {
    process.stdout.write(`Building clean package: ${name}\n`);
    const target = join(stage, 'packages', name);
    const config = name === 'common' || name === 'server' ? 'tsconfig.json' : 'tsconfig.build.json';
    run(
      process.execPath,
      [join(repository, 'node_modules/typescript/bin/tsc'), '-p', join(target, config)],
      root,
    );
    if (name === 'data-ui') {
      run(process.execPath, [join(target, 'scripts/copy-css.mjs')], root);
    }
    const emitted = files(join(target, 'dist'));
    if (['sdk', 'data-kit', 'data-ui'].includes(name)) {
      for (const path of emitted) {
        const current = join(repository, 'packages', name, 'dist', path);
        assert.ok(
          existsSync(current) &&
            sha256(readFileSync(current)) === sha256(readFileSync(join(target, 'dist', path))),
          `RELEASE_BROWSER_DEPENDENCY_STALE: ${name}/${path}; run the workspace package build first`,
        );
        browserDependencies.push({
          path: `packages/${name}/dist/${path}`,
          sha256: sha256(readFileSync(current)),
        });
      }
    }
    if (['shared', 'common', 'core', 'server'].includes(name)) {
      const nameCache = {};
      for (const path of emitted.filter((path) => path.endsWith('.js'))) {
        const output = await minify(readFileSync(join(target, 'dist', path), 'utf8'), {
          module: true,
          ecma: 2022,
          compress: { passes: 3, pure_getters: true, unsafe: false },
          mangle: { module: true, toplevel: true },
          format: { comments: false, ecma: 2022 },
          nameCache,
        });
        assert.ok(output.code, 'RELEASE_MINIFY_FAILED');
        writeFileSync(join(target, 'dist', path), output.code);
      }
    }
    // This temporary package contains only allowlisted source and this run's outputs.
    const packed = JSON.parse(
      run(process.execPath, [pnpm, 'pack', '--json', '--pack-destination', artifacts], target),
    );
    const archive = resolve(
      artifacts,
      packed.filename ??
        `${manifests[name].name.replace('@', '').replace('/', '-')}-${manifests[name].version}.tgz`,
    );
    assert.equal(dirname(archive), artifacts, 'RELEASE_ARCHIVE_OUTSIDE_OUTPUT');
    assert.ok(existsSync(archive), 'RELEASE_ARCHIVE_MISSING');
    const unpacked = join(root, 'unpacked', name);
    mkdirSync(unpacked, { recursive: true });
    const listing = run('tar', ['-tzf', archive], root)
      .trim()
      .split(/\r?\n/)
      .filter((path) => !path.endsWith('/'));
    assert.ok(
      listing.every(
        (path) => path.startsWith('package/') && !path.includes('..') && !path.includes('\\'),
      ),
      'RELEASE_ARCHIVE_PATH',
    );
    run('tar', ['-xzf', archive, '-C', unpacked], root);
    const packageRoot = join(unpacked, 'package');
    const actual = files(packageRoot);
    const dist = actual.filter((path) => path.startsWith('dist/')).map((path) => path.slice(5));
    assert.deepEqual(dist, emitted, 'RELEASE_EMITTED_MANIFEST_MISMATCH');
    const descriptor = json(join(packageRoot, 'package.json'));
    assert.ok(!JSON.stringify(descriptor).includes('workspace:'), 'RELEASE_WORKSPACE_REFERENCE');
    const entries = [
      descriptor.main,
      descriptor.types,
      ...Object.values(descriptor.bin ?? {}),
      ...Object.values(descriptor.exports ?? {}).flatMap((entry) =>
        typeof entry === 'string' ? [entry] : Object.values(entry),
      ),
    ];
    for (const entry of entries) {
      assert.ok(existsSync(join(packageRoot, entry)), `RELEASE_ENTRY_MISSING: ${name}/${entry}`);
    }
    assert.ok(
      actual.every(
        (path) =>
          !/(^|\/)node_modules(\/|$)|^security\/|\.mld$|\.mdreset$|modeldb\.config\.json$/.test(
            path,
          ),
      ),
      'RELEASE_RUNTIME_FILE',
    );
    packages.push({
      name: descriptor.name,
      version: descriptor.version,
      archive: relative(root, archive).replaceAll('\\', '/'),
      sha256: sha256(readFileSync(archive)),
      jsCount: emitted.filter((path) => path.endsWith('.js')).length,
      files: actual.map((path) => ({
        path,
        sha256: sha256(readFileSync(join(packageRoot, path))),
      })),
    });
  }
  // Install the exact tarballs with the package manager; forbid registry/network fallback.
  const consumer = join(root, 'consumer');
  mkdirSync(consumer);
  const external = offlineDependencies(root, manifests);
  const overrides = {
    ...external.overrides,
    ...Object.fromEntries(
      packages.map((pkg) => [pkg.name, 'file:' + join(root, pkg.archive).replaceAll('\\', '/')]),
    ),
  };
  save(join(consumer, 'package.json'), {
    name: 'modeldb-isolated-acceptance',
    private: true,
    type: 'module',
    dependencies: {
      ...external.peers,
      ...Object.fromEntries(packages.map((pkg) => [pkg.name, 'file:' + join(root, pkg.archive)])),
    },
    devDependencies: external.developmentTypes,
    pnpm: { overrides },
  });
  writeFileSync(
    join(consumer, 'pnpm-workspace.yaml'),
    'packages: []\nautoInstallPeers: false\noverrides:\n' +
      Object.entries(overrides)
        .map(([name, location]) => `  ${JSON.stringify(name)}: ${JSON.stringify(location)}\n`)
        .join(''),
    { flag: 'wx' },
  );
  process.stdout.write('Installing local tarballs offline\n');
  run(
    process.execPath,
    [pnpm, 'install', '--offline', '--ignore-scripts', '--config.confirmModulesPurge=false'],
    consumer,
  );
  const help = run(
    process.execPath,
    [join(consumer, 'node_modules/@mode-db/server/dist/cli.js'), 'security', 'help'],
    consumer,
    { MODELDB_HOME: join(root, 'unused-home') },
  );
  for (const command of [
    'network-preview',
    'factory-reset-restore',
    'recovery-restore',
    'asset-import',
    'backup-import',
  ]) {
    assert.ok(help.includes(command), 'RELEASE_HELP_MISMATCH');
  }
  assert.equal(
    run(process.execPath, [pnpm, 'exec', 'modeldb-server', 'security', 'help'], consumer, {
      MODELDB_HOME: join(root, 'unused-home'),
    }),
    help,
    'RELEASE_BIN_SHIM_MISMATCH',
  );
  run(
    process.execPath,
    [join(consumer, 'node_modules/@mode-db/server/scripts/install-modeldb-workspace.mjs')],
    consumer,
    { INIT_CWD: consumer },
  );
  assert.ok(existsSync(join(consumer, 'modeldb/AGENTS.md')), 'RELEASE_POSTINSTALL_MISSING');
  save(join(consumer, 'tsconfig.json'), {
    compilerOptions: {
      strict: true,
      noEmit: true,
      module: 'Node16',
      moduleResolution: 'Node16',
      target: 'ES2022',
      jsx: 'react-jsx',
      skipLibCheck: false,
      types: ['node', 'react', 'ws'],
    },
    files: ['check.ts'],
  });
  writeFileSync(
    join(consumer, 'check.ts'),
    names
      .map(
        (name, index) =>
          `import * as package${index} from '@mode-db/${name}';\nvoid package${index};\n`,
      )
      .join(''),
    { flag: 'wx' },
  );
  run(
    process.execPath,
    [join(repository, 'node_modules/typescript/bin/tsc'), '-p', join(consumer, 'tsconfig.json')],
    consumer,
  );
  const apps = [];
  for (const name of ['model-designer', 'data-studio', 'web']) {
    process.stdout.write(`Building clean application: ${name}\n`);
    const output = join(root, 'apps', name);
    run(
      process.execPath,
      [
        join(repository, 'apps', name, 'node_modules/vite/bin/vite.js'),
        'build',
        '--outDir',
        output,
      ],
      join(repository, 'apps', name),
    );
    apps.push({
      name,
      files: files(output).map((path) => ({
        path,
        sha256: sha256(readFileSync(join(output, path))),
      })),
    });
  }
  const documentation = [];
  for (const path of [
    'docs/security-v1/overview.md',
    'docs/security-v1/user-guide.md',
    'docs/security-v1/release-guide.md',
    'docs/modeldb-config-guide.md',
  ]) {
    const output = join(root, path);
    mkdirSync(dirname(output), { recursive: true });
    const bytes = readFileSync(safeSource(path));
    writeFileSync(output, bytes, { flag: 'wx' });
    documentation.push({ path, sha256: sha256(bytes) });
    const commands = [
      ...bytes.toString('utf8').matchAll(/modeldb-server security ([a-z][a-z-]*)/g),
    ].map((match) => match[1]);
    for (const command of commands) {
      assert.ok(
        command === 'help' || help.includes(command),
        `RELEASE_DOCUMENTED_CLI_MISSING: ${command}`,
      );
    }
  }
  const i18n = ['zh', 'en', 'ja'].map((locale) => {
    const path = `apps/model-designer/src/i18n/locales/${locale}/ui.json`;
    const bytes = readFileSync(safeSource(path));
    const values = JSON.parse(bytes);
    const keys = Object.keys(values)
      .filter((key) => /^(security|audit|network|maintenance)/i.test(key))
      .sort();
    assert.ok(
      keys.length > 0 &&
        keys.every((key) => typeof values[key] === 'string' && values[key].trim().length > 0),
      'RELEASE_I18N_EMPTY',
    );
    return { locale, path, keys, sha256: sha256(bytes) };
  });
  for (const locale of i18n) {
    assert.deepEqual(locale.keys, i18n[0].keys, 'RELEASE_I18N_KEYS_MISMATCH');
  }
  const result = {
    format: 'modeldb.security-release-candidate.v1',
    timestampUtc: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    typescript: json(join(repository, 'node_modules/typescript/package.json')).version,
    pnpm: run(process.execPath, [pnpm, '--version'], root).trim(),
    packages,
    apps,
    documentation,
    i18n,
    browserDependencies,
    offlineDependencies: external.snapshots,
    sourceFiles: sources.sort((a, b) => a.path.localeCompare(b.path)),
    checks: {
      freshOutput: true,
      minifiedProductionPackages: true,
      exactArchiveManifest: true,
      offlineTarballInstall: true,
      dependencyScope: 'installed-third-party-code-snapshot-not-registry-fetch',
      cliHelp: true,
      binShim: true,
      consumerTypes: true,
      postinstall:
        'server installer explicitly executed after --ignore-scripts; third-party lifecycle disabled',
      cleanFrontends: true,
      documentedCliAndSecurityI18n: true,
    },
    consumer,
  };
  save(join(root, 'release-candidate.json'), result);
  process.stdout.write(`SUCCESS: ${join(root, 'release-candidate.json')}\n`);
}

main().catch((error) => {
  process.stderr.write(String(error) + '\n');
  process.exitCode = 1;
});

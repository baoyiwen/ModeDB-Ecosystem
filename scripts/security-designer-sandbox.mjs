/** Fresh synthetic instance and production Designer; never accepts an instance path. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function artifact(root, relative) {
  assert.ok(
    typeof relative === 'string' &&
      !relative.includes('\\') &&
      !relative.includes(':') &&
      relative.split('/').every((part) => part && part !== '.' && part !== '..'),
    'SANDBOX_CANDIDATE_PATH_REJECTED',
  );
  let current = root;
  for (const part of relative.split('/')) {
    current = join(current, part);
    assert.ok(!lstatSync(current).isSymbolicLink(), 'SANDBOX_CANDIDATE_LINK_REJECTED');
  }
  assert.ok(lstatSync(current).isFile(), 'SANDBOX_CANDIDATE_FILE_REQUIRED');
  return current;
}

export function loadSandboxCandidate(manifestPath) {
  const input = resolve(manifestPath);
  assert.equal(basename(input), 'release-candidate.json', 'SANDBOX_CANDIDATE_REQUIRED');
  const root = realpathSync(dirname(input));
  assert.equal(dirname(root), realpathSync(tmpdir()), 'SANDBOX_TEMP_CANDIDATE_REQUIRED');
  assert.match(basename(root), /^ModeDB-Release-[a-zA-Z0-9]+$/, 'SANDBOX_TEMP_CANDIDATE_REQUIRED');
  const manifestBytes = readFileSync(artifact(root, 'release-candidate.json'));
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.format, 'modeldb.security-release-candidate.v1');
  assert.deepEqual(
    manifest.packages.map((pkg) => pkg.name).sort(),
    ['common', 'core', 'data-kit', 'data-ui', 'sdk', 'server', 'shared'].map(
      (n) => '@mode-db/' + n,
    ),
  );
  const consumer = join(root, 'consumer');
  for (const pkg of manifest.packages) {
    assert.equal(sha256(readFileSync(artifact(root, pkg.archive))), pkg.sha256);
    const installed = realpathSync(join(consumer, 'node_modules', pkg.name));
    assert.ok(installed.startsWith(consumer + sep), 'SANDBOX_CONSUMER_REQUIRED');
    for (const file of pkg.files) {
      assert.equal(sha256(readFileSync(artifact(installed, file.path))), file.sha256);
    }
  }
  const app = manifest.apps.find((entry) => entry.name === 'model-designer');
  assert.ok(app && app.files.length > 0, 'SANDBOX_DESIGNER_BUILD_REQUIRED');
  const pages = new Map();
  for (const file of app.files) {
    const bytes = readFileSync(artifact(root, `apps/model-designer/${file.path}`));
    assert.equal(sha256(bytes), file.sha256);
    pages.set('/' + file.path, bytes);
  }
  assert.ok(pages.has('/index.html'), 'SANDBOX_DESIGNER_INDEX_REQUIRED');
  return { root, consumer, pages, manifestSha256: sha256(manifestBytes) };
}

export async function serveSandboxDesigner(pages) {
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
  };
  const server = createServer((request, response) => {
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405).end();
      return;
    }
    let path;
    try {
      path = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    } catch {
      response.writeHead(400).end();
      return;
    }
    const target = path === '/' ? '/index.html' : path;
    const bytes = pages.get(target);
    if (!bytes) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'content-type': mime[extname(target)] ?? 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    });
    response.end(request.method === 'HEAD' ? undefined : bytes);
  });
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object' && address.port !== 9091);
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function smoke(api, origin, home, callLocalSecurity, step) {
  const operation = {
    op: 'executeQuery',
    snapshot: {
      plan: {
        version: 2,
        originModel: 'DemoItem',
        start: { kind: 'all' },
        hops: [],
        trailing: { type: 'atom', field: 'name', op: 'eq', value: 'Example' },
      },
      execute: {},
      analysis: { groupBy: null, compute: null },
    },
  };
  step('pair');
  const launch = await callLocalSecurity(join(home, 'security'), {
    action: 'browser.launch',
    origin,
    databases: ['security_demo'],
  });
  const paired = await fetch(api + '/api/v1/security/pair', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ code: launch.code }),
  });
  assert.equal(paired.status, 200);
  const cookieHeader = paired.headers.get('set-cookie');
  assert.ok(cookieHeader?.includes('HttpOnly'));
  const session = await paired.json();
  step('replay');
  const replay = await fetch(api + '/api/v1/security/pair', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ code: launch.code }),
  });
  assert.equal(replay.status, 401);
  const cookie = cookieHeader.split(';')[0];
  step('authorized-query');
  const rpc = await fetch(api + '/api/v1/rpc', {
    method: 'POST',
    headers: { origin, cookie, 'content-type': 'application/json', 'x-modeldb-csrf': session.csrf },
    body: JSON.stringify({
      version: 1,
      database: 'security_demo',
      operation,
    }),
  });
  assert.equal(rpc.status, 200);
  assert.equal((await rpc.json()).result.rows.length, 1);
  step('anonymous-query');
  const denied = await fetch(api + '/api/v1/rpc', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ version: 1, database: 'security_demo', operation }),
  });
  assert.equal(denied.status, 401);
  step('frontend');
  assert.equal((await fetch(origin)).status, 200);
  assert.equal((await fetch(origin + '/modeldb.config.json')).status, 404);
  return {
    paired: true,
    httpOnly: true,
    replayDenied: true,
    authorizedQuery: true,
    anonymousDenied: true,
    designerPage: true,
    configNotServed: true,
  };
}

async function main() {
  assert.equal(process.platform, 'win32', 'SANDBOX_WINDOWS_REQUIRED');
  const args = process.argv.slice(2);
  let candidatePath;
  let noOpen = false;
  let smokeOnly = false;
  while (args.length) {
    const option = args.shift();
    if (option === '--candidate') {
      assert.ok(
        !candidatePath && args[0] && !args[0].startsWith('--'),
        'SANDBOX_CANDIDATE_REQUIRED',
      );
      candidatePath = args.shift();
    } else if (option === '--no-open') {
      noOpen = true;
    } else if (option === '--smoke') {
      smokeOnly = true;
    } else {
      throw new Error('SANDBOX_ARGUMENT_REJECTED');
    }
  }
  const ordinary = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$identity = [Security.Principal.WindowsIdentity]::GetCurrent(); try { if ((New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { exit 1 } } finally { $identity.Dispose() }',
    ],
    { windowsHide: true, stdio: 'ignore' },
  );
  assert.equal(ordinary.status, 0, 'SANDBOX_NON_ELEVATED_REQUIRED');
  if (!candidatePath) {
    const build = spawnSync(
      process.execPath,
      [join(repository, 'scripts/security-release-candidate.mjs')],
      {
        cwd: repository,
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    process.stdout.write(build.stdout ?? '');
    assert.equal(build.status, 0, 'SANDBOX_CANDIDATE_BUILD_FAILED');
    candidatePath = build.stdout.match(/SUCCESS: (.+release-candidate\.json)/)?.[1].trim();
    assert.ok(candidatePath, 'SANDBOX_CANDIDATE_REQUIRED');
  }
  const candidate = loadSandboxCandidate(candidatePath);
  const serverRoot = join(candidate.consumer, 'node_modules/@mode-db/server');
  const server = await import(pathToFileURL(join(serverRoot, 'dist/index.js')).href);
  const { AuthoringEngine } = await import(
    pathToFileURL(join(candidate.consumer, 'node_modules/@mode-db/core/dist/index.js')).href
  );
  const { callLocalSecurity } = await import(
    pathToFileURL(join(serverRoot, 'dist/security/local-management-channel.js')).href
  );
  const home = mkdtempSync(join(tmpdir(), 'ModeDB-Designer-Sandbox-'));
  const reportPath = join(home, 'sandbox.json');
  const config = server.ensureModelDbLayoutAtRoot(home);
  const raw = JSON.parse(readFileSync(config, 'utf8'));
  raw.host = '127.0.0.1';
  raw.port = 0;
  writeFileSync(config, JSON.stringify(raw, null, 2));
  const cfg = await server.loadModelDBServerConfig(config, { host: '127.0.0.1', port: 0 });
  const report = {
    format: 'modeldb.designer-sandbox.v1',
    home,
    config,
    candidateManifest: resolve(candidatePath),
    candidateManifestSha256: candidate.manifestSha256,
    database: 'security_demo',
    designerDatabase: cfg.designerWorkspace,
    syntheticOnly: true,
    real9091Touched: false,
    status: 'starting',
  };
  const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  save();
  let app;
  let frontend;
  try {
    const seed = new AuthoringEngine({
      atlas: 'security_demo',
      storageRoot: cfg.workspace,
      keyProvider: new server.LocalVaultKeyProvider(join(home, 'security')),
    });
    try {
      seed.registerModel('DemoItem', { name: 'String', score: 'Int' });
      await seed.insert('DemoItem', { name: 'Example', score: 1 });
      await seed.flushAll();
    } finally {
      await seed.close();
    }
    app = await server.buildDualTrackFastify(cfg);
    const address = app.server.address();
    assert.ok(address && typeof address === 'object' && address.port !== 9091);
    report.api = `http://127.0.0.1:${address.port}`;
    frontend = await serveSandboxDesigner(candidate.pages);
    report.designer = frontend.origin;
    report.checks = await smoke(report.api, frontend.origin, home, callLocalSecurity, (step) => {
      report.step = step;
      save();
    });
    report.status = 'ready';
    save();
    process.stdout.write(
      `SandboxRoot: ${home}\nReport: ${reportPath}\nAPI: ${report.api}\nDesigner: ${report.designer}\nDatabase: security_demo\n`,
    );
    if (!smokeOnly && !noOpen) {
      const opened = await new Promise((done, fail) => {
        const child = spawn(
          process.execPath,
          [
            join(serverRoot, 'dist/cli.js'),
            'security',
            'browser-open',
            '-c',
            config,
            '--url',
            frontend.origin,
            '--server',
            report.api,
            '--databases',
            'security_demo',
          ],
          { windowsHide: true, stdio: 'ignore' },
        );
        child.once('error', fail);
        child.once('exit', done);
      });
      assert.equal(opened, 0, 'SANDBOX_BROWSER_OPEN_FAILED');
      report.browserOpened = true;
      save();
    }
    process.stdout.write(
      smokeOnly
        ? 'SUCCESS: sandbox smoke checks\n'
        : 'Ready. Select security_demo in Model Designer. Keep this window open; Ctrl+C stops only this sandbox.\n',
    );
    if (!smokeOnly) {
      await new Promise((done) => {
        process.once('SIGINT', done);
        process.once('SIGTERM', done);
      });
    }
    report.status = 'stopped';
  } catch (error) {
    report.status = 'failed';
    report.failure = {
      expectedStatus: typeof error.expected === 'number' ? error.expected : undefined,
      actualStatus: typeof error.actual === 'number' ? error.actual : undefined,
    };
    throw new Error(`SANDBOX_START_FAILED: ${report.step ?? 'startup'}; report ${reportPath}`);
  } finally {
    if (frontend) {
      await new Promise((done) => frontend.server.close(done));
    }
    await app?.close();
    save();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(String(error.message) + '\n');
    process.exitCode = 1;
  });
}

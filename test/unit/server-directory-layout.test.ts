import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// A fresh process for each start also verifies that buffered logs and the
// process-exit summary stay in the session directory after opening libraries.
const serverCheck = `
  import assert from 'node:assert/strict';
  import { existsSync, mkdirSync } from 'node:fs';
  import { join } from 'node:path';
  import { AuthoringEngine } from '@mode-db/core';
  import { DiagnosticCenter, EngineLogger, ErrorCodes, PathResolver } from '@mode-db/common';
  import { loadModelDBServerConfig } from './packages/server/src/config-loader.ts';
  import { buildDualTrackFastify } from './packages/server/src/dual-track-app.ts';

  const cfg = await loadModelDBServerConfig(process.env.LAYOUT_CONFIG, { port: 0 });
  if (process.env.LAYOUT_FLAT === 'true') {
    const paths = new PathResolver(cfg.storageRoot, 'flatgraph', { workspaceFlatVault: true });
    if (!existsSync(paths.atlasSingleVaultPath())) {
      mkdirSync(cfg.storageRoot, { recursive: true });
      const engine = new AuthoringEngine({ atlas: 'flatgraph', paths, connectToken: cfg.connectToken });
      engine.registerModel('Item', { title: 'String' });
      await engine.insert('Item', { title: 'fixture' }, { sync: true });
      await engine.flushAll();
    }
  }
  const app = await buildDualTrackFastify(cfg);
  const headers = { 'x-modeldb-connect-token': cfg.connectToken };
  try {
    for (const database of ['north', 'south']) {
      if (!existsSync(join(cfg.storageRoot, database, 'atlas.mld'))) {
        const created = await app.inject({
          method: 'POST', url: '/api/v1/management/databases', headers, payload: { name: database },
        });
        assert.equal(created.statusCode, 201, created.body);
      }
    }
    const names = process.env.LAYOUT_FLAT === 'true' ? ['north', 'south', 'flatgraph'] : ['north', 'south'];
    for (const name of names) {
      const catalog = await app.inject({ method: 'GET', url: '/api/v1/management/databases/' + name + '/catalog', headers });
      assert.equal(catalog.statusCode, 200, catalog.body);
      assert.equal(catalog.json().database, name);
      assert.equal(EngineLogger.instance.isAccessLogEnabled(), true);
    }
    EngineLogger.instance.info('layout-regression-marker', { phase: process.env.LAYOUT_PHASE }, 'LayoutTest');
    DiagnosticCenter.report(ErrorCodes.SCHEMA_REQUIRED, { field: 'layout-diagnostic-marker', received: 'undefined' }, 'collect');
    const health = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(health.statusCode, 200);
  } finally {
    await app.close();
  }
`;

for (const scenario of [
  { name: 'default vault workspace', workspace: 'vault', logDir: 'logs', flat: false },
  { name: 'absolute workspace on a separate path', workspace: 'absolute', logDir: 'logs', flat: false },
  { name: 'default logs when logDir is omitted', workspace: 'vault', flat: false },
  { name: 'custom logs and a flat vault', workspace: 'vault', logDir: 'ops-logs', flat: true },
]) {
  it(`keeps server directories outside ${scenario.name} across restarts`, () => {
    const root = mkdtempSync(join(tmpdir(), 'modedb-layout-'));
    const sessionRoot = join(root, 'session');
    const workspace = scenario.workspace === 'absolute' ? join(root, 'separate-disk') : 'vault';
    const workspaceRoot = resolve(sessionRoot, workspace);
    const configPath = join(sessionRoot, 'modeldb.config.json');
    mkdirSync(sessionRoot, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        workspace,
        logDir: scenario.logDir,
        mode: 'production',
        connectToken: 'layout-fixture-token',
        designerWorkspace: 'designer',
      }),
    );
    try {
      for (const phase of ['first-start', 'restart']) {
        const child = spawnSync(
          process.execPath,
          ['--import', 'tsx', '--input-type=module', '--eval', serverCheck],
          {
            cwd: repoRoot,
            env: {
              ...process.env,
              LAYOUT_CONFIG: configPath,
              LAYOUT_PHASE: phase,
              LAYOUT_FLAT: String(scenario.flat),
            },
            encoding: 'utf8',
            timeout: 30_000,
          },
        );
        assert.equal(child.error, undefined, String(child.error));
        assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
        for (const unwanted of ['cache', 'logs', 'vault', '.modeldb-server']) {
          assert.equal(existsSync(join(workspaceRoot, unwanted)), false, unwanted);
        }
        for (const database of ['north', 'south']) {
          assert.ok(existsSync(join(workspaceRoot, database, 'atlas.mld')));
          assert.equal(existsSync(join(workspaceRoot, database, 'logs')), false);
        }
        if (scenario.flat) {
          assert.ok(existsSync(join(workspaceRoot, 'flatgraph.mld')));
        }
        assert.ok(existsSync(join(sessionRoot, 'cache')));
        const logRoot = join(sessionRoot, scenario.logDir ?? 'logs');
        const systemLog = readFileSync(join(logRoot, 'system.log'), 'utf8');
        assert.ok(systemLog.includes(`layout-regression-marker | phase: ${phase}`));
        assert.ok(systemLog.includes('layout-diagnostic-marker'));
        assert.ok(systemLog.includes('Run summary (process exit)'));
        const accessLog = readFileSync(join(logRoot, 'access.log'), 'utf8');
        assert.ok(accessLog.includes('HTTP GET /health'));
        assert.ok(accessLog.includes('HTTP GET /api/v1/management/databases/north/catalog'));
        assert.ok(accessLog.includes('HTTP GET /api/v1/management/databases/south/catalog'));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

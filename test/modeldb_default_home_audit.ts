/**
 * 校验无 **`-c`** 时 **`MODELDB_HOME`** 惰性初始化与 **`loadModelDBServerConfig(undefined)`** 可读入默认 **`connectToken`**。
 */
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadModelDBServerConfig } from '../packages/server/dist/index.js';

async function run(): Promise<void> {
  const prev = process.env.MODELDB_HOME;
  const prevWs = process.env.MODEL_DB_WORKSPACE;
  const dir = await mkdtemp(join(tmpdir(), 'modeldb-home-audit-'));
  process.env.MODELDB_HOME = dir;
  process.env.MODEL_DB_WORKSPACE = join(tmpdir(), 'modeldb-home-audit-should-ignore-ws');
  try {
    const cfg = await loadModelDBServerConfig(undefined, {});
    const cfgFile = join(dir, 'modeldb.config.json');
    assert.ok(existsSync(cfgFile), 'expected default modeldb.config.json');
    const written = JSON.parse(readFileSync(cfgFile, 'utf-8')) as { logDir?: string; workspace?: string };
    assert.equal(written.logDir, 'logs');
    assert.equal(written.workspace, 'vault');
    assert.equal(cfg.configFilePath, resolve(join(dir, 'modeldb.config.json')));
    assert.ok(cfg.connectToken.length >= 32, 'expected generated connectToken');
    assert.equal(cfg.storageRoot, join(dir, 'vault'));
    assert.equal(cfg.serverLogDirectory, join(dir, 'logs'));
    const again = await loadModelDBServerConfig(undefined, {});
    assert.equal(again.connectToken, cfg.connectToken, 'second load should not rotate token');
    console.log('modeldb_default_home_audit: ok (MODELDB_HOME layout + loadModelDBServerConfig(undefined)).');
  } finally {
    if (prev === undefined) {
      delete process.env.MODELDB_HOME;
    } else {
      process.env.MODELDB_HOME = prev;
    }
    if (prevWs === undefined) {
      delete process.env.MODEL_DB_WORKSPACE;
    } else {
      process.env.MODEL_DB_WORKSPACE = prevWs;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

void run().catch((e) => {
  console.error(e);
  process.exit(1);
});

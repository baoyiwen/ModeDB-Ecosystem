/**
 * 校验无 **`-c`** 时 **`MODELDB_HOME`** 惰性初始化与 **`loadModelDBServerConfig(undefined)`** 可读入默认 **`connectToken`**。
 */
import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadModelDBServerConfig } from '../packages/server/dist/index.js';

async function run(): Promise<void> {
  const prev = process.env.MODELDB_HOME;
  const dir = await mkdtemp(join(tmpdir(), 'modeldb-home-audit-'));
  process.env.MODELDB_HOME = dir;
  try {
    const cfg = await loadModelDBServerConfig(undefined, {});
    const cfgFile = join(dir, 'modeldb.config.json');
    assert.ok(existsSync(cfgFile), 'expected default modeldb.config.json');
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
    await rm(dir, { recursive: true, force: true });
  }
}

void run().catch((e) => {
  console.error(e);
  process.exit(1);
});

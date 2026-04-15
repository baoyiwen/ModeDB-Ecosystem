/**
 * 校验 **`loadModelDBServerConfig`** 与文档一致：优先级、**`dbPath`** 指向 **`*.mld`** 时的存储根与默认 atlas、**`connectToken`** 必填。
 *
 * 使用临时目录中的 JSON，不读写仓库根 **`modeldb.config.json`**。
 */
import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadModelDBServerConfig } from '../packages/server/dist/index.js';

async function run(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'modeldb-cfg-audit-'));
  try {
    const sandDir = join(dir, 'sand');
    const worldMld = join(sandDir, 'world.mld');
    const cfgPath = join(dir, 'modeldb.config.json');
    await writeFile(
      cfgPath,
      JSON.stringify({
        port: 7001,
        host: '0.0.0.0',
        dbPath: worldMld,
        connectToken: 'file-token',
        bufferThreshold: 12000,
        mode: 'production',
      }),
      'utf-8',
    );

    const fromFile = await loadModelDBServerConfig(cfgPath, {});
    assert.equal(fromFile.port, 7001);
    assert.equal(fromFile.host, '0.0.0.0');
    assert.equal(fromFile.connectToken, 'file-token');
    assert.equal(fromFile.defaultAtlas, 'world');
    assert.equal(fromFile.storageRoot, sandDir);
    assert.equal(fromFile.workspace, fromFile.storageRoot);
    assert.equal(fromFile.bufferFlushRowThreshold, 12000);
    assert.equal(fromFile.accessLog, true);

    const cliOverride = await loadModelDBServerConfig(cfgPath, {
      port: 8888,
      connectToken: 'cli-token',
    });
    assert.equal(cliOverride.port, 8888);
    assert.equal(cliOverride.connectToken, 'cli-token');

    const relDir = join(dir, 'relcfg');
    const relCfg = join(relDir, 'modeldb.config.json');
    await mkdir(relDir, { recursive: true });
    await writeFile(
      relCfg,
      JSON.stringify({
        port: 7002,
        host: '127.0.0.1',
        workspace: './wv',
        logDir: './logs',
        connectToken: 'rel-token',
      }),
      'utf-8',
    );
    const relLoaded = await loadModelDBServerConfig(relCfg, {});
    assert.equal(relLoaded.storageRoot, join(relDir, 'wv'));
    assert.equal(relLoaded.serverLogDirectory, join(relDir, 'logs'));

    const emptyPath = join(dir, 'empty.json');
    await writeFile(emptyPath, '{}', 'utf-8');
    await assert.rejects(
      () => loadModelDBServerConfig(emptyPath, {}),
      (e: unknown) => e instanceof Error && /connectToken/i.test((e as Error).message),
    );

    console.log(
      'modeldb_config_loader_audit: ok (priority, dbPath→storageRoot+defaultAtlas, connectToken required, accessLog from mode, relative paths vs config dir).',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

void run().catch((e) => {
  console.error(e);
  process.exit(1);
});

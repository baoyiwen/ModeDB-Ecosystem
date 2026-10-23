import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AuthoringEngine } from '@mode-db/core';
import { assertFlatGraphSegment } from '@mode-db/common';
import { loadModelDBServerConfig } from './config-loader.js';
import { serverVaultKeys } from './security/server-vault-keys.js';

export function parseCreateDbArgv(argv: string[]): {
  config?: string;
  token?: string;
} {
  const out: { config?: string; token?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-c' || a === '--config') {
      out.config = argv[++i];
    } else if (a.startsWith('--config=')) {
      out.config = a.slice('--config='.length);
    } else if (a === '-t' || a === '--token') {
      out.token = argv[++i];
    } else if (a.startsWith('--token=')) {
      out.token = a.slice('--token='.length);
    }
  }
  return out;
}

function printAuthGuide(cfg: { storageRoot: string; configFilePath: string }): void {
  console.error('');
  console.error('── 认证与连接（必读）────────────────────────────────────');
  console.error('1) connectToken：仅用于网络认证，不再参与磁盘 Vault 解密：');
  console.error(`   • 配置文件：${cfg.configFilePath} 中的 "connectToken"`);
  console.error('   • 环境变量：MODEL_DB_CONNECT_TOKEN（仅网络连接）');
  console.error('   • 命令行：create-db 时可用 -t / --token（与上两项择一即可，勿多处互斥）');
  console.error('');
  console.error('2) 导出环境变量（与本机配置一致）：');
  console.error('   modeldb-server export-token');
  console.error('   # 或带 -c：modeldb-server export-token -c <会话根或 modeldb.config.json>');
  console.error('');
  console.error(
    '3) 远程客户端（@mode-db/sdk）握手时使用同一 connectToken；逻辑库名即本命令的 <db-name>。',
  );
  console.error(`4) 逻辑库根目录（workspace）：${cfg.storageRoot}`);
  console.error('   每个库对应子目录：<workspace>/<db-name>/atlas.mld');
  console.error('────────────────────────────────────────────────────────');
}

/**
 * 在已解析的 **storageRoot**（默认即 MODELDB_HOME 下的 **vault/**）下创建空逻辑库目录与 **atlas.mld**。
 */
export async function runCreateDb(dbName: string, argv: string[]): Promise<void> {
  assertFlatGraphSegment(dbName, '逻辑库名');
  const { config: configArg, token } = parseCreateDbArgv(argv);
  const cfg = await loadModelDBServerConfig(configArg, {
    connectToken:
      token !== undefined && String(token).trim() !== '' ? String(token).trim() : undefined,
  });

  const vaultPath = join(cfg.storageRoot, dbName, 'atlas.mld');

  if (existsSync(vaultPath)) {
    console.error(`[ModelDB] 逻辑库 "${dbName}" 已存在，跳过创建。`);
    console.error(`[ModelDB] Vault 路径：${vaultPath}`);
    printAuthGuide(cfg);
    return;
  }

  const engine = new AuthoringEngine({
    atlas: dbName,
    storageRoot: cfg.storageRoot,
    keyProvider: serverVaultKeys(cfg),
  });
  await engine.flushAll();

  console.error(`[ModelDB] 已创建逻辑库 "${dbName}"。`);
  console.error(`[ModelDB] 目录：${join(cfg.storageRoot, dbName)}`);
  console.error(`[ModelDB] 单文件 Vault：${vaultPath}`);
  printAuthGuide(cfg);
}

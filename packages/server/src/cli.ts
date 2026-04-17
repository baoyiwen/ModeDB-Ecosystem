#!/usr/bin/env node
/** ESM 入口，便于 esbuild 打成单文件时不混入 CJS 的 `require('events')`。 */
import { join, resolve } from 'node:path';
import { Command } from 'commander/esm.mjs';
import { loadModelDBServerConfig } from './config-loader.js';
import { startModelDBWebSocketServer } from './modeldb-server.js';
import { getModelDbCliSettingsDir, setPersistedModelDbHomePath } from './modeldb-persisted-home.js';
import { runCreateDb } from './cli-create-db.js';
import { runInfo, runLs } from './cli-mgmt.js';

function parseExportTokenArgv(argv: string[]): { config?: string } {
  const out: { config?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-c' || a === '--config') {
      out.config = argv[++i];
    } else if (a.startsWith('--config=')) {
      out.config = a.slice('--config='.length);
    }
  }
  return out;
}

async function runExportToken(configArg: string | undefined): Promise<void> {
  const cfg = await loadModelDBServerConfig(configArg, {});
  const token = cfg.connectToken;
  const out = [
    '# POSIX — 写入 ~/.bashrc / ~/.zshrc 或 CI Secret：',
    `export MODEL_DB_CONNECT_TOKEN='${token}'`,
    '',
    '# Windows CMD：',
    `set MODEL_DB_CONNECT_TOKEN=${token}`,
    '',
    '# Windows PowerShell：',
    `$env:MODEL_DB_CONNECT_TOKEN='${token}'`,
    '',
  ].join('\n');
  process.stdout.write(out);
  console.error('');
  console.error(
    '[ModelDB] 请妥善保存 MODEL_DB_CONNECT_TOKEN；须与 modeldb.config.json 中 connectToken 一致且勿泄露。',
  );
}

const argv = process.argv.slice(2);

if (argv[0] === 'set') {
  const dir = argv[1];
  if (!dir?.trim()) {
    console.error('Usage: modeldb-server set <directory>');
    process.exit(1);
  }
  const abs = resolve(dir.trim());
  setPersistedModelDbHomePath(abs);
  console.error(`ModelDB default home: ${abs}`);
  console.error(`Persisted in: ${join(getModelDbCliSettingsDir(), 'home')}`);
  console.error('之后不带 -c 的 start 会使用该目录（若未设置环境变量 MODELDB_HOME）。');
  process.exit(0);
}

if (argv[0] === 'export-token') {
  const { config: c } = parseExportTokenArgv(argv.slice(1));
  await runExportToken(c);
  process.exit(0);
}

if (argv[0] === 'info' || argv[0] === 'status') {
  try {
    await runInfo(argv.slice(1));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[ModelDB] info 失败：${msg}`);
    process.exit(1);
  }
  process.exit(0);
}

if (argv[0] === 'ls' || argv[0] === 'list') {
  try {
    await runLs(argv.slice(1));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[ModelDB] ls 失败：${msg}`);
    process.exit(1);
  }
  process.exit(0);
}

if (argv[0] === 'create-db') {
  const dbName = argv[1]?.trim();
  if (!dbName) {
    console.error(
      'Usage: modeldb-server create-db <db-name> [-c <session-root|modeldb.config.json>] [-t <connectToken>]',
    );
    console.error('');
    console.error(
      '在默认「会话根」下的 workspace（通常为 vault/）中创建逻辑库 <db-name>/atlas.mld。',
    );
    console.error(
      '无需填写绝对路径：未传 -c 时使用 MODELDB_HOME / modeldb-server set / 系统默认 modeldb 目录。',
    );
    console.error(
      '认证令牌与 modeldb.config.json 中 connectToken 一致；可用 modeldb-server export-token 导出 MODEL_DB_CONNECT_TOKEN。',
    );
    process.exit(1);
  }
  try {
    await runCreateDb(dbName, argv.slice(2));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[ModelDB] create-db 失败：${msg}`);
    process.exit(1);
  }
  process.exit(0);
}

const program = new Command()
  .name('modeldb-server')
  .description(
    'ModelDB 2.0 daemon. Subcommands: start (default), info|status, ls|list, set <dir>, export-token, create-db <name>. Without -c, data root is MODELDB_HOME, ~/.modeldb/home (from "set"), or OS default; auto-creates layout on start.',
  )
  .option(
    '-c, --config <path>',
    'Session data root (modeldb.config.json + logs/ + cache/ + vault/) or path to a standalone .json config file',
    undefined,
  )
  .option('-p, --port <number>', 'Listen port (overrides config / env)')
  .option('-H, --host <host>', 'Bind host (default 127.0.0.1)')
  .option('-t, --token <secret>', 'Client connect token (also derives the atlas vault key)')
  .option('--dev', 'Print decrypted RPC payloads to stderr (development only)', false);

const startArgv = argv[0] === 'start' ? argv.slice(1) : argv;
program.parse(startArgv, { from: 'user' });
const o = program.opts<{
  config?: string;
  port?: string;
  host?: string;
  token?: string;
  dev?: boolean;
}>();

const tokenArg = o.token;
const connectTokenFromCli =
  tokenArg !== undefined && String(tokenArg).trim() !== '' ? String(tokenArg).trim() : undefined;

const cfg = await loadModelDBServerConfig(o.config, {
  port: o.port !== undefined && o.port !== '' ? Number(o.port) : undefined,
  host: o.host,
  connectToken: connectTokenFromCli,
  dev: Boolean(o.dev),
});

await startModelDBWebSocketServer(cfg);

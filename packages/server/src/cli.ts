#!/usr/bin/env node
import { Command } from 'commander';
import { loadModelDBServerConfig } from './config-loader.js';
import { startModelDBWebSocketServer } from './modeldb-server.js';

const program = new Command()
  .name('modeldb-server')
  .description('ModelDB 2.0 WebSocket server (wire obfuscation + connect token)')
  .option('-c, --config <path>', 'Path to modeldb.config.json', undefined)
  .option('-p, --port <number>', 'Listen port (overrides config / env)')
  .option('-H, --host <host>', 'Bind host (default 127.0.0.1)')
  .option(
    '-w, --workspace <path>',
    'Logical-library workspace root (<workspace>/<dbName>/ per library)',
  )
  .option('-s, --storage <path>', 'Same as --workspace (legacy alias)')
  .option('--db-path <path>', 'Same as --workspace (legacy alias)')
  .option('-t, --token <secret>', 'Client connect token (also derives the atlas vault key)')
  .option('--dev', 'Print decrypted RPC payloads to stderr (development only)', false);

program.parse(process.argv);
const o = program.opts<{
  config?: string;
  port?: string;
  host?: string;
  workspace?: string;
  storage?: string;
  dbPath?: string;
  token?: string;
  dev?: boolean;
}>();

const cfg = await loadModelDBServerConfig(o.config, {
  port: o.port !== undefined && o.port !== '' ? Number(o.port) : undefined,
  host: o.host,
  workspace: o.workspace ?? o.storage ?? o.dbPath,
  connectToken: o.token,
  dev: Boolean(o.dev),
});

await startModelDBWebSocketServer(cfg);

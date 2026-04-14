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
  .option('-s, --storage <path>', 'Storage root directory (MODEL_DB data root)')
  .option('--db-path <path>', 'Same as --storage (data root for atlases / .mld)')
  .option('-t, --token <secret>', 'Client connect token')
  .option('--vault-secret <secret>', 'MODEL_DB_VAULT_SECRET equivalent for Vault atlases')
  .option('--vault-key <secret>', 'Same as --vault-secret')
  .option('--dev', 'Print decrypted RPC payloads to stderr (development only)', false);

program.parse(process.argv);
const o = program.opts<{
  config?: string;
  port?: string;
  host?: string;
  storage?: string;
  dbPath?: string;
  token?: string;
  vaultSecret?: string;
  vaultKey?: string;
  dev?: boolean;
}>();

const cfg = await loadModelDBServerConfig(o.config, {
  port: o.port !== undefined && o.port !== '' ? Number(o.port) : undefined,
  host: o.host,
  storageRoot: o.storage ?? o.dbPath,
  connectToken: o.token,
  vaultSecret: o.vaultSecret ?? o.vaultKey,
  dev: Boolean(o.dev),
});

await startModelDBWebSocketServer(cfg);

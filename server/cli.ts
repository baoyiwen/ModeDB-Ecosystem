#!/usr/bin/env node
import { loadModelDBServerConfig } from './modeldb-config.js';
import { startModelDBWebSocketServer } from './modeldb-server.js';

function parseArgs(argv: string[]): {
  config?: string;
  port?: number;
  storageRoot?: string;
  connectToken?: string;
} {
  const out: { config?: string; port?: number; storageRoot?: string; connectToken?: string } = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--config' || a === '-c') {
      out.config = argv[++i];
    } else if (a === '--port' || a === '-p') {
      out.port = Number(argv[++i]);
    } else if (a === '--storage' || a === '-s') {
      out.storageRoot = argv[++i];
    } else if (a === '--token' || a === '-t') {
      out.connectToken = argv[++i];
    } else if (a === '--help' || a === '-h') {
      // eslint-disable-next-line no-console
      console.log(`ModelDB server

  --port, -p       HTTP/WebSocket listen port (default from config or 8787)
  --config, -c     Path to modeldb.config.json (default: ./modeldb.config.json)
  --storage, -s    Storage root (MODEL_DB data directory)
  --token, -t      Connect token (MODEL_DB_CONNECT_TOKEN)
`);
      process.exit(0);
    }
  }
  return out;
}

const cli = parseArgs(process.argv);
const cfg = await loadModelDBServerConfig(cli.config, {
  port: cli.port,
  storageRoot: cli.storageRoot,
  connectToken: cli.connectToken,
});

await startModelDBWebSocketServer(cfg);

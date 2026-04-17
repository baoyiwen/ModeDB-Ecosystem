import type { ManagementDatabasesResponse, ManagementStatusResponse } from '@mode-db/shared';
import { loadModelDBServerConfig } from './config-loader.js';

/** Shared with **`create-db`** / **`start`**: **`-c`**, **`-t`**, optional **`-H`** / **`-p`**（连接管理 HTTP 时覆盖监听地址）。 */
export function parseMgmtArgv(argv: string[]): {
  config?: string;
  token?: string;
  host?: string;
  port?: string;
} {
  const out: { config?: string; token?: string; host?: string; port?: string } = {};
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
    } else if (a === '-p' || a === '--port') {
      out.port = argv[++i];
    } else if (a.startsWith('--port=')) {
      out.port = a.slice('--port='.length);
    } else if (a === '-H' || a === '--host') {
      out.host = argv[++i];
    } else if (a.startsWith('--host=')) {
      out.host = a.slice('--host='.length);
    }
  }
  return out;
}

function formatUptime(seconds: number): string {
  const s = Math.floor(Math.max(0, seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) {
    return `${d}d ${h}h ${m}m`;
  }
  return `${h}h ${m}m`;
}

function formatBytes(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) {
    return '—';
  }
  if (n < 1024) {
    return `${n} B`;
  }
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(1)}KB`;
  }
  if (n < 1024 ** 3) {
    return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  }
  return `${(n / 1024 ** 3).toFixed(1)}GB`;
}

async function fetchJson<T>(url: string, token: string): Promise<T> {
  const res = await fetch(url, {
    headers: { 'X-ModelDB-Connect-Token': token },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

/**
 * 通过 **`GET /api/v1/management/status`** 打印引擎状态（须已有 **`modeldb-server start`** 监听）。
 */
export async function runInfo(restArgv: string[]): Promise<void> {
  const { config, token, host, port } = parseMgmtArgv(restArgv);
  const cfg = await loadModelDBServerConfig(config, {
    host,
    port: port !== undefined && port !== '' ? Number(port) : undefined,
    connectToken:
      token !== undefined && String(token).trim() !== '' ? String(token).trim() : undefined,
  });
  const base = `http://${cfg.host}:${cfg.port}`;
  const j = await fetchJson<ManagementStatusResponse>(
    `${base}/api/v1/management/status`,
    cfg.connectToken,
  );
  console.log(`ModelDB Engine Status: ${j.state}`);
  console.log('--------------------------------------');
  console.log(`Uptime: ${formatUptime(j.uptimeSeconds)}`);
  console.log(`Listen: ${j.listen.host}:${j.listen.port}`);
  console.log(`Storage Format: ${j.storageFormat} (v${j.storageVersion})`);
  console.log(`Workspace: ${j.workspaceRoot}`);
  console.log('');
  console.log('Active Databases (Workspaces):');
  for (const d of j.databases) {
    console.log(`  - ${d.name} (Used: ${formatBytes(d.bytesUsed)})`);
  }
  console.log('');
  console.log(`Connected Clients: ${j.connectedClients}`);
}

/**
 * 仅列出逻辑库名（**`GET /api/v1/management/databases`**）。
 */
export async function runLs(restArgv: string[]): Promise<void> {
  const { config, token, host, port } = parseMgmtArgv(restArgv);
  const cfg = await loadModelDBServerConfig(config, {
    host,
    port: port !== undefined && port !== '' ? Number(port) : undefined,
    connectToken:
      token !== undefined && String(token).trim() !== '' ? String(token).trim() : undefined,
  });
  const base = `http://${cfg.host}:${cfg.port}`;
  const j = await fetchJson<ManagementDatabasesResponse>(
    `${base}/api/v1/management/databases`,
    cfg.connectToken,
  );
  for (const d of j.databases) {
    console.log(d.name);
  }
}

import { hostname, networkInterfaces } from 'node:os';
import type { ResolvedModelDBServerConfig } from './config-loader.js';

function isWildcardHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === '0.0.0.0' || normalized === '::' || normalized === '[::]';
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

function formatUrlHost(host: string): string {
  const trimmed = host.trim();
  return trimmed.includes(':') && !trimmed.startsWith('[') ? `[${trimmed}]` : trimmed;
}

function addUniqueHost(hosts: string[], host: string | undefined): void {
  const trimmed = host?.trim();
  if (trimmed && !hosts.some((candidate) => candidate.toLowerCase() === trimmed.toLowerCase())) {
    hosts.push(trimmed);
  }
}

function isUsableNetworkInterfaceAddress(address: string, internal: boolean): boolean {
  return !internal && !address.toLowerCase().startsWith('fe80:');
}

function isAsciiHostname(value: string): boolean {
  return /^[\x00-\x7f]+$/.test(value);
}

/** Returns the non-loopback hosts that can be shown as `Network` URLs. */
export function getModelDBNetworkHosts(cfg: ResolvedModelDBServerConfig): readonly string[] {
  const hosts: string[] = [];

  if (!isLoopbackHost(cfg.host)) {
    addUniqueHost(hosts, cfg.advertisedHost);
  }

  if (!isWildcardHost(cfg.host)) {
    if (!isLoopbackHost(cfg.host)) {
      addUniqueHost(hosts, cfg.host);
    }
    return hosts;
  }

  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (isUsableNetworkInterfaceAddress(entry.address, entry.internal)) {
        addUniqueHost(hosts, entry.address);
      }
    }
  }

  return hosts;
}

/**
 * Returns hosts that a client can use when connecting to the server.
 * A wildcard bind address is a listen instruction, not a client address, so it
 * is replaced with the machine hostname and its non-loopback interface IPs.
 */
export function getModelDBClientHosts(cfg: ResolvedModelDBServerConfig): readonly string[] {
  const hosts: string[] = [];

  if (!isWildcardHost(cfg.host)) {
    if (!isLoopbackHost(cfg.host)) {
      addUniqueHost(hosts, cfg.advertisedHost);
    }
    addUniqueHost(hosts, cfg.host);
    return hosts;
  }

  addUniqueHost(hosts, cfg.advertisedHost);
  const machineHostname = hostname();
  if (isAsciiHostname(machineHostname)) {
    addUniqueHost(hosts, machineHostname);
  }
  for (const host of getModelDBNetworkHosts(cfg)) {
    addUniqueHost(hosts, host);
  }

  return hosts;
}

function httpUrl(host: string, port: number, path = ''): string {
  return `http://${formatUrlHost(host)}:${port}${path}`;
}

function wsUrl(host: string, port: number, path = '/'): string {
  return `ws://${formatUrlHost(host)}:${port}${path}`;
}

function shellQuote(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}

function commandWithConfig(command: string, configFilePath: string): string {
  return `modeldb-server ${command} -c ${shellQuote(configFilePath)}`;
}

/**
 * Human-readable startup details for the interactive server console.
 * Tokens are deliberately excluded from this output.
 */
export function formatModelDBStartupInfo(cfg: ResolvedModelDBServerConfig, port: number): string {
  const hosts = getModelDBClientHosts(cfg);
  const lines = ['[ModelDB] Engine is running', `  Listen: ${cfg.host}:${port}`];

  if (isLoopbackHost(cfg.host) || isWildcardHost(cfg.host)) {
    lines.push(`  ➜ Local:   ${httpUrl('localhost', port, '/')} (本机访问)`);
  }
  for (const host of getModelDBNetworkHosts(cfg)) {
    lines.push(`  ➜ Network: ${httpUrl(host, port, '/')} (网络访问入口)`);
  }

  lines.push('  Direct client addresses:');

  if (hosts.length === 0) {
    lines.push('    (no client address detected)');
  } else {
    for (const host of hosts) {
      lines.push(`    HTTP:      ${httpUrl(host, port)} (HTTP API 根地址)`);
      lines.push(`    Action:    ${httpUrl(host, port, '/v2/action')} (单次操作接口)`);
      lines.push(`    Bulk:      ${httpUrl(host, port, '/v2/bulk')} (批量操作接口)`);
      lines.push(`    Health:    ${httpUrl(host, port, '/health')} (健康检查)`);
      lines.push(`    Status:    ${httpUrl(host, port, '/api/v1/management/status')} (引擎状态)`);
      lines.push(`    WebSocket: ${wsUrl(host, port)} (实时 RPC)`);
      lines.push(`    Stream:    ${wsUrl(host, port, '/v2/stream')} (流式 RPC)`);
    }
  }

  lines.push(
    '',
    '  Console commands:',
    '    Stop:      Ctrl+C',
    `    Status:    ${commandWithConfig('info', cfg.configFilePath)}`,
    `    Databases: ${commandWithConfig('ls', cfg.configFilePath)}`,
    `    Create DB: ${commandWithConfig('create-db <db-name>', cfg.configFilePath)}`,
    `    Backup:    ${commandWithConfig('backup <db-name> --reason manual', cfg.configFilePath)}`,
    '',
    '  Note: management URLs require the configured connect token in the request header.',
  );

  if (isWildcardHost(cfg.host)) {
    lines.push(
      '  Remote access: use one of the listed addresses from the other machine and allow the port through its firewall.',
    );
  } else if (isLoopbackHost(cfg.host)) {
    lines.push(
      '  Remote access: disabled by the loopback bind. Start with --host 0.0.0.0 for direct LAN access.',
    );
  }

  return lines.join('\n');
}

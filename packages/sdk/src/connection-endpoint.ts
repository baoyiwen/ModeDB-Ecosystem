import { ConnectionSecurityError } from './connection-security.js';

/** Endpoint shared by data connections and management helpers. */
export interface ConnectionEndpoint {
  readonly host: string;
  readonly port: number;
  /** Defaults to HTTP for legacy/loopback development; use HTTPS for remote credentials. */
  readonly secure?: boolean;
}

/** Build one validated origin, including IPv6 and an explicit https:// host input. */
export function connectionOrigin(endpoint: ConnectionEndpoint): string {
  const host = endpoint.host.trim();
  const explicit = /^https?:\/\//i.test(host);
  const name = host.includes(':') && !host.startsWith('[') && !explicit ? `[${host}]` : host;
  let url: URL;
  try {
    url = new URL(explicit ? host : `${endpoint.secure ? 'https' : 'http'}://${name}`);
  } catch {
    throw new ConnectionSecurityError('SECURITY_INVALID_ENDPOINT', 400);
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    !Number.isInteger(endpoint.port) ||
    endpoint.port < 1 ||
    endpoint.port > 65535 ||
    (endpoint.secure === true && url.protocol !== 'https:')
  ) {
    throw new ConnectionSecurityError('SECURITY_INVALID_ENDPOINT', 400);
  }
  url.port = String(endpoint.port);
  return url.origin;
}

/** Do not send a registry credential across a remote plaintext connection. */
export function assertSecureCredentialOrigin(origin: string, token: string): void {
  if (!token.startsWith('mdbt_v1_')) {
    return;
  }
  const url = new URL(origin);
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const local =
    hostname === 'localhost' || hostname === '::1' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  if (url.protocol !== 'https:' && !local) {
    throw new ConnectionSecurityError('SECURITY_TLS_REQUIRED', 403);
  }
}

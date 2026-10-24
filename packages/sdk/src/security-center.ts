import type {
  SecurityAuditPage,
  SecurityAuditQuery,
  SecurityCenterOverview,
  SecurityControlRequest,
  SecurityControlResult,
} from '@mode-db/shared';
import { browserSessionRequestInit } from './browser-session.js';
import { connectionOrigin, type ConnectionEndpoint } from './connection-endpoint.js';
import { remoteResponseError } from './connection-security.js';

/** Paired administrator + Origin + CSRF protected management commands. */
export async function securityControl<T extends SecurityControlRequest>(
  endpoint: ConnectionEndpoint,
  command: T,
  fetchImpl: typeof fetch = fetch,
): Promise<SecurityControlResult<T>> {
  const origin = connectionOrigin(endpoint);
  const session = await browserSessionRequestInit(origin);
  const response = await fetchImpl(`${origin}/api/v1/security/admin/control`, {
    method: 'POST',
    redirect: 'error',
    credentials: 'include',
    cache: 'no-store',
    headers: { ...session.headers, 'content-type': 'application/json' },
    body: JSON.stringify(command),
  });
  if (!response.ok) {
    throw await remoteResponseError(response);
  }
  return (await response.json()) as SecurityControlResult<T>;
}

/** Read-only security-center snapshot. The endpoint requires an OS-paired admin session. */
export async function getSecurityCenterOverview(
  endpoint: ConnectionEndpoint,
  fetchImpl: typeof fetch = fetch,
): Promise<SecurityCenterOverview> {
  const origin = connectionOrigin(endpoint);
  const session = await browserSessionRequestInit(origin);
  const response = await fetchImpl(`${origin}/api/v1/security/admin/overview`, {
    method: 'GET',
    redirect: 'error',
    credentials: 'include',
    cache: 'no-store',
    headers: session.headers,
  });
  if (!response.ok) {
    throw await remoteResponseError(response);
  }
  return (await response.json()) as SecurityCenterOverview;
}

/** Read a bounded security audit page through the paired administrator session. */
export async function getSecurityAudit(
  endpoint: ConnectionEndpoint,
  query: SecurityAuditQuery = {},
  fetchImpl: typeof fetch = fetch,
): Promise<SecurityAuditPage> {
  const origin = connectionOrigin(endpoint);
  const session = await browserSessionRequestInit(origin);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      params.set(key, String(value));
    }
  }
  const suffix = params.toString() ? `?${params.toString()}` : '';
  const response = await fetchImpl(`${origin}/api/v1/security/admin/audit${suffix}`, {
    method: 'GET',
    redirect: 'error',
    credentials: 'include',
    cache: 'no-store',
    headers: session.headers,
  });
  if (!response.ok) {
    throw await remoteResponseError(response);
  }
  return (await response.json()) as SecurityAuditPage;
}

/** Download a metadata-only JSONL audit export through the paired administrator session. */
export async function exportSecurityAudit(
  endpoint: ConnectionEndpoint,
  query: Omit<SecurityAuditQuery, 'offset' | 'limit'> = {},
  fetchImpl: typeof fetch = fetch,
): Promise<Blob> {
  const origin = connectionOrigin(endpoint);
  const session = await browserSessionRequestInit(origin);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      params.set(key, String(value));
    }
  }
  const suffix = params.toString() ? `?${params.toString()}` : '';
  const response = await fetchImpl(`${origin}/api/v1/security/admin/audit/export${suffix}`, {
    method: 'GET',
    redirect: 'error',
    credentials: 'include',
    cache: 'no-store',
    headers: session.headers,
  });
  if (!response.ok) {
    throw await remoteResponseError(response);
  }
  return response.blob();
}

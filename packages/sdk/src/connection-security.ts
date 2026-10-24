/** Stable authentication/authorization failure shared by browser applications. */
export class ConnectionSecurityError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly requestId?: string,
  ) {
    super(code);
    this.name = 'ConnectionSecurityError';
  }
}

/** UI translation keys; messages are owned by the calling application. */
export type ConnectionSecurityIssue =
  | 'transport'
  | 'source'
  | 'credentials'
  | 'forbidden'
  | 'scopeChanged'
  | 'protocol'
  | 'legacyVault'
  | 'unavailable'
  | 'closed'
  | 'unconfirmed';

/** Classify stable failures without inspecting translated server messages. */
export function connectionSecurityIssue(error: unknown): ConnectionSecurityIssue | undefined {
  if (!(error instanceof ConnectionSecurityError)) {
    return undefined;
  }
  if (error.code === 'VAULT_LEGACY_FORMAT') {
    return 'legacyVault';
  }
  if (error.code === 'SECURITY_OUTCOME_UNCONFIRMED') {
    return 'unconfirmed';
  }
  if (error.code.includes('CREDENTIAL')) {
    return 'credentials';
  }
  if (error.code === 'SECURITY_RELEASE_SCOPE_CHANGED') {
    return 'scopeChanged';
  }
  if (error.code === 'SECURITY_FORBIDDEN') {
    return 'forbidden';
  }
  if (/^SECURITY_(TLS_REQUIRED|INVALID_ENDPOINT)$/.test(error.code)) {
    return 'transport';
  }
  if (/^SECURITY_(SOURCE_DENIED|ORIGIN_DENIED|PROXY_UNTRUSTED|CSRF_REQUIRED)$/.test(error.code)) {
    return 'source';
  }
  if (error.code === 'SECURITY_PROTOCOL_UNSUPPORTED') {
    return 'protocol';
  }
  if (error.code.startsWith('SECURITY_CONNECTION_')) {
    return 'closed';
  }
  return 'unavailable';
}

/** Registry credentials use Bearer authentication; legacy tokens retain their explicit protocol. */
export function connectionAuthHeaders(token: string): Record<string, string> {
  return token.startsWith('mdbt_v1_')
    ? { Authorization: `Bearer ${token}` }
    : { 'X-ModelDB-Connect-Token': token };
}

/** Decode safe machine-readable failures without retaining a response body in diagnostics. */
export async function remoteResponseError(response: Response): Promise<Error> {
  const text = await response.text();
  try {
    const raw = JSON.parse(text) as { error?: unknown; requestId?: unknown };
    if (typeof raw.error === 'string' && /^SECURITY_[A-Z0-9_]+$/.test(raw.error)) {
      return new ConnectionSecurityError(
        raw.error,
        response.status,
        typeof raw.requestId === 'string' ? raw.requestId : undefined,
      );
    }
    if (typeof raw.error === 'string' && raw.error.includes('VAULT_LEGACY_FORMAT')) {
      return new ConnectionSecurityError('VAULT_LEGACY_FORMAT', response.status);
    }
  } catch {
    /* Non-JSON legacy responses still carry their HTTP status. */
  }
  return new Error(`ModelDB HTTP ${response.status}: ${text.slice(0, 500)}`);
}

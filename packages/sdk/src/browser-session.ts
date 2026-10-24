import {
  connectionOrigin,
  assertSecureCredentialOrigin,
  type ConnectionEndpoint,
} from './connection-endpoint.js';
import { ConnectionSecurityError, remoteResponseError } from './connection-security.js';

export interface BrowserSessionConfig extends ConnectionEndpoint {
  readonly fetchImpl?: typeof fetch;
}

export interface BrowserSessionInfo {
  readonly version: 1;
  readonly expiresAt: string;
  readonly absoluteExpiresAt: string;
  readonly csrf: string;
  readonly actor?: unknown;
  readonly policyVersion?: number;
  readonly securityAdmin?: boolean;
  readonly requestId?: string;
}

// Only anti-CSRF proofs and non-secret metadata live in JS. Authentication stays HttpOnly.
const sessions = new Map<string, BrowserSessionInfo>();
const pending = new Map<string, Promise<BrowserSessionInfo>>();
const keepAlive = new Map<string, ReturnType<typeof setInterval>>();
let lastActivityAt = Date.now();
let activityInstalled = false;

function stopKeepAlive(origin: string): void {
  const timer = keepAlive.get(origin);
  if (timer !== undefined) {
    clearInterval(timer);
  }
  keepAlive.delete(origin);
}

function watchActivity(origin: string): void {
  if (typeof document === 'undefined' || keepAlive.has(origin)) {
    return;
  }
  if (!activityInstalled) {
    activityInstalled = true;
    for (const event of ['pointerdown', 'keydown']) {
      document.addEventListener(
        event,
        () => {
          lastActivityAt = Date.now();
        },
        { passive: true },
      );
    }
  }
  keepAlive.set(
    origin,
    setInterval(() => {
      if (document.visibilityState !== 'visible' || Date.now() - lastActivityAt > 5 * 60000) {
        return;
      }
      void ready(origin).catch(() => {
        stopKeepAlive(origin);
      });
    }, 60000),
  );
}

function secureOrigin(origin: string): void {
  assertSecureCredentialOrigin(origin, 'mdbt_v1_browser-session');
}

async function request<T>(
  origin: string,
  path: string,
  method: 'GET' | 'POST',
  fetchImpl: typeof fetch,
  body?: unknown,
  csrf?: string,
): Promise<T> {
  secureOrigin(origin);
  const response = await fetchImpl(`${origin}${path}`, {
    method,
    redirect: 'error',
    credentials: 'include',
    cache: 'no-store',
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(csrf ? { 'x-modeldb-csrf': csrf } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    if (response.status === 401) {
      sessions.delete(origin);
      stopKeepAlive(origin);
    }
    throw await remoteResponseError(response);
  }
  return (await response.json()) as T;
}

function remember(origin: string, info: BrowserSessionInfo): BrowserSessionInfo {
  if (
    info.version !== 1 ||
    !/^[a-f0-9]{64}$/.test(info.csrf) ||
    !Number.isFinite(Date.parse(info.expiresAt)) ||
    !Number.isFinite(Date.parse(info.absoluteExpiresAt))
  ) {
    throw new ConnectionSecurityError('SECURITY_PROTOCOL_UNSUPPORTED', 426);
  }
  sessions.set(origin, info);
  watchActivity(origin);
  return info;
}

/** Exchange an OS-issued, Origin-bound one-time pairing code for an HttpOnly cookie. */
export async function pairBrowserSession(
  config: BrowserSessionConfig,
  code: string,
): Promise<BrowserSessionInfo> {
  const origin = connectionOrigin(config);
  return remember(
    origin,
    await request<BrowserSessionInfo>(
      origin,
      '/api/v1/security/pair',
      'POST',
      config.fetchImpl ?? fetch,
      { code },
    ),
  );
}

/** Restore the anti-CSRF proof after a reload, without exposing the authentication cookie. */
export async function getBrowserSession(config: BrowserSessionConfig): Promise<BrowserSessionInfo> {
  const origin = connectionOrigin(config);
  return remember(
    origin,
    await request<BrowserSessionInfo>(
      origin,
      '/api/v1/security/session',
      'GET',
      config.fetchImpl ?? fetch,
    ),
  );
}

async function renew(
  origin: string,
  info: BrowserSessionInfo,
  fetchImpl: typeof fetch,
): Promise<BrowserSessionInfo> {
  return remember(
    origin,
    await request<BrowserSessionInfo>(
      origin,
      '/api/v1/security/session/refresh',
      'POST',
      fetchImpl,
      undefined,
      info.csrf,
    ),
  );
}

/** Serialize restoration/renewal per server; refresh only near expiry while in use. */
async function ready(
  origin: string,
  fetchImpl: typeof fetch = fetch,
  force = false,
): Promise<BrowserSessionInfo> {
  const inflight = pending.get(origin);
  if (inflight) {
    return inflight;
  }
  const work = (async () => {
    let info = sessions.get(origin);
    if (!info) {
      info = remember(
        origin,
        await request<BrowserSessionInfo>(origin, '/api/v1/security/session', 'GET', fetchImpl),
      );
    }
    const now = Date.now();
    if (Date.parse(info.expiresAt) <= now) {
      sessions.delete(origin);
      stopKeepAlive(origin);
      throw new ConnectionSecurityError('SECURITY_CREDENTIAL_EXPIRED', 401);
    }
    if (
      force ||
      (Date.parse(info.expiresAt) - now < 5 * 60000 &&
        Date.parse(info.absoluteExpiresAt) > Date.parse(info.expiresAt))
    ) {
      info = await renew(origin, info, fetchImpl);
    }
    return info;
  })();
  pending.set(origin, work);
  try {
    return await work;
  } finally {
    pending.delete(origin);
  }
}

export async function refreshBrowserSession(
  config: BrowserSessionConfig,
): Promise<BrowserSessionInfo> {
  return ready(connectionOrigin(config), config.fetchImpl ?? fetch, true);
}

/** Shared by RPC and all management APIs, including binary upload/download. */
export async function browserSessionRequestInit(
  origin: string,
): Promise<{ credentials: 'include'; headers: Record<string, string> }> {
  const info = await ready(origin);
  return { credentials: 'include', headers: { 'x-modeldb-csrf': info.csrf } };
}

export async function logoutBrowserSession(config: BrowserSessionConfig): Promise<void> {
  const origin = connectionOrigin(config);
  const info = await ready(origin, config.fetchImpl ?? fetch);
  await request(
    origin,
    '/api/v1/security/session/logout',
    'POST',
    config.fetchImpl ?? fetch,
    undefined,
    info.csrf,
  );
  sessions.delete(origin);
  stopKeepAlive(origin);
}

/** Read and immediately remove launcher secrets from the URL fragment. */
export function takeBrowserPairingLink(): { code: string; host: string; port: number } | undefined {
  if (typeof location === 'undefined' || typeof history === 'undefined') {
    return undefined;
  }
  const params = new URLSearchParams(location.hash.slice(1));
  if (!params.has('modeldb-pair')) {
    return undefined;
  }
  history.replaceState(history.state, '', `${location.pathname}${location.search}`);
  const code = params.get('modeldb-pair') ?? '';
  const endpoint = params.get('modeldb-server') ?? '';
  try {
    const url = new URL(endpoint);
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    const origin = connectionOrigin({ host: endpoint, port });
    secureOrigin(origin);
    if (!/^mdbp_v1_[a-zA-Z0-9-]{36}_[a-zA-Z0-9_-]{43}$/.test(code)) {
      return undefined;
    }
    return { code, host: origin, port };
  } catch {
    return undefined;
  }
}

import { logoutBrowserSession, takeBrowserPairingLink } from '@mode-db/sdk';

const PREFIX = 'model-designer:';
let activeToken = '';
let pairingLaunch = takeBrowserPairingLink();
export function getPairingLaunch(): typeof pairingLaunch {
  return pairingLaunch;
}
export function clearPairingLaunch(): void {
  pairingLaunch = undefined;
}
export function isBrowserSessionMode(): boolean {
  return safeGet('authMode') !== 'token';
}
export function persistBrowserSessionMode(browser: boolean): void {
  safeSet('authMode', browser ? 'browser' : 'token');
}
export function getConnectionAuth(): { token: string; browserSession: boolean } {
  return { token: getStoredToken(''), browserSession: isBrowserSessionMode() };
}
export function hasActiveConnection(): boolean {
  return safeGet('sessionActive') === 'true' || !!activeToken;
}
/** Navigation preference only; the server verifies the administrator session on every load. */
export function isSecurityCenterActive(): boolean {
  return safeGet('securityCenterActive') === 'true';
}
export function persistSecurityCenterActive(active: boolean): void {
  safeSet('securityCenterActive', String(active));
}
export async function logoutCurrentBrowserSession(): Promise<void> {
  if (isBrowserSessionMode())
    await logoutBrowserSession({ host: getStoredHost('127.0.0.1'), port: getStoredPort(9090) });
}

function purgeStoredCredentials(): void {
  for (const key of ['localStorage', 'sessionStorage'] as const) {
    try {
      const storage = globalThis[key];
      storage?.removeItem(PREFIX + 'token');
      storage?.removeItem(PREFIX + 'rememberToken');
    } catch {
      /* Storage can be unavailable in private browser contexts. */
    }
  }
}

function safeGet(key: string): string | null {
  if (typeof localStorage === 'undefined') {
    return null;
  }
  try {
    return localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  if (typeof localStorage === 'undefined') {
    return;
  }
  try {
    localStorage.setItem(PREFIX + key, value);
  } catch {
    /* quota / private mode */
  }
}

export function getStoredHost(fallback: string): string {
  const v = safeGet('host');
  return v != null && v.trim() !== '' ? v.trim() : fallback;
}

export function getStoredPort(fallback: number): number {
  const v = safeGet('port');
  if (v == null || v.trim() === '') {
    return fallback;
  }
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n < 65536 ? Math.floor(n) : fallback;
}

/** Public HTTP(S) origin advertised by the server; empty means use host/port. */
export function getStoredPublicBaseUrl(fallback = ''): string {
  const v = safeGet('publicBaseUrl');
  return normalizePublicBaseUrl(v != null && v.trim() !== '' ? v : fallback);
}

function normalizePublicBaseUrl(value: string): string {
  const candidate = value.trim();
  if (!candidate) {
    return '';
  }
  try {
    const parsed = new URL(candidate);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      return '';
    }
    return candidate.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

export function persistPublicBaseUrl(value: string): void {
  const normalized = normalizePublicBaseUrl(value);
  if (normalized) {
    safeSet('publicBaseUrl', normalized);
  } else {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(PREFIX + 'publicBaseUrl');
      }
    } catch {
      /* ignore */
    }
  }
}

/** 与服务器工作区下的逻辑库目录名一致；可被用户在门页修改并缓存。 */
export function getStoredWorkspace(fallback: string): string {
  const v = safeGet('workspace');
  return v != null && v.trim() !== '' ? v.trim() : fallback;
}

export function persistConnectionFields(host: string, port: number, workspace: string): void {
  safeSet('host', host.trim());
  safeSet('port', String(port));
  safeSet('workspace', workspace.trim());
}

export function getStoredToken(_fallback: string): string {
  purgeStoredCredentials();
  return activeToken;
}

export function persistToken(token: string): void {
  purgeStoredCredentials();
  activeToken = token;
}

export function clearStoredToken(): void {
  activeToken = '';
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(PREFIX + 'token');
    }
  } catch {
    /* ignore */
  }
}

export function getStoredLastLibrary(fallback: string): string {
  const v = safeGet('lastLibrary');
  return v != null && v.trim() !== '' ? v.trim() : fallback;
}

export function persistLastLibrary(name: string): void {
  safeSet('lastLibrary', name.trim());
}

/** Advanced service credentials stay in memory; browser authentication uses HttpOnly cookies. */
export function getSessionToken(): string | null {
  purgeStoredCredentials();
  return activeToken || null;
}

export function persistSessionToken(token: string): void {
  persistToken(token);
  safeSet('sessionActive', 'true');
}

export function clearSessionToken(): void {
  purgeStoredCredentials();
  activeToken = '';
  safeSet('sessionActive', 'false');
  persistSecurityCenterActive(false);
}

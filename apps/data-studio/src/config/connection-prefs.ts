const PREFIX = 'data-studio:';

/** Active workspace session TTL after last connect or activity touch. */
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export interface RestorableSession {
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly library: string;
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
    /* ignore */
  }
}

function safeRemove(key: string): void {
  if (typeof localStorage === 'undefined') {
    return;
  }
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    /* ignore */
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

export function getStoredToken(fallback: string): string {
  const v = safeGet('token');
  return v != null ? v : fallback;
}

export function getStoredLibrary(fallback: string): string {
  const v = safeGet('library');
  return v != null && v.trim() !== '' ? v.trim() : fallback;
}

export function persistConnection(host: string, port: number, token: string): void {
  safeSet('host', host.trim());
  safeSet('port', String(port));
  safeSet('token', token);
}

export function persistLibrary(name: string): void {
  safeSet('library', name.trim());
}

export function getStoredModel(fallback: string): string {
  const v = safeGet('model');
  return v != null && v.trim() !== '' ? v.trim() : fallback;
}

export function persistModel(name: string): void {
  safeSet('model', name.trim());
}

/** Marks the current connection as an active session with expiry. */
export function persistActiveSession(ttlMs: number = SESSION_TTL_MS): void {
  safeSet('sessionExpiresAt', String(Date.now() + ttlMs));
}

/** Clears auto-restore session (manual disconnect). Credentials/library prefs are kept for the form. */
export function clearActiveSession(): void {
  safeRemove('sessionExpiresAt');
}

/** Returns true when a non-expired session exists with library + token. */
export function isSessionValid(nowMs: number = Date.now()): boolean {
  const expRaw = safeGet('sessionExpiresAt');
  if (expRaw == null || expRaw.trim() === '') {
    return false;
  }
  const expiresAt = Number(expRaw);
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) {
    return false;
  }
  const library = getStoredLibrary('');
  const token = getStoredToken('');
  return library.trim() !== '' && token.trim() !== '';
}

/** Session payload for silent reconnect after page refresh. */
export function getRestorableSession(nowMs: number = Date.now()): RestorableSession | null {
  if (!isSessionValid(nowMs)) {
    return null;
  }
  const library = getStoredLibrary('');
  const token = getStoredToken('');
  if (library.trim() === '' || token.trim() === '') {
    return null;
  }
  return {
    host: getStoredHost('127.0.0.1'),
    port: getStoredPort(8765),
    token,
    library,
  };
}

let lastSessionTouchMs = 0;

/** Extends session expiry (throttled) while the user is active in the workspace. */
export function touchActiveSession(
  ttlMs: number = SESSION_TTL_MS,
  nowMs: number = Date.now(),
): void {
  if (!isSessionValid(nowMs)) {
    return;
  }
  if (nowMs - lastSessionTouchMs < 5 * 60 * 1000) {
    return;
  }
  lastSessionTouchMs = nowMs;
  persistActiveSession(ttlMs);
}

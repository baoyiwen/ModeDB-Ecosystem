/** How long a successful connect stays valid without re-auth (sliding window on activity). */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const LS_SESSION = 'modedb.playground.session';

export interface PlaygroundSessionRecord {
  readonly expiresAt: number;
}

export function loadPlaygroundSession(): PlaygroundSessionRecord | null {
  try {
    const raw = localStorage.getItem(LS_SESSION);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof (parsed as PlaygroundSessionRecord).expiresAt !== 'number'
    ) {
      return null;
    }
    return parsed as PlaygroundSessionRecord;
  } catch {
    return null;
  }
}

export function isPlaygroundSessionValid(session: PlaygroundSessionRecord | null): boolean {
  return session !== null && Date.now() < session.expiresAt;
}

/** Mark session active; extends expiry from now. */
export function touchPlaygroundSession(): void {
  try {
    const record: PlaygroundSessionRecord = { expiresAt: Date.now() + SESSION_TTL_MS };
    localStorage.setItem(LS_SESSION, JSON.stringify(record));
  } catch {
    /* ignore */
  }
}

export function clearPlaygroundSession(): void {
  try {
    localStorage.removeItem(LS_SESSION);
  } catch {
    /* ignore */
  }
}

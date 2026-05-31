const PREFIX = 'model-designer:';

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

export function getRememberToken(): boolean {
  return safeGet('rememberToken') === '1';
}

export function setRememberToken(v: boolean): void {
  safeSet('rememberToken', v ? '1' : '0');
}

export function getStoredToken(fallback: string): string {
  const v = safeGet('token');
  return v != null ? v : fallback;
}

export function persistToken(token: string): void {
  safeSet('token', token);
}

export function clearStoredToken(): void {
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

/**
 * 标签页生命周期内的 token 缓存：用于 F5 后无感重连，但**关闭标签页即消失**。
 * 与 {@link persistToken}（localStorage、跨会话）独立，二者读取时优先 session。
 */
function safeSessionGet(key: string): string | null {
  if (typeof sessionStorage === 'undefined') {
    return null;
  }
  try {
    return sessionStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

function safeSessionSet(key: string, value: string): void {
  if (typeof sessionStorage === 'undefined') {
    return;
  }
  try {
    sessionStorage.setItem(PREFIX + key, value);
  } catch {
    /* quota / private mode */
  }
}

function safeSessionRemove(key: string): void {
  if (typeof sessionStorage === 'undefined') {
    return;
  }
  try {
    sessionStorage.removeItem(PREFIX + key);
  } catch {
    /* ignore */
  }
}

export function getSessionToken(): string | null {
  const v = safeSessionGet('token');
  return v != null && v !== '' ? v : null;
}

export function persistSessionToken(token: string): void {
  safeSessionSet('token', token);
}

export function clearSessionToken(): void {
  safeSessionRemove('token');
}

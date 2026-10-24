import type { RemoteModelDBClient } from '@mode-db/sdk';
import {
  getSessionToken,
  getStoredPublicBaseUrl,
  getStoredHost,
  getStoredPort,
  getStoredToken,
  isBrowserSessionMode,
} from '../config/connection-prefs.js';
import { openWorkspaceSession } from './workspace-session.js';

export interface BusinessConnectionParams {
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly browserSession: boolean;
  readonly publicBaseUrl: string;
}

/**
 * 读取当前标签页可用的引擎连接参数（与保存 / catalog 拉取一致）。
 */
export function resolveBusinessConnectionParams(): BusinessConnectionParams {
  return {
    host: getStoredHost(import.meta.env.VITE_MODE_DB_HOST ?? '127.0.0.1'),
    port: getStoredPort(Number(import.meta.env.VITE_MODE_DB_PORT ?? 9090) || 9090),
    token: getSessionToken() ?? getStoredToken(''),
    browserSession: isBrowserSessionMode(),
    publicBaseUrl: getStoredPublicBaseUrl(import.meta.env.VITE_MODE_DB_PUBLIC_BASE_URL ?? ''),
  };
}

/**
 * 打开**业务逻辑库**的短生命周期 WebSocket 会话并执行回调。
 * 行数据清除 / schema 注册等 Engine 层操作须走业务库，而非设计器专属库。
 */
export async function withBusinessLibrarySession<T>(
  libraryCode: string,
  fn: (client: RemoteModelDBClient) => Promise<T>,
): Promise<T> {
  const code = libraryCode.trim();
  if (!code) {
    throw new Error('BUSINESS_LIBRARY_CODE_REQUIRED');
  }
  const { host, port, token, browserSession } = resolveBusinessConnectionParams();
  if (!token.trim() && !browserSession) {
    throw new Error('BUSINESS_LIBRARY_TOKEN_REQUIRED');
  }
  const client = await openWorkspaceSession({ host, port, token, browserSession, workspace: code });
  try {
    return await fn(client);
  } finally {
    try {
      client.close();
    } catch {
      /* ignore */
    }
  }
}

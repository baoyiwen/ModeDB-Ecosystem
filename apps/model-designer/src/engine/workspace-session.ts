import { RemoteModelDBClient } from '@mode-db/sdk';
import { isBrowserSessionMode } from '../config/connection-prefs.js';

export interface WorkspaceSessionOptions {
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly browserSession?: boolean;
  readonly workspace: string;
}

/**
 * 直接建立到指定逻辑库的 WebSocket 加密会话。底层调用，**不**做存在性预校验，
 * 由握手与后续 push/pull 自行失败暴露。一般情况下应该使用
 * {@link ensureDesignerWorkspaceSession}，以保证连接的是设计器专属库。
 */
export async function openWorkspaceSession(
  opts: WorkspaceSessionOptions,
): Promise<RemoteModelDBClient> {
  const workspace = opts.workspace.trim();
  return RemoteModelDBClient.connectNetwork({
    host: opts.host.trim(),
    port: opts.port,
    token: opts.token.trim(),
    browserSession: opts.browserSession ?? isBrowserSessionMode(),
    database: workspace,
  });
}

export interface DesignerWorkspaceSessionOptions {
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly browserSession?: boolean;
  /** 设计器专属逻辑库名；与用户的业务库**完全分离**，缺失时自动 `createDatabase`。 */
  readonly designerWorkspace: string;
}

/**
 * 打开**设计器专属库**的 WebSocket 会话，确保不会污染用户的业务库：
 *
 * 1. 通过 management REST 列出现有逻辑库；
 * 2. 若 `designerWorkspace` 缺失则 `createDatabase` 创建之；
 * 3. 然后再走 {@link openWorkspaceSession} 建立 WebSocket。
 *
 * 调用方仍然可以将用户选择的业务库名（仅作为逻辑标签）传入
 * `seedDefaultWorkspaceRecords` 写入 `sys_data_asset_map.code` —— 但**会话连接的依然是
 * 设计器库**，所有 `sys_*` 元数据与图谱快照都集中在这里。
 */
export async function ensureDesignerWorkspaceSession(
  opts: DesignerWorkspaceSessionOptions,
): Promise<RemoteModelDBClient> {
  const designerDb = opts.designerWorkspace.trim();
  const host = opts.host.trim();
  const port = opts.port;
  const token = opts.token.trim();
  const browserSession = opts.browserSession ?? isBrowserSessionMode();
  const list = await RemoteModelDBClient.listDatabases({ host, port, token, browserSession });
  if (!list.some((d) => d.name === designerDb)) {
    await RemoteModelDBClient.createDatabase({
      host,
      port,
      token,
      browserSession,
      name: designerDb,
    });
  }
  return openWorkspaceSession({ host, port, token, browserSession, workspace: designerDb });
}

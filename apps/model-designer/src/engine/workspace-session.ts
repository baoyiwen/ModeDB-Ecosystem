import { RemoteModelDBClient } from '@mode-db/sdk';

export interface WorkspaceSessionOptions {
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly workspace: string;
}

/**
 * 建立经 SDK 的 WebSocket 加密会话。
 * 不在此预校验逻辑库是否出现在管理 API 列表或 catalog（由握手与后续 push/pull 自行失败暴露）。
 */
export async function openWorkspaceSession(
  opts: WorkspaceSessionOptions,
): Promise<RemoteModelDBClient> {
  const workspace = opts.workspace.trim();
  return RemoteModelDBClient.connectNetwork({
    host: opts.host.trim(),
    port: opts.port,
    token: opts.token.trim(),
    database: workspace,
  });
}

import { RemoteModelDBClient } from '@mode-db/sdk';
import { bytesToBase64Url, base64UrlToBytes } from '../persistence/mldg-binary.js';

/**
 * 逻辑库内需存在该模型（Authoring 注册），字段含 `graph_b64`、`updated_at`（String）及标准 `_id`。
 * 见 `AGENTS.md` 服务端元数据约定。
 */
export const DESIGNER_SNAPSHOT_MODEL = 'sys_designer_graph';

function hydrateRowData(row: unknown): Record<string, unknown> {
  if (
    row &&
    typeof row === 'object' &&
    'getData' in row &&
    typeof (row as { getData?: unknown }).getData === 'function'
  ) {
    return (row as { getData: () => Record<string, unknown> }).getData();
  }
  throw new Error('DESIGNER_SYNC_BAD_ROW');
}

/**
 * 将 UTF-8 图谱字节经 base64url 嵌入写行，经 SDK `insertMany` 走 WebSocket 加密载荷。
 */
export async function pushDesignerSnapshot(
  client: RemoteModelDBClient,
  wireBytes: Uint8Array,
): Promise<void> {
  const graph_b64 = bytesToBase64Url(wireBytes);
  const updated_at = new Date().toISOString();
  const _id = crypto.randomUUID();
  const m = client.model(DESIGNER_SNAPSHOT_MODEL);
  const { failureCount } = await m.insertMany(
    [
      {
        _id,
        graph_b64,
        updated_at,
      },
    ],
    { sync: true },
  );
  if (failureCount > 0) {
    throw new Error('DESIGNER_SYNC_INSERT_FAILED');
  }
}

/**
 * 读取该模型最新快照行（按 `updated_at` 字典序最大）。
 */
export async function pullLatestDesignerSnapshot(client: RemoteModelDBClient): Promise<Uint8Array> {
  const raw = await client.model(DESIGNER_SNAPSHOT_MODEL).query().execute();
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('DESIGNER_SYNC_EMPTY');
  }
  type Row = { graph_b64?: string; updated_at?: string };
  const parsed: Row[] = raw.map((r) => {
    const d = hydrateRowData(r) as Record<string, unknown>;
    return {
      graph_b64: typeof d.graph_b64 === 'string' ? d.graph_b64 : undefined,
      updated_at: typeof d.updated_at === 'string' ? d.updated_at : '',
    };
  });
  parsed.sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
  const best = parsed[0];
  if (!best?.graph_b64) {
    throw new Error('DESIGNER_SYNC_NO_PAYLOAD');
  }
  return base64UrlToBytes(best.graph_b64);
}

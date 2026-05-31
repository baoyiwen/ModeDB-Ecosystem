import { RemoteModelDBClient } from '@mode-db/sdk';
import { bytesToBase64Url, base64UrlToBytes } from '../persistence/mldg-binary.js';

/**
 * 设计器图谱快照行模型。注入到设计器专属逻辑库（`FIXED_MODEL_DESIGNER_DATABASE`），
 * 单库内多个业务库的快照通过 `library_code` 字段做隔离 —— 见 `designer-storage-init.ts`。
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
 * 必须传入业务库的 `library_code`，用以在共享元数据库内隔离多业务库快照。
 */
export async function pushDesignerSnapshot(
  client: RemoteModelDBClient,
  wireBytes: Uint8Array,
  libraryCode: string,
): Promise<void> {
  const code = libraryCode.trim();
  if (!code) {
    throw new Error('DESIGNER_SYNC_NO_LIBRARY_CODE');
  }
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
        library_code: code,
      },
    ],
    { sync: true },
  );
  if (failureCount > 0) {
    throw new Error('DESIGNER_SYNC_INSERT_FAILED');
  }
}

/**
 * 读取指定业务库的最新快照行（按 `library_code` 过滤后按 `updated_at` 字典序最大）。
 */
export async function pullLatestDesignerSnapshot(
  client: RemoteModelDBClient,
  libraryCode: string,
): Promise<Uint8Array> {
  const code = libraryCode.trim();
  if (!code) {
    throw new Error('DESIGNER_SYNC_NO_LIBRARY_CODE');
  }
  const raw = await client.model(DESIGNER_SNAPSHOT_MODEL).query().execute();
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('DESIGNER_SYNC_EMPTY');
  }
  type Row = { graph_b64?: string; updated_at?: string; library_code?: string };
  const parsed: Row[] = raw.map((r) => {
    const d = hydrateRowData(r) as Record<string, unknown>;
    return {
      graph_b64: typeof d.graph_b64 === 'string' ? d.graph_b64 : undefined,
      updated_at: typeof d.updated_at === 'string' ? d.updated_at : '',
      library_code: typeof d.library_code === 'string' ? d.library_code : '',
    };
  });
  const scoped = parsed.filter((r) => r.library_code === code);
  if (scoped.length === 0) {
    throw new Error('DESIGNER_SYNC_EMPTY');
  }
  scoped.sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
  const best = scoped[0];
  if (!best?.graph_b64) {
    throw new Error('DESIGNER_SYNC_NO_PAYLOAD');
  }
  return base64UrlToBytes(best.graph_b64);
}

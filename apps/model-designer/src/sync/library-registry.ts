import type { RemoteModelDBClient } from '@mode-db/sdk';
import { SYS_DATA_ASSET_MAP } from '../bootstrap/designer-storage-init.js';
import type { LibraryRegistryDraft, LibraryRegistryRecord } from '../types/library-registry.js';
import { resolveI18nForLocale } from '../utils/i18n-resolve.js';

function hydrateRowData(row: unknown): Record<string, unknown> {
  if (
    row &&
    typeof row === 'object' &&
    'getData' in row &&
    typeof (row as { getData?: unknown }).getData === 'function'
  ) {
    return (row as { getData: () => Record<string, unknown> }).getData();
  }
  throw new Error('LIBRARY_REGISTRY_BAD_ROW');
}

function asI18nMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') {
      out[k] = v;
    }
  }
  return out;
}

function rowToRecord(row: Record<string, unknown>): LibraryRegistryRecord | null {
  const id = typeof row._id === 'string' ? row._id : '';
  const code = typeof row.code === 'string' ? row.code.trim() : '';
  if (!code) {
    return null;
  }
  return {
    id,
    code,
    name: asI18nMap(row.name),
    description: asI18nMap(row.description),
  };
}

/** 选择列表展示：`显示名 [唯一 code]`。 */
export function formatLibraryLabel(
  record: Pick<LibraryRegistryRecord, 'code' | 'name'>,
  locale: string,
): string {
  const display = resolveI18nForLocale(record.name, locale, '').trim();
  if (!display || display === record.code) {
    return record.code;
  }
  return `${display} [${record.code}]`;
}

/** 读取设计器库内全部逻辑库登记。 */
export async function listLibraryRegistry(
  client: RemoteModelDBClient,
): Promise<LibraryRegistryRecord[]> {
  const rows = await client.model(SYS_DATA_ASSET_MAP).query().execute();
  const list = Array.isArray(rows) ? rows.map((r) => hydrateRowData(r)) : [];
  const out: LibraryRegistryRecord[] = [];
  for (const row of list) {
    const rec = rowToRecord(row);
    if (rec) {
      out.push(rec);
    }
  }
  out.sort((a, b) => a.code.localeCompare(b.code));
  return out;
}

/** 按 `code` 查询单条登记。 */
export async function getLibraryByCode(
  client: RemoteModelDBClient,
  code: string,
): Promise<LibraryRegistryRecord | null> {
  const trimmed = code.trim();
  if (!trimmed) {
    return null;
  }
  const all = await listLibraryRegistry(client);
  return all.find((r) => r.code === trimmed) ?? null;
}

/**
 * 将物理库名列表与登记行合并；无登记行时用 `code` 占位展示名。
 */
export function mergeLibraryRegistryWithDbNames(
  dbNames: readonly string[],
  registry: readonly LibraryRegistryRecord[],
): LibraryRegistryRecord[] {
  const byCode = new Map(registry.map((r) => [r.code, r]));
  return dbNames.map((code) => {
    const hit = byCode.get(code);
    if (hit) {
      return hit;
    }
    return {
      id: '',
      code,
      name: { en: code, zh: code, ja: code },
      description: {},
    };
  });
}

/** 新建或补齐 `sys_data_asset_map` 行（`code` 幂等）。 */
export async function ensureLibraryRecord(
  client: RemoteModelDBClient,
  draft: LibraryRegistryDraft,
): Promise<LibraryRegistryRecord> {
  const code = draft.code.trim();
  if (!code) {
    throw new Error('LIBRARY_REGISTRY_CODE_REQUIRED');
  }
  const existing = await getLibraryByCode(client, code);
  if (existing) {
    if (existing.id) {
      return existing;
    }
  }

  const name = Object.keys(draft.name).length > 0 ? draft.name : { en: code, zh: code, ja: code };
  const description = draft.description ?? {};

  const { failureCount } = await client.model(SYS_DATA_ASSET_MAP).insertMany(
    [
      {
        _id: crypto.randomUUID(),
        code,
        name,
        description,
      },
    ],
    { sync: true },
  );
  if (failureCount > 0) {
    throw new Error('LIBRARY_REGISTRY_INSERT_FAILED');
  }
  const created = await getLibraryByCode(client, code);
  if (!created) {
    throw new Error('LIBRARY_REGISTRY_INSERT_FAILED');
  }
  return created;
}

/** 更新显示名 / 描述（`code` 不可变）。 */
export async function updateLibraryMetadata(
  client: RemoteModelDBClient,
  record: Pick<LibraryRegistryRecord, 'id' | 'code'>,
  patch: { name: Record<string, string>; description: Record<string, string> },
): Promise<LibraryRegistryRecord> {
  const code = record.code.trim();
  if (!code) {
    throw new Error('LIBRARY_REGISTRY_CODE_REQUIRED');
  }

  if (record.id) {
    const { failureCount } = await client.batchUpdate(
      [
        {
          model: SYS_DATA_ASSET_MAP,
          id: record.id,
          partial: {
            name: patch.name,
            description: patch.description,
          },
        },
      ],
      { sync: true },
    );
    if (failureCount > 0) {
      throw new Error('LIBRARY_REGISTRY_UPDATE_FAILED');
    }
  } else {
    await ensureLibraryRecord(client, {
      code,
      name: patch.name,
      description: patch.description,
    });
  }

  const next = await getLibraryByCode(client, code);
  if (!next) {
    throw new Error('LIBRARY_REGISTRY_UPDATE_FAILED');
  }
  return next;
}

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
    const data = { ...(row as { getData: () => Record<string, unknown> }).getData() };
    if (typeof data._id !== 'string' || data._id.length === 0) {
      try {
        const id = (row as { id?: unknown }).id;
        if (typeof id === 'string' && id.length > 0) {
          data._id = id;
        }
      } catch {
        /* Older row handles may not expose id outside getData(). */
      }
    }
    return data;
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

/** 同 code 出现重复登记时，优先保留信息更完整且不是兜底 code 的记录。 */
function sameI18nMap(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a).filter((k) => a[k] !== '');
  const bKeys = Object.keys(b).filter((k) => b[k] !== '');
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  return aKeys.every((key) => a[key] === b[key]);
}

function scoreLibraryRecord(record: LibraryRegistryRecord): number {
  const code = record.code.trim();
  let score = record.id ? 1 : 0;
  for (const raw of Object.values(record.name)) {
    const value = raw.trim();
    if (!value) {
      continue;
    }
    score += value === code ? 1 : 10;
  }
  for (const raw of Object.values(record.description)) {
    if (raw.trim()) {
      score += 3;
    }
  }
  return score;
}

function pickPreferredLibraryRecord(
  records: readonly LibraryRegistryRecord[],
): LibraryRegistryRecord | null {
  let best: LibraryRegistryRecord | null = null;
  let bestScore = -1;
  for (const record of records) {
    const score = scoreLibraryRecord(record);
    if (score > bestScore) {
      best = record;
      bestScore = score;
    }
  }
  return best;
}

/** 选择列表展示：`显示名[唯一 code]`。 */
export function formatLibraryLabel(
  record: Pick<LibraryRegistryRecord, 'code' | 'name'>,
  locale: string,
): string {
  const display = resolveI18nForLocale(record.name, locale, '').trim();
  if (!display || display === record.code) {
    return record.code;
  }
  return `${display}[${record.code}]`;
}

/** 读取设计器库内全部逻辑库登记。 */
export async function listLibraryRegistry(
  client: RemoteModelDBClient,
): Promise<LibraryRegistryRecord[]> {
  const rows = await client.model(SYS_DATA_ASSET_MAP).query().execute();
  const list = Array.isArray(rows) ? rows.map((r) => hydrateRowData(r)) : [];
  const latestById = new Map<string, Record<string, unknown>>();
  const withoutId: Record<string, unknown>[] = [];
  for (const row of list) {
    const id = typeof row._id === 'string' ? row._id : '';
    if (id) {
      latestById.set(id, row);
    } else {
      withoutId.push(row);
    }
  }
  const out: LibraryRegistryRecord[] = [];
  for (const row of [...latestById.values(), ...withoutId]) {
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
  return pickPreferredLibraryRecord(all.filter((r) => r.code === trimmed));
}

/**
 * 将物理库名列表与登记行合并；无登记行时用 `code` 占位展示名。
 */
export function mergeLibraryRegistryWithDbNames(
  dbNames: readonly string[],
  registry: readonly LibraryRegistryRecord[],
): LibraryRegistryRecord[] {
  const groups = new Map<string, LibraryRegistryRecord[]>();
  for (const record of registry) {
    groups.set(record.code, [...(groups.get(record.code) ?? []), record]);
  }
  const byCode = new Map<string, LibraryRegistryRecord>();
  for (const [code, records] of groups) {
    const preferred = pickPreferredLibraryRecord(records);
    if (preferred) {
      byCode.set(code, preferred);
    }
  }
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

  const matchingRecords = await listLibraryRegistry(client);
  const targetIds = new Set<string>();
  if (record.id) {
    targetIds.add(record.id);
  }
  for (const rec of matchingRecords) {
    if (rec.code === code && rec.id) {
      targetIds.add(rec.id);
    }
  }

  if (targetIds.size > 0) {
    const { failureCount } = await client.batchUpdate(
      [...targetIds].map((id) => ({
        model: SYS_DATA_ASSET_MAP,
        id,
        partial: {
          name: patch.name,
          description: patch.description,
        },
      })),
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
  if (!sameI18nMap(next.name, patch.name) || !sameI18nMap(next.description, patch.description)) {
    throw new Error('LIBRARY_REGISTRY_UPDATE_NOT_PERSISTED');
  }
  return next;
}

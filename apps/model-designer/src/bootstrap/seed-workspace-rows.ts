import type { RemoteModelDBClient } from '@mode-db/sdk';
import { SYS_LAYER_TYPE } from './designer-storage-init.js';
import { ensureLibraryRecord } from '../sync/library-registry.js';
import type { LibraryRegistryDraft } from '../types/library-registry.js';
import { createUuid } from '../utils/random-id.js';

function hydrateRowData(row: unknown): Record<string, unknown> {
  if (
    row &&
    typeof row === 'object' &&
    'getData' in row &&
    typeof (row as { getData?: unknown }).getData === 'function'
  ) {
    return (row as { getData: () => Record<string, unknown> }).getData();
  }
  throw new Error('SEED_BAD_ROW');
}

/**
 * 首次进入时写入与当前连接一致的最小元数据行：**sys_data_asset_map**（当前逻辑库）、
 * 默认 **sys_layer_type**（`group` / `page`）。若已存在相同 `code` 则跳过，幂等。
 */
export async function seedDefaultWorkspaceRecords(
  client: RemoteModelDBClient,
  workspaceLogicalName: string,
  libraryMeta?: Pick<LibraryRegistryDraft, 'name' | 'description'>,
): Promise<void> {
  const code = workspaceLogicalName.trim();
  if (!code) {
    return;
  }

  await ensureLibraryRecord(client, {
    code,
    name:
      libraryMeta?.name && Object.keys(libraryMeta.name).length > 0
        ? libraryMeta.name
        : { en: code, zh: code, ja: code },
    description: libraryMeta?.description ?? {},
  });

  const typeRows = await client.model(SYS_LAYER_TYPE).query().execute();
  const types = Array.isArray(typeRows) ? typeRows.map((r) => hydrateRowData(r)) : [];
  const existingCodes = new Set(
    types.map((r) => (typeof r.code === 'string' ? r.code : '')).filter(Boolean),
  );

  const defaults: Array<{ code: string; name: string; description: string }> = [
    { code: 'group', name: 'Group', description: '' },
    { code: 'page', name: 'Page', description: '' },
  ];

  const toInsert = defaults.filter((d) => !existingCodes.has(d.code));
  if (toInsert.length === 0) {
    return;
  }

  const { failureCount } = await client.model(SYS_LAYER_TYPE).insertMany(
    toInsert.map((d) => ({
      _id: createUuid(),
      code: d.code,
      name: d.name,
      description: d.description,
    })),
    { sync: true },
  );
  if (failureCount > 0) {
    throw new Error('SEED_LAYER_TYPE_FAILED');
  }
}

import type { RemoteModelDBClient } from '@mode-db/sdk';
import { SYS_DATA_ASSET_MAP, SYS_LAYER_TYPE } from './designer-storage-init.js';

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

const emptyI18n = (): Record<string, string> => ({ en: '', zh: '', ja: '' });

const labelI18n = (s: string): Record<string, string> => ({
  en: s,
  zh: s,
  ja: s,
});

/**
 * 首次进入时写入与当前连接一致的最小元数据行：**sys_data_asset_map**（当前逻辑库）、
 * 默认 **sys_layer_type**（`group` / `page`）。若已存在相同 `code` 则跳过，幂等。
 * 其余字段按「无则空」：I18N 用空字典，可选标量省略或由引擎默认。
 */
export async function seedDefaultWorkspaceRecords(
  client: RemoteModelDBClient,
  workspaceLogicalName: string,
): Promise<void> {
  const code = workspaceLogicalName.trim();
  if (!code) {
    return;
  }

  const assetRows = await client.model(SYS_DATA_ASSET_MAP).query().execute();
  const assets = Array.isArray(assetRows) ? assetRows.map((r) => hydrateRowData(r)) : [];
  const hasAsset = assets.some((r) => r.code === code);
  if (!hasAsset) {
    const { failureCount } = await client.model(SYS_DATA_ASSET_MAP).insertMany(
      [
        {
          _id: crypto.randomUUID(),
          code,
          name: labelI18n(code),
          description: emptyI18n(),
        },
      ],
      { sync: true },
    );
    if (failureCount > 0) {
      throw new Error('SEED_ASSET_MAP_FAILED');
    }
  }

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
      _id: crypto.randomUUID(),
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

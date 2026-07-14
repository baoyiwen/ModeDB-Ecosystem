import type { RemoteModelDBClient } from '@mode-db/sdk';
import { SYS_QUERY_INTERFACE } from '../bootstrap/designer-storage-init.js';
import type { QueryChainState, QueryInterface } from '../query-designer/index.js';

export interface QueryInterfaceRegistryRecord {
  id: string;
  name: string;
  queryInterface: QueryInterface;
  queryChain: QueryChainState;
  createdAt: string;
  updatedAt: string;
  signature?: string;
  projectionConfigured?: boolean;
}

function hydrateRowData(row: unknown): Record<string, unknown> {
  if (
    row &&
    typeof row === 'object' &&
    'getData' in row &&
    typeof (row as { getData?: unknown }).getData === 'function'
  ) {
    const data = { ...(row as { getData: () => Record<string, unknown> }).getData() };
    if (typeof data._id !== 'string' || !data._id) {
      const id = (row as { id?: unknown }).id;
      if (typeof id === 'string' && id) {
        data._id = id;
      }
    }
    return data;
  }
  throw new Error('QUERY_INTERFACE_REGISTRY_BAD_ROW');
}

function parseJson<T>(value: unknown): T | undefined {
  if (typeof value !== 'string' || !value) {
    return undefined;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function rowToRecord(row: Record<string, unknown>): QueryInterfaceRegistryRecord | undefined {
  const id = typeof row._id === 'string' ? row._id : '';
  const name = typeof row.display_name === 'string' ? row.display_name.trim() : '';
  const queryInterface = parseJson<QueryInterface>(row.query_json);
  const queryChain = parseJson<QueryChainState>(row.chain_json);
  if (!id || !name || !queryInterface || queryInterface.kind !== 'query' || !queryChain) {
    return undefined;
  }
  return {
    id,
    name,
    queryInterface,
    queryChain,
    createdAt:
      typeof row.created_at === 'string' ? row.created_at : queryInterface.lifecycle.createdAt,
    updatedAt:
      typeof row.updated_at === 'string' ? row.updated_at : queryInterface.lifecycle.updatedAt,
    signature: typeof row.signature === 'string' && row.signature ? row.signature : undefined,
    projectionConfigured: row.projection_configured === true,
  };
}

function recordPartial(
  record: QueryInterfaceRegistryRecord,
  libraryCode: string,
): Record<string, unknown> {
  return {
    library_code: libraryCode,
    display_name: record.name,
    description: record.queryInterface.description ?? '',
    query_json: JSON.stringify(record.queryInterface),
    chain_json: JSON.stringify(record.queryChain),
    signature: record.signature ?? '',
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    projection_configured: record.projectionConfigured === true,
  };
}

export async function listQueryInterfaceRegistry(
  client: RemoteModelDBClient,
  libraryCode: string,
): Promise<QueryInterfaceRegistryRecord[]> {
  const code = libraryCode.trim();
  if (!code) {
    throw new Error('QUERY_INTERFACE_REGISTRY_LIBRARY_REQUIRED');
  }
  const raw = await client.model(SYS_QUERY_INTERFACE).query().execute();
  const scopedRows = (Array.isArray(raw) ? raw : [])
    .map((row) => hydrateRowData(row))
    .filter((row) => row.library_code === code);
  return scopedRows
    .map((row) => rowToRecord(row))
    .filter((record): record is QueryInterfaceRegistryRecord => Boolean(record))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function upsertQueryInterfaceRegistry(
  client: RemoteModelDBClient,
  libraryCode: string,
  record: QueryInterfaceRegistryRecord,
): Promise<void> {
  const code = libraryCode.trim();
  if (!code) {
    throw new Error('QUERY_INTERFACE_REGISTRY_LIBRARY_REQUIRED');
  }
  const partial = recordPartial(record, code);
  const rows = await client.model(SYS_QUERY_INTERFACE).query().execute();
  const exists = (Array.isArray(rows) ? rows : [])
    .map((row) => hydrateRowData(row))
    .some((row) => row._id === record.id && row.library_code === code);
  if (exists) {
    const { failureCount } = await client.batchUpdate(
      [{ model: SYS_QUERY_INTERFACE, id: record.id, partial }],
      { sync: true },
    );
    if (failureCount > 0) {
      throw new Error('QUERY_INTERFACE_REGISTRY_UPDATE_FAILED');
    }
    return;
  }
  const { failureCount } = await client
    .model(SYS_QUERY_INTERFACE)
    .insertMany([{ _id: record.id, ...partial }], { sync: true });
  if (failureCount > 0) {
    throw new Error('QUERY_INTERFACE_REGISTRY_INSERT_FAILED');
  }
}

export async function deleteQueryInterfaceRegistry(
  client: RemoteModelDBClient,
  libraryCode: string,
  id: string,
): Promise<void> {
  if (!libraryCode.trim() || !id) {
    return;
  }
  const rows = await client.model(SYS_QUERY_INTERFACE).query().execute();
  const exists = (Array.isArray(rows) ? rows : [])
    .map((row) => hydrateRowData(row))
    .some((row) => row._id === id && row.library_code === libraryCode.trim());
  if (!exists) {
    return;
  }
  const { failureCount } = await client.batchDelete([{ model: SYS_QUERY_INTERFACE, id }], {
    sync: true,
  });
  if (failureCount > 0) {
    throw new Error('QUERY_INTERFACE_REGISTRY_DELETE_FAILED');
  }
}

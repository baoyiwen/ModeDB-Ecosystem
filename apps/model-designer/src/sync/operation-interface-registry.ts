import type { RemoteModelDBClient } from '@mode-db/sdk';
import { SYS_OPERATION_INTERFACE } from '../bootstrap/designer-storage-init.js';
import {
  migrateOperationInterfaceContract,
  type OperationInterface,
  type OperationInterfaceRelease,
} from '../query-designer/index.js';

export interface OperationInterfaceRegistryRecord {
  id: string;
  storageId?: string;
  name: string;
  operationInterface: OperationInterface;
  createdAt: string;
  updatedAt: string;
  signature?: string;
  publishedRelease?: OperationInterfaceRelease;
  releaseHistory?: OperationInterfaceRelease[];
}

export async function listOperationInterfaceRegistry(
  client: RemoteModelDBClient,
  libraryCode: string,
): Promise<OperationInterfaceRegistryRecord[]> {
  const code = requireLibraryCode(libraryCode);
  const raw = await client.model(SYS_OPERATION_INTERFACE).query().execute();
  return (Array.isArray(raw) ? raw : [])
    .map(hydrateRowData)
    .filter((row) => row.library_code === code)
    .map(rowToRecord)
    .filter((record): record is OperationInterfaceRegistryRecord => Boolean(record))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function upsertOperationInterfaceRegistry(
  client: RemoteModelDBClient,
  libraryCode: string,
  record: OperationInterfaceRegistryRecord,
): Promise<void> {
  const code = requireLibraryCode(libraryCode);
  const rows = await client.model(SYS_OPERATION_INTERFACE).query().execute();
  const existing = (Array.isArray(rows) ? rows : [])
    .map(hydrateRowData)
    .find((row) => row.library_code === code && logicalInterfaceId(row) === record.id);
  const partial = recordPartial(record, code);
  if (existing && typeof existing._id === 'string') {
    const result = await client.batchUpdate(
      [{ model: SYS_OPERATION_INTERFACE, id: existing._id, partial }],
      { sync: true },
    );
    if (result.failureCount > 0) {
      throw new Error('OPERATION_INTERFACE_REGISTRY_UPDATE_FAILED');
    }
    return;
  }
  const result = await client
    .model(SYS_OPERATION_INTERFACE)
    .insertMany([{ _id: record.id, ...partial }], { sync: true });
  if (result.failureCount > 0) {
    throw new Error('OPERATION_INTERFACE_REGISTRY_INSERT_FAILED');
  }
}

export async function deleteOperationInterfaceRegistry(
  client: RemoteModelDBClient,
  libraryCode: string,
  id: string,
): Promise<void> {
  if (!libraryCode.trim() || !id) {
    return;
  }
  const rows = await client.model(SYS_OPERATION_INTERFACE).query().execute();
  const existing = (Array.isArray(rows) ? rows : [])
    .map(hydrateRowData)
    .find((row) => row.library_code === libraryCode.trim() && logicalInterfaceId(row) === id);
  if (!existing || typeof existing._id !== 'string') {
    return;
  }
  const result = await client.batchDelete([{ model: SYS_OPERATION_INTERFACE, id: existing._id }], {
    sync: true,
  });
  if (result.failureCount > 0) {
    throw new Error('OPERATION_INTERFACE_REGISTRY_DELETE_FAILED');
  }
}

function rowToRecord(
  row: Readonly<Record<string, unknown>>,
): OperationInterfaceRegistryRecord | undefined {
  const storageId = typeof row._id === 'string' ? row._id : '';
  const storedOperationInterface = parseJson<OperationInterface>(row.operation_json);
  const operationInterface = storedOperationInterface
    ? migrateOperationInterfaceContract(storedOperationInterface).value
    : undefined;
  const id = logicalInterfaceId(row) || operationInterface?.id || storageId;
  const name = typeof row.display_name === 'string' ? row.display_name.trim() : '';
  if (!storageId || !id || !name || operationInterface?.kind !== 'operation') {
    return undefined;
  }
  const releaseHistory = parseJson<OperationInterfaceRelease[]>(row.release_history_json);
  return {
    id,
    storageId,
    name,
    operationInterface,
    createdAt:
      typeof row.created_at === 'string' ? row.created_at : operationInterface.lifecycle.createdAt,
    updatedAt:
      typeof row.updated_at === 'string' ? row.updated_at : operationInterface.lifecycle.updatedAt,
    signature: typeof row.signature === 'string' && row.signature ? row.signature : undefined,
    publishedRelease: parseJson<OperationInterfaceRelease>(row.release_json),
    releaseHistory: Array.isArray(releaseHistory) ? releaseHistory : undefined,
  };
}

function recordPartial(
  record: OperationInterfaceRegistryRecord,
  libraryCode: string,
): Record<string, unknown> {
  return {
    library_code: libraryCode,
    interface_id: record.id,
    display_name: record.name,
    description: record.operationInterface.description ?? '',
    operation_json: JSON.stringify(record.operationInterface),
    signature: record.signature ?? '',
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    release_json: record.publishedRelease ? JSON.stringify(record.publishedRelease) : '',
    release_history_json:
      record.releaseHistory && record.releaseHistory.length > 0
        ? JSON.stringify(record.releaseHistory)
        : '',
  };
}

function logicalInterfaceId(row: Readonly<Record<string, unknown>>): string {
  if (typeof row.interface_id === 'string' && row.interface_id.trim()) {
    return row.interface_id.trim();
  }
  return parseJson<OperationInterface>(row.operation_json)?.id ?? '';
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
  throw new Error('OPERATION_INTERFACE_REGISTRY_BAD_ROW');
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

function requireLibraryCode(value: string): string {
  const code = value.trim();
  if (!code) {
    throw new Error('OPERATION_INTERFACE_REGISTRY_LIBRARY_REQUIRED');
  }
  return code;
}

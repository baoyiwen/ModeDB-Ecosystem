import type { RemoteModelDBClient } from '@mode-db/sdk';
import {
  SYS_QUERY_INTERFACE,
  SYS_QUERY_INTERFACE_CALL_LOG,
} from '../bootstrap/designer-storage-init.js';
import {
  migrateQueryInterfaceContract,
  type QueryChainState,
  type QueryInterface,
  type QueryInterfaceRelease,
} from '../query-designer/index.js';

export interface QueryInterfaceRegistryRecord {
  id: string;
  storageId?: string;
  name: string;
  queryInterface: QueryInterface;
  queryChain: QueryChainState;
  createdAt: string;
  updatedAt: string;
  signature?: string;
  projectionConfigured?: boolean;
  publishedRelease?: QueryInterfaceRelease;
  releaseHistory?: QueryInterfaceRelease[];
  auditSummary?: QueryInterfaceAuditSummary;
}

export interface QueryInterfaceAuditSummary {
  callCount: number;
  successCount: number;
  errorCount: number;
  averageDurationMs: number;
  lastCalledAt?: string;
  lastErrorCode?: string;
  trend: QueryInterfaceAuditTrendPoint[];
  recentCalls: QueryInterfaceAuditCall[];
}

export interface QueryInterfaceAuditTrendPoint {
  bucketStart: string;
  callCount: number;
  successCount: number;
  errorCount: number;
  averageDurationMs: number;
}

export interface QueryInterfaceAuditCall {
  startedAt: string;
  status: 'success' | 'error';
  durationMs: number;
  rowCount: number;
  version?: string;
  errorCode?: string;
  paginationMode?: string;
}

const AUDIT_TREND_BUCKET_MS = 2 * 60 * 60 * 1_000;
const AUDIT_TREND_BUCKET_COUNT = 12;
const AUDIT_RECENT_CALL_LIMIT = 8;

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
  const storageId = typeof row._id === 'string' ? row._id : '';
  const name = typeof row.display_name === 'string' ? row.display_name.trim() : '';
  const storedQueryInterface = parseJson<QueryInterface>(row.query_json);
  const queryInterface = storedQueryInterface
    ? migrateQueryInterfaceContract(storedQueryInterface).value
    : undefined;
  const queryChain = parseJson<QueryChainState>(row.chain_json);
  const publishedRelease = parseJson<QueryInterfaceRelease>(row.release_json);
  const releaseHistory = parseJson<QueryInterfaceRelease[]>(row.release_history_json);
  const id =
    (typeof row.interface_id === 'string' && row.interface_id.trim()) ||
    queryInterface?.id ||
    storageId;
  if (
    !id ||
    !storageId ||
    !name ||
    !queryInterface ||
    queryInterface.kind !== 'query' ||
    !queryChain
  ) {
    return undefined;
  }
  return {
    id,
    storageId,
    name,
    queryInterface,
    queryChain,
    createdAt:
      typeof row.created_at === 'string' ? row.created_at : queryInterface.lifecycle.createdAt,
    updatedAt:
      typeof row.updated_at === 'string' ? row.updated_at : queryInterface.lifecycle.updatedAt,
    signature: typeof row.signature === 'string' && row.signature ? row.signature : undefined,
    projectionConfigured: row.projection_configured === true,
    publishedRelease,
    releaseHistory: Array.isArray(releaseHistory) ? releaseHistory : undefined,
  };
}

function recordPartial(
  record: QueryInterfaceRegistryRecord,
  libraryCode: string,
): Record<string, unknown> {
  return {
    library_code: libraryCode,
    interface_id: record.id,
    display_name: record.name,
    description: record.queryInterface.description ?? '',
    query_json: JSON.stringify(record.queryInterface),
    chain_json: JSON.stringify(record.queryChain),
    signature: record.signature ?? '',
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    projection_configured: record.projectionConfigured === true,
    release_json: record.publishedRelease ? JSON.stringify(record.publishedRelease) : '',
    release_history_json:
      record.releaseHistory && record.releaseHistory.length > 0
        ? JSON.stringify(record.releaseHistory)
        : '',
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

export async function listQueryInterfaceAuditSummaries(
  client: RemoteModelDBClient,
  libraryCode: string,
): Promise<ReadonlyMap<string, QueryInterfaceAuditSummary>> {
  const code = libraryCode.trim();
  if (!code) {
    return new Map();
  }
  const raw = await client.model(SYS_QUERY_INTERFACE_CALL_LOG).query().execute();
  const rows = (Array.isArray(raw) ? raw : []).map((row) => hydrateRowData(row));
  return summarizeQueryInterfaceAuditRows(rows.filter((row) => row.library_code === code));
}

export function summarizeQueryInterfaceAuditRows(
  rows: readonly Readonly<Record<string, unknown>>[],
  nowMs = Date.now(),
): ReadonlyMap<string, QueryInterfaceAuditSummary> {
  const grouped = new Map<string, QueryInterfaceAuditAccumulator>();
  const currentBucketStart = Math.floor(nowMs / AUDIT_TREND_BUCKET_MS) * AUDIT_TREND_BUCKET_MS;
  const firstBucketStart =
    currentBucketStart - (AUDIT_TREND_BUCKET_COUNT - 1) * AUDIT_TREND_BUCKET_MS;
  for (const data of rows) {
    if (typeof data.callable_name !== 'string' || !data.callable_name) {
      continue;
    }
    const current = grouped.get(data.callable_name) ?? emptyAuditAccumulator(firstBucketStart);
    current.callCount += 1;
    const durationMs = finiteAuditNumber(data.duration_ms);
    current.durationTotal += durationMs;
    if (data.status === 'success') {
      current.successCount += 1;
    } else {
      current.errorCount += 1;
    }
    const startedAt = typeof data.started_at === 'string' ? data.started_at : '';
    if (startedAt && (!current.lastCalledAt || startedAt > current.lastCalledAt)) {
      current.lastCalledAt = startedAt;
    }
    if (
      data.status === 'error' &&
      typeof data.error_code === 'string' &&
      data.error_code &&
      (!current.lastErrorAt || startedAt >= current.lastErrorAt)
    ) {
      current.lastErrorAt = startedAt;
      current.lastErrorCode = data.error_code;
    }
    const startedMs = Date.parse(startedAt);
    const bucketIndex = Math.floor((startedMs - firstBucketStart) / AUDIT_TREND_BUCKET_MS);
    if (Number.isFinite(startedMs) && current.trend[bucketIndex]) {
      const bucket = current.trend[bucketIndex];
      bucket.callCount += 1;
      bucket.durationTotal += durationMs;
      if (data.status === 'success') {
        bucket.successCount += 1;
      } else {
        bucket.errorCount += 1;
      }
    }
    if (startedAt) {
      current.recentCalls.push({
        startedAt,
        status: data.status === 'success' ? 'success' : 'error',
        durationMs,
        rowCount: finiteAuditNumber(data.row_count),
        version:
          auditString(data.resolved_version) || auditString(data.requested_version) || undefined,
        errorCode: auditString(data.error_code) || undefined,
        paginationMode: auditString(data.pagination_mode) || undefined,
      });
    }
    grouped.set(data.callable_name, current);
  }
  return new Map(
    [...grouped].map(([callableName, summary]) => [
      callableName,
      {
        callCount: summary.callCount,
        successCount: summary.successCount,
        errorCount: summary.errorCount,
        averageDurationMs:
          summary.callCount > 0
            ? Number((summary.durationTotal / summary.callCount).toFixed(2))
            : 0,
        lastCalledAt: summary.lastCalledAt,
        lastErrorCode: summary.lastErrorCode,
        trend: summary.trend.map((bucket) => ({
          bucketStart: new Date(bucket.bucketStart).toISOString(),
          callCount: bucket.callCount,
          successCount: bucket.successCount,
          errorCount: bucket.errorCount,
          averageDurationMs:
            bucket.callCount > 0 ? Number((bucket.durationTotal / bucket.callCount).toFixed(2)) : 0,
        })),
        recentCalls: summary.recentCalls
          .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
          .slice(0, AUDIT_RECENT_CALL_LIMIT),
      },
    ]),
  );
}

interface QueryInterfaceAuditAccumulator {
  callCount: number;
  successCount: number;
  errorCount: number;
  durationTotal: number;
  lastCalledAt?: string;
  lastErrorAt?: string;
  lastErrorCode?: string;
  trend: QueryInterfaceAuditBucketAccumulator[];
  recentCalls: QueryInterfaceAuditCall[];
}

interface QueryInterfaceAuditBucketAccumulator {
  bucketStart: number;
  callCount: number;
  successCount: number;
  errorCount: number;
  durationTotal: number;
}

function emptyAuditAccumulator(firstBucketStart: number): QueryInterfaceAuditAccumulator {
  return {
    callCount: 0,
    successCount: 0,
    errorCount: 0,
    durationTotal: 0,
    trend: Array.from({ length: AUDIT_TREND_BUCKET_COUNT }, (_, index) => ({
      bucketStart: firstBucketStart + index * AUDIT_TREND_BUCKET_MS,
      callCount: 0,
      successCount: 0,
      errorCount: 0,
      durationTotal: 0,
    })),
    recentCalls: [],
  };
}

function finiteAuditNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function auditString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
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
  const existing = (Array.isArray(rows) ? rows : [])
    .map((row) => hydrateRowData(row))
    .find((row) => {
      const storedInterface = parseJson<QueryInterface>(row.query_json);
      const logicalId =
        (typeof row.interface_id === 'string' && row.interface_id.trim()) || storedInterface?.id;
      return logicalId === record.id && row.library_code === code;
    });
  if (existing && typeof existing._id === 'string') {
    const { failureCount } = await client.batchUpdate(
      [{ model: SYS_QUERY_INTERFACE, id: existing._id, partial }],
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
  const existing = (Array.isArray(rows) ? rows : [])
    .map((row) => hydrateRowData(row))
    .find((row) => {
      const storedInterface = parseJson<QueryInterface>(row.query_json);
      const logicalId =
        (typeof row.interface_id === 'string' && row.interface_id.trim()) || storedInterface?.id;
      return logicalId === id && row.library_code === libraryCode.trim();
    });
  if (!existing || typeof existing._id !== 'string') {
    return;
  }
  const { failureCount } = await client.batchDelete(
    [{ model: SYS_QUERY_INTERFACE, id: existing._id }],
    {
      sync: true,
    },
  );
  if (failureCount > 0) {
    throw new Error('QUERY_INTERFACE_REGISTRY_DELETE_FAILED');
  }
}

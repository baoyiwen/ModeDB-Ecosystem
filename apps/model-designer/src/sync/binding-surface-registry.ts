import type { RemoteModelDBClient } from '@mode-db/sdk';
import {
  SYS_BINDING_SURFACE,
  SYS_BINDING_SURFACE_CALL_LOG,
} from '../bootstrap/designer-storage-init.js';
import {
  migrateBindingSurfaceContract,
  type BindingSurface,
  type BindingSurfaceRelease,
} from '../query-designer/index.js';

export interface BindingSurfaceRegistryRecord {
  id: string;
  storageId?: string;
  name: string;
  bindingSurface: BindingSurface;
  createdAt: string;
  updatedAt: string;
  signature?: string;
  publishedRelease?: BindingSurfaceRelease;
  releaseHistory?: BindingSurfaceRelease[];
  auditSummary?: BindingSurfaceAuditSummary;
}

export interface BindingSurfaceAuditSummary {
  callCount: number;
  successCount: number;
  refreshFailureCount: number;
  errorCount: number;
  averageDurationMs: number;
  lastCalledAt?: string;
  lastErrorCode?: string;
  trend: BindingSurfaceAuditTrendPoint[];
  recentCalls: BindingSurfaceAuditCall[];
}

export interface BindingSurfaceAuditTrendPoint {
  bucketStart: string;
  callCount: number;
  successCount: number;
  refreshFailureCount: number;
  errorCount: number;
}

export interface BindingSurfaceAuditCall {
  startedAt: string;
  action: 'read' | 'mutate';
  mutationId?: string;
  status: 'success' | 'refresh_failed' | 'error';
  durationMs: number;
  rowCount: number;
  version?: string;
  errorCode?: string;
}

const AUDIT_TREND_BUCKET_MS = 2 * 60 * 60 * 1_000;
const AUDIT_TREND_BUCKET_COUNT = 12;
const AUDIT_RECENT_CALL_LIMIT = 8;

export async function listBindingSurfaceRegistry(
  client: RemoteModelDBClient,
  libraryCode: string,
): Promise<BindingSurfaceRegistryRecord[]> {
  const code = requireLibraryCode(libraryCode);
  const raw = await client.model(SYS_BINDING_SURFACE).query().execute();
  return (Array.isArray(raw) ? raw : [])
    .map(hydrateRowData)
    .filter((row) => row.library_code === code)
    .map(rowToRecord)
    .filter((record): record is BindingSurfaceRegistryRecord => Boolean(record))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function listBindingSurfaceAuditSummaries(
  client: RemoteModelDBClient,
  libraryCode: string,
): Promise<ReadonlyMap<string, BindingSurfaceAuditSummary>> {
  const code = libraryCode.trim();
  if (!code) {
    return new Map();
  }
  const raw = await client.model(SYS_BINDING_SURFACE_CALL_LOG).query().execute();
  const rows = (Array.isArray(raw) ? raw : []).map(hydrateRowData);
  return summarizeBindingSurfaceAuditRows(rows.filter((row) => row.library_code === code));
}

export function summarizeBindingSurfaceAuditRows(
  rows: readonly Readonly<Record<string, unknown>>[],
  nowMs = Date.now(),
): ReadonlyMap<string, BindingSurfaceAuditSummary> {
  const currentBucketStart = Math.floor(nowMs / AUDIT_TREND_BUCKET_MS) * AUDIT_TREND_BUCKET_MS;
  const firstBucketStart =
    currentBucketStart - (AUDIT_TREND_BUCKET_COUNT - 1) * AUDIT_TREND_BUCKET_MS;
  const grouped = new Map<string, BindingSurfaceAuditAccumulator>();
  for (const row of rows) {
    const surfaceId = auditString(row.surface_id);
    if (!surfaceId) {
      continue;
    }
    const current = grouped.get(surfaceId) ?? emptyAuditAccumulator(firstBucketStart);
    current.callCount += 1;
    const durationMs = finiteAuditNumber(row.duration_ms);
    current.durationTotal += durationMs;
    const status = auditStatus(row.status);
    if (status === 'success') {
      current.successCount += 1;
    } else if (status === 'refresh_failed') {
      current.refreshFailureCount += 1;
    } else {
      current.errorCount += 1;
    }
    const startedAt = auditString(row.started_at);
    if (startedAt && (!current.lastCalledAt || startedAt > current.lastCalledAt)) {
      current.lastCalledAt = startedAt;
    }
    const errorCode = auditString(row.error_code);
    if (errorCode && (!current.lastErrorAt || startedAt >= current.lastErrorAt)) {
      current.lastErrorAt = startedAt;
      current.lastErrorCode = errorCode;
    }
    const startedMs = Date.parse(startedAt);
    const bucketIndex = Math.floor((startedMs - firstBucketStart) / AUDIT_TREND_BUCKET_MS);
    const bucket = current.trend[bucketIndex];
    if (Number.isFinite(startedMs) && bucket) {
      bucket.callCount += 1;
      if (status === 'success') {
        bucket.successCount += 1;
      } else if (status === 'refresh_failed') {
        bucket.refreshFailureCount += 1;
      } else {
        bucket.errorCount += 1;
      }
    }
    if (startedAt) {
      current.recentCalls.push({
        startedAt,
        action: row.action === 'mutate' ? 'mutate' : 'read',
        ...(auditString(row.mutation_id) ? { mutationId: auditString(row.mutation_id) } : {}),
        status,
        durationMs,
        rowCount: finiteAuditNumber(row.row_count),
        ...(auditString(row.resolved_version)
          ? { version: auditString(row.resolved_version) }
          : auditString(row.requested_version)
            ? { version: auditString(row.requested_version) }
            : {}),
        ...(errorCode ? { errorCode } : {}),
      });
    }
    grouped.set(surfaceId, current);
  }
  return new Map(
    [...grouped.entries()].map(([surfaceId, summary]) => [
      surfaceId,
      {
        callCount: summary.callCount,
        successCount: summary.successCount,
        refreshFailureCount: summary.refreshFailureCount,
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
          refreshFailureCount: bucket.refreshFailureCount,
          errorCount: bucket.errorCount,
        })),
        recentCalls: summary.recentCalls
          .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
          .slice(0, AUDIT_RECENT_CALL_LIMIT),
      },
    ]),
  );
}

interface BindingSurfaceAuditAccumulator {
  callCount: number;
  successCount: number;
  refreshFailureCount: number;
  errorCount: number;
  durationTotal: number;
  lastCalledAt?: string;
  lastErrorAt?: string;
  lastErrorCode?: string;
  trend: Array<{
    bucketStart: number;
    callCount: number;
    successCount: number;
    refreshFailureCount: number;
    errorCount: number;
  }>;
  recentCalls: BindingSurfaceAuditCall[];
}

function emptyAuditAccumulator(firstBucketStart: number): BindingSurfaceAuditAccumulator {
  return {
    callCount: 0,
    successCount: 0,
    refreshFailureCount: 0,
    errorCount: 0,
    durationTotal: 0,
    trend: Array.from({ length: AUDIT_TREND_BUCKET_COUNT }, (_, index) => ({
      bucketStart: firstBucketStart + index * AUDIT_TREND_BUCKET_MS,
      callCount: 0,
      successCount: 0,
      refreshFailureCount: 0,
      errorCount: 0,
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

function auditStatus(value: unknown): BindingSurfaceAuditCall['status'] {
  return value === 'success' || value === 'refresh_failed' ? value : 'error';
}

export async function upsertBindingSurfaceRegistry(
  client: RemoteModelDBClient,
  libraryCode: string,
  record: BindingSurfaceRegistryRecord,
): Promise<void> {
  const code = requireLibraryCode(libraryCode);
  if (record.bindingSurface.id !== record.id) {
    throw new Error('BINDING_SURFACE_REGISTRY_ID_MISMATCH');
  }
  const rows = await client.model(SYS_BINDING_SURFACE).query().execute();
  const existing = (Array.isArray(rows) ? rows : [])
    .map(hydrateRowData)
    .find((row) => row.library_code === code && logicalSurfaceId(row) === record.id);
  const partial = recordPartial(record, code);
  if (existing && typeof existing._id === 'string') {
    const result = await client.batchUpdate(
      [{ model: SYS_BINDING_SURFACE, id: existing._id, partial }],
      { sync: true },
    );
    if (result.failureCount > 0) {
      throw new Error('BINDING_SURFACE_REGISTRY_UPDATE_FAILED');
    }
    return;
  }
  const result = await client
    .model(SYS_BINDING_SURFACE)
    .insertMany([{ _id: record.id, ...partial }], { sync: true });
  if (result.failureCount > 0) {
    throw new Error('BINDING_SURFACE_REGISTRY_INSERT_FAILED');
  }
}

export async function deleteBindingSurfaceRegistry(
  client: RemoteModelDBClient,
  libraryCode: string,
  id: string,
): Promise<void> {
  const code = libraryCode.trim();
  if (!code || !id) {
    return;
  }
  const rows = await client.model(SYS_BINDING_SURFACE).query().execute();
  const existing = (Array.isArray(rows) ? rows : [])
    .map(hydrateRowData)
    .find((row) => row.library_code === code && logicalSurfaceId(row) === id);
  if (!existing || typeof existing._id !== 'string') {
    return;
  }
  const result = await client.batchDelete([{ model: SYS_BINDING_SURFACE, id: existing._id }], {
    sync: true,
  });
  if (result.failureCount > 0) {
    throw new Error('BINDING_SURFACE_REGISTRY_DELETE_FAILED');
  }
}

function rowToRecord(
  row: Readonly<Record<string, unknown>>,
): BindingSurfaceRegistryRecord | undefined {
  const storageId = typeof row._id === 'string' ? row._id : '';
  const storedBindingSurface = parseJson<BindingSurface>(row.surface_json);
  const bindingSurface = storedBindingSurface
    ? migrateBindingSurfaceContract(storedBindingSurface).value
    : undefined;
  const id = logicalSurfaceId(row) || bindingSurface?.id || storageId;
  const name = typeof row.display_name === 'string' ? row.display_name.trim() : '';
  if (!storageId || !id || !name || bindingSurface?.kind !== 'binding') {
    return undefined;
  }
  const releaseHistory = parseJson<BindingSurfaceRelease[]>(row.release_history_json);
  return {
    id,
    storageId,
    name,
    bindingSurface,
    createdAt:
      typeof row.created_at === 'string' ? row.created_at : bindingSurface.lifecycle.createdAt,
    updatedAt:
      typeof row.updated_at === 'string' ? row.updated_at : bindingSurface.lifecycle.updatedAt,
    signature: typeof row.signature === 'string' && row.signature ? row.signature : undefined,
    publishedRelease: parseJson<BindingSurfaceRelease>(row.release_json),
    releaseHistory: Array.isArray(releaseHistory) ? releaseHistory : undefined,
  };
}

function recordPartial(
  record: BindingSurfaceRegistryRecord,
  libraryCode: string,
): Record<string, unknown> {
  return {
    library_code: libraryCode,
    surface_id: record.id,
    display_name: record.name,
    description: record.bindingSurface.description ?? '',
    surface_json: JSON.stringify(record.bindingSurface),
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

function logicalSurfaceId(row: Readonly<Record<string, unknown>>): string {
  if (typeof row.surface_id === 'string' && row.surface_id.trim()) {
    return row.surface_id.trim();
  }
  return parseJson<BindingSurface>(row.surface_json)?.id ?? '';
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
  throw new Error('BINDING_SURFACE_REGISTRY_BAD_ROW');
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
    throw new Error('BINDING_SURFACE_REGISTRY_LIBRARY_REQUIRED');
  }
  return code;
}

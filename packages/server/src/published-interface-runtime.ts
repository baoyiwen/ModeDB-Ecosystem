import { executeDatabaseOperation, type AuthoringEngine } from '@mode-db/core';
import {
  isQueryParameterPlaceholder,
  queryInterfaceErrorDetailFromMessage,
  type PublishedQueryExecutionTemplate,
  type PublishedQueryParameter,
  type PublishedQueryResultAdapter,
  type RemoteExecuteSnapshot,
  type WireEntityNode,
  type WireExecuteBody,
  type WireExecuteResultJson,
} from '@mode-db/shared';
import {
  enforcePublishedInterfaceAccess,
  enforcePublishedInterfaceRateLimit,
} from './published-interface-policy.js';
import type { AuthorizationService } from './security/authorization-service.js';

const QUERY_INTERFACE_MODEL = 'sys_query_interface';
const QUERY_INTERFACE_CALL_LOG_MODEL = 'sys_query_interface_call_log';
const auditCatalogReady = new WeakSet<AuthoringEngine>();

type ExecuteInterfaceBody = Extract<WireExecuteBody, { readonly op: 'executeInterface' }>;
type InterfaceWireResult = Extract<WireExecuteResultJson, { readonly kind: 'interface' }>;

interface StoredRelease {
  readonly version: string;
  readonly callableName: string;
  readonly signature: string;
  readonly queryInterface: {
    readonly status?: string;
    readonly contract?: {
      readonly permissions?: {
        readonly mode?: string;
        readonly accessKeyDigest?: string;
        readonly rateLimit?: {
          readonly maxRequests?: number;
          readonly windowSeconds?: number;
        };
      };
    };
  };
  readonly executionTemplate: PublishedQueryExecutionTemplate;
}

export async function executePublishedQueryInterface(input: {
  authorization?: AuthorizationService;
  atlas: string;
  designerWorkspace: string;
  body: ExecuteInterfaceBody;
  getEngine: (atlas: string) => Promise<AuthoringEngine>;
  includeRecordRefs?: boolean;
}): Promise<InterfaceWireResult> {
  const startedAt = new Date();
  const startedMs = performance.now();
  try {
    const result = await executePublishedQueryInterfaceCore(input);
    await writeInterfaceAudit(input, {
      startedAt,
      durationMs: performance.now() - startedMs,
      status: 'success',
      resolvedVersion: result.version,
      rowCount: result.rows.length,
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeInterfaceAudit(input, {
      startedAt,
      durationMs: performance.now() - startedMs,
      status: 'error',
      errorCode: queryInterfaceErrorDetailFromMessage(message)?.code ?? 'INTERFACE_RUNTIME_ERROR',
    });
    throw error;
  }
}

async function executePublishedQueryInterfaceCore(input: {
  authorization?: AuthorizationService;
  atlas: string;
  designerWorkspace: string;
  body: ExecuteInterfaceBody;
  getEngine: (atlas: string) => Promise<AuthoringEngine>;
  includeRecordRefs?: boolean;
}): Promise<InterfaceWireResult> {
  const callableName = input.body.callableName.trim();
  if (!callableName) {
    throw new Error('INTERFACE_CALLABLE_NAME_REQUIRED');
  }
  const designer = await input.getEngine(input.designerWorkspace);
  if (!designer.registry.getModel(QUERY_INTERFACE_MODEL)) {
    throw new Error('INTERFACE_REGISTRY_UNAVAILABLE');
  }
  const rows = await designer.persistence.getMergedReader().getAll(QUERY_INTERFACE_MODEL);
  const matches = rows
    .filter((row) => row.library_code === input.atlas)
    .flatMap((row) => releasesForRequest(row, input.body.version))
    .filter(
      (release) =>
        release.callableName === callableName &&
        release.queryInterface.status === 'active' &&
        (!input.body.version || release.version === input.body.version),
    );
  if (matches.length === 0) {
    throw new Error(
      input.body.version
        ? `INTERFACE_RELEASE_NOT_FOUND:${callableName}@${input.body.version}`
        : `INTERFACE_RELEASE_NOT_FOUND:${callableName}`,
    );
  }
  if (matches.length > 1) {
    throw new Error(`INTERFACE_RELEASE_AMBIGUOUS:${callableName}`);
  }
  const release = matches[0]!;
  input.authorization?.release(input.atlas, 'callable.query', callableName, release);
  const policyRelease = {
    version: release.version,
    callableName: release.callableName,
    interfaceContract: release.queryInterface.contract ?? {},
  };
  enforcePublishedInterfaceAccess(policyRelease, input.body.accessKey);
  enforcePublishedInterfaceRateLimit(input.atlas, 'query', policyRelease);
  const snapshot = bindExecutionSnapshot(
    release.executionTemplate,
    input.body.parameters ?? {},
    input.body,
  );
  const target = await input.getEngine(input.atlas);
  input.authorization?.release(input.atlas, 'callable.query', callableName, release);
  const raw = await executeDatabaseOperation(
    { runtime: target.createRuntime(), atlas: input.atlas },
    { op: 'executeQuery', snapshot },
  );
  return adaptInterfaceResult(
    callableName,
    release.version,
    raw,
    release.executionTemplate.resultAdapter,
    input.includeRecordRefs === true,
  );
}

async function writeInterfaceAudit(
  input: {
    atlas: string;
    designerWorkspace: string;
    body: ExecuteInterfaceBody;
    getEngine: (atlas: string) => Promise<AuthoringEngine>;
  },
  audit: {
    startedAt: Date;
    durationMs: number;
    status: 'success' | 'error';
    resolvedVersion?: string;
    rowCount?: number;
    errorCode?: string;
  },
): Promise<void> {
  try {
    const designer = await input.getEngine(input.designerWorkspace);
    ensureAuditCatalog(designer);
    const hasCursor = Object.prototype.hasOwnProperty.call(input.body, 'cursor');
    const paginationMode = hasCursor ? 'cursor' : input.body.page !== undefined ? 'offset' : 'none';
    await designer.insert(QUERY_INTERFACE_CALL_LOG_MODEL, {
      library_code: input.atlas,
      callable_name: input.body.callableName.trim(),
      requested_version: input.body.version ?? '',
      resolved_version: audit.resolvedVersion ?? '',
      status: audit.status,
      error_code: audit.errorCode ?? '',
      started_at: audit.startedAt.toISOString(),
      duration_ms: Number(audit.durationMs.toFixed(2)),
      row_count: audit.rowCount ?? 0,
      parameter_count: Object.keys(input.body.parameters ?? {}).length,
      pagination_mode: paginationMode,
    });
  } catch {
    // Audit persistence must never change the interface invocation outcome.
  }
}

function ensureAuditCatalog(designer: AuthoringEngine): void {
  if (auditCatalogReady.has(designer)) {
    return;
  }
  if (!designer.registry.getModel(QUERY_INTERFACE_CALL_LOG_MODEL)) {
    designer.registerModel(QUERY_INTERFACE_CALL_LOG_MODEL, {
      library_code: 'String',
      callable_name: 'String',
      requested_version: 'String',
      resolved_version: 'String',
      status: 'String',
      error_code: 'String',
      started_at: 'String',
      duration_ms: 'Number',
      row_count: 'Int',
      parameter_count: 'Int',
      pagination_mode: 'String',
    });
  }
  auditCatalogReady.add(designer);
}

function releasesForRequest(
  row: Readonly<Record<string, unknown>>,
  requestedVersion: string | undefined,
): StoredRelease[] {
  const current = parseRelease(row.release_json);
  if (!requestedVersion) {
    return current ? [current] : [];
  }
  const history = parseReleaseHistory(row.release_history_json);
  const requested = [...(current ? [current] : []), ...history].filter(
    (release) => release.version === requestedVersion,
  );
  return requested.filter(
    (release, index) =>
      requested.findIndex(
        (candidate) =>
          candidate.version === release.version &&
          candidate.callableName === release.callableName &&
          candidate.signature === release.signature,
      ) === index,
  );
}

function parseReleaseHistory(value: unknown): StoredRelease[] {
  if (typeof value !== 'string' || !value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed
          .map((entry) => parseStoredRelease(entry))
          .filter((entry): entry is StoredRelease => Boolean(entry))
      : [];
  } catch {
    return [];
  }
}

function parseRelease(value: unknown): StoredRelease | undefined {
  if (typeof value !== 'string' || !value) {
    return undefined;
  }
  try {
    return parseStoredRelease(JSON.parse(value) as unknown);
  } catch {
    return undefined;
  }
}

function parseStoredRelease(value: unknown): StoredRelease | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const parsed = value as Partial<StoredRelease>;
  if (
    typeof parsed.version !== 'string' ||
    typeof parsed.callableName !== 'string' ||
    typeof parsed.signature !== 'string' ||
    !parsed.queryInterface ||
    !parsed.executionTemplate ||
    parsed.executionTemplate.format !== 1
  ) {
    return undefined;
  }
  return parsed as StoredRelease;
}

function bindExecutionSnapshot(
  template: PublishedQueryExecutionTemplate,
  supplied: Readonly<Record<string, unknown>>,
  request: ExecuteInterfaceBody,
): RemoteExecuteSnapshot {
  const knownKeys = new Set(
    template.parameters.flatMap((parameter) => [parameter.id, parameter.name]),
  );
  const unknown = Object.keys(supplied).find((key) => !knownKeys.has(key));
  if (unknown) {
    throw new Error(`INTERFACE_PARAMETER_UNKNOWN:${unknown}`);
  }
  const values = new Map<string, unknown>();
  for (const parameter of template.parameters) {
    const value = resolveParameter(parameter, supplied);
    values.set(parameter.id, value);
  }
  const snapshot = replacePlaceholders(template.snapshot, values) as RemoteExecuteSnapshot;
  const execute = { ...snapshot.execute };
  const mode = template.pagination.mode;
  const requestedLimit = request.limit ?? template.pagination.defaultLimit;
  if (mode === 'none') {
    if (request.page !== undefined || request.cursor !== undefined || request.limit !== undefined) {
      throw new Error('INTERFACE_PAGINATION_DISABLED');
    }
    delete (execute as { page?: number }).page;
    delete (execute as { cursor?: string | null }).cursor;
    delete (execute as { limit?: number }).limit;
  } else {
    const limit = normalizeLimit(requestedLimit ?? 20, template.pagination.maxLimit);
    execute.limit = limit;
    if (mode === 'cursor') {
      if (request.page !== undefined) {
        throw new Error('INTERFACE_CURSOR_PAGE_CONFLICT');
      }
      execute.cursor = request.cursor ?? null;
      delete (execute as { page?: number }).page;
    } else {
      if (request.cursor !== undefined) {
        throw new Error('INTERFACE_OFFSET_CURSOR_CONFLICT');
      }
      execute.page = Math.max(0, Math.floor(request.page ?? 0));
      delete (execute as { cursor?: string | null }).cursor;
    }
  }
  return { ...snapshot, execute };
}

function resolveParameter(
  parameter: PublishedQueryParameter,
  supplied: Readonly<Record<string, unknown>>,
): unknown {
  const hasName = Object.prototype.hasOwnProperty.call(supplied, parameter.name);
  const hasId = Object.prototype.hasOwnProperty.call(supplied, parameter.id);
  const raw = hasName
    ? supplied[parameter.name]
    : hasId
      ? supplied[parameter.id]
      : parameter.defaultValue;
  if (raw === undefined || raw === '') {
    if (parameter.required) {
      throw new Error(`INTERFACE_PARAMETER_REQUIRED:${parameter.name}`);
    }
    return raw;
  }
  if (parameter.type === 'number') {
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      throw new Error(`INTERFACE_PARAMETER_INVALID:${parameter.name}:number`);
    }
    return value;
  }
  if (parameter.type === 'boolean') {
    if (typeof raw === 'boolean') {
      return raw;
    }
    if (raw === 'true' || raw === '1') {
      return true;
    }
    if (raw === 'false' || raw === '0') {
      return false;
    }
    throw new Error(`INTERFACE_PARAMETER_INVALID:${parameter.name}:boolean`);
  }
  if (parameter.type === 'json' && typeof raw === 'string') {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new Error(`INTERFACE_PARAMETER_INVALID:${parameter.name}:json`);
    }
  }
  return raw;
}

function replacePlaceholders(value: unknown, values: ReadonlyMap<string, unknown>): unknown {
  if (isQueryParameterPlaceholder(value)) {
    return values.get(value.$queryParameter);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => replacePlaceholders(entry, values));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        replacePlaceholders(child, values),
      ]),
    );
  }
  return value;
}

function normalizeLimit(limit: number, maximum: number | undefined): number {
  if (!Number.isFinite(limit) || limit < 1) {
    throw new Error('INTERFACE_PAGINATION_LIMIT_INVALID');
  }
  const normalized = Math.floor(limit);
  return maximum === undefined ? normalized : Math.min(normalized, maximum);
}

function adaptInterfaceResult(
  callableName: string,
  version: string,
  raw: WireExecuteResultJson,
  adapter: PublishedQueryResultAdapter,
  includeRecordRefs: boolean,
): InterfaceWireResult {
  if (raw.kind === 'paginated') {
    const rows = adaptRows(raw.items, adapter, includeRecordRefs);
    return {
      kind: 'interface',
      callableName,
      version,
      rows,
      total: raw.total,
      page: raw.page,
      pageCount: raw.pageCount,
      ...(raw.nextCursor ? { nextCursor: raw.nextCursor } : {}),
    };
  }
  return {
    kind: 'interface',
    callableName,
    version,
    rows: adaptRows(raw, adapter, includeRecordRefs),
  };
}

function adaptRows(
  raw: WireExecuteResultJson,
  adapter: PublishedQueryResultAdapter,
  includeRecordRefs: boolean,
): Record<string, unknown>[] {
  if (adapter.kind === 'rows') {
    if (raw.kind !== 'rows') {
      throw new Error(`INTERFACE_RESULT_KIND_MISMATCH:rows:${raw.kind}`);
    }
    return raw.rows.map((row) =>
      projectEntity(row, adapter.rootNodeId, adapter, 0, includeRecordRefs),
    );
  }
  if (raw.kind === 'analysis') {
    return raw.rows.map((row) => projectAggregation(row, adapter));
  }
  if (raw.kind === 'groups') {
    return raw.groups.map((group) => {
      const source: Record<string, unknown> = { ...group.aggregates };
      adapter.dimensions.forEach((dimension, index) => {
        source[dimension.sourceField] = group.dimensionValues[index];
      });
      return projectAggregation(source, adapter);
    });
  }
  throw new Error(`INTERFACE_RESULT_KIND_MISMATCH:aggregation:${raw.kind}`);
}

function projectEntity(
  entity: WireEntityNode,
  nodeId: string,
  adapter: Extract<PublishedQueryResultAdapter, { readonly kind: 'rows' }>,
  depth: number,
  includeRecordRefs: boolean,
): Record<string, unknown> {
  if (depth > 64) {
    throw new Error('INTERFACE_RESULT_DEPTH_EXCEEDED');
  }
  const output: Record<string, unknown> = {};
  const recordId = entity.data._id;
  if (includeRecordRefs && typeof recordId === 'string' && recordId) {
    output.$recordRef = { nodeId, model: entity.model, id: recordId };
  }
  for (const field of adapter.fieldsByNode[nodeId] ?? []) {
    output[field.outputName] = entity.data[field.sourceField];
  }
  for (const edge of adapter.edgesBySource[nodeId] ?? []) {
    output[edge.outputName] = (entity.relates?.[edge.relationName] ?? []).map((child) =>
      projectEntity(child, edge.toNodeId, adapter, depth + 1, includeRecordRefs),
    );
  }
  return output;
}

function projectAggregation(
  row: Readonly<Record<string, unknown>>,
  adapter: Extract<PublishedQueryResultAdapter, { readonly kind: 'aggregation' }>,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const dimension of adapter.dimensions) {
    output[dimension.outputName] = row[dimension.sourceField];
  }
  for (const metric of adapter.metrics) {
    output[metric.outputName] = row[metric.wireKey];
  }
  return output;
}

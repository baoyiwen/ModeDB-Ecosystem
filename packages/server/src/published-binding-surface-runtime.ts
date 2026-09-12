import type { AuthoringEngine } from '@mode-db/core';
import {
  isPublishedBindingSurfaceContract,
  queryInterfaceErrorDetailFromMessage,
  type BindingSurfaceParameterBinding,
  type PublishedBindingSurfaceContract,
  type PublishedQueryParameter,
  type WireBindingSurfaceAction,
  type WireBindingSurfaceResult,
  type WireExecuteBody,
  type WireOperationInterfaceResult,
  type WireQueryInterfaceResult,
} from '@mode-db/shared';
import { executePublishedQueryInterface } from './published-interface-runtime.js';
import { executePublishedOperationInterface } from './published-operation-interface-runtime.js';
import {
  enforcePublishedInterfaceAccess,
  enforcePublishedInterfaceRateLimit,
} from './published-interface-policy.js';

const BINDING_SURFACE_MODEL = 'sys_binding_surface';
const BINDING_SURFACE_CALL_LOG_MODEL = 'sys_binding_surface_call_log';
const auditCatalogReady = new WeakSet<AuthoringEngine>();

type ExecuteBindingSurfaceBody = Extract<WireExecuteBody, { readonly op: 'executeBindingSurface' }>;

interface StoredBindingSurfaceRelease {
  readonly version: string;
  readonly publishedAt: string;
  readonly signature: string;
  readonly bindingSurface: { readonly status?: string };
  readonly contract: PublishedBindingSurfaceContract;
}

export async function executePublishedBindingSurface(input: {
  atlas: string;
  designerWorkspace: string;
  body: ExecuteBindingSurfaceBody;
  getEngine: (atlas: string) => Promise<AuthoringEngine>;
}): Promise<WireBindingSurfaceResult> {
  const startedAt = new Date();
  const startedMs = performance.now();
  try {
    const result = await executePublishedBindingSurfaceCore(input);
    await writeBindingSurfaceAudit(input, {
      startedAt,
      durationMs: performance.now() - startedMs,
      status: result.status === 'refreshFailed' ? 'refresh_failed' : 'success',
      resolvedVersion: result.version,
      rowCount: result.query?.rows.length ?? 0,
      errorCode: result.refreshError?.code,
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeBindingSurfaceAudit(input, {
      startedAt,
      durationMs: performance.now() - startedMs,
      status: 'error',
      errorCode: queryInterfaceErrorDetailFromMessage(message)?.code ?? 'INTERFACE_RUNTIME_ERROR',
    });
    throw error;
  }
}

async function executePublishedBindingSurfaceCore(input: {
  atlas: string;
  designerWorkspace: string;
  body: ExecuteBindingSurfaceBody;
  getEngine: (atlas: string) => Promise<AuthoringEngine>;
}): Promise<WireBindingSurfaceResult> {
  const release = await resolveBindingSurfaceRelease(input);
  const policyRelease = {
    version: release.version,
    callableName: release.contract.surfaceId,
    interfaceContract: { permissions: release.contract.permissions },
  };
  enforcePublishedInterfaceAccess(policyRelease, input.body.accessKey);
  enforcePublishedInterfaceRateLimit(input.atlas, 'bindingSurface', policyRelease);
  const surfaceValues = resolveSurfaceParameters(
    release.contract.parameters,
    input.body.parameters ?? {},
  );
  const action = input.body.action;

  if (action.kind === 'read') {
    const query = await executeSurfaceQuery(input, release.contract, surfaceValues, action);
    return {
      kind: 'bindingSurface',
      surfaceId: release.contract.surfaceId,
      version: release.version,
      action: 'read',
      status: 'success',
      query,
    };
  }

  const mutation = release.contract.writeback.mutations.find(
    (candidate) => candidate.id === action.mutationId,
  );
  if (!mutation) {
    throw new Error(`INTERFACE_BINDING_MUTATION_NOT_FOUND:${action.mutationId}`);
  }
  const parameters = bindInterfaceParameters(mutation.parameterBindings, surfaceValues, action);
  const result = await executePublishedOperationInterface({
    atlas: input.atlas,
    designerWorkspace: input.designerWorkspace,
    body: {
      op: 'executeOperationInterface',
      callableName: mutation.operation.callableName,
      version: mutation.operation.version,
      parameters,
      ...accessKeyFor(input.body, mutation.operation),
    },
    getEngine: input.getEngine,
  });
  const mutationResult = { mutationId: mutation.id, result };
  if (release.contract.writeback.refresh === 'manual') {
    return mutationSuccess(release, mutationResult);
  }

  try {
    const query = await executeSurfaceQuery(input, release.contract, surfaceValues, action);
    return {
      ...mutationSuccess(release, mutationResult),
      query,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: 'bindingSurface',
      surfaceId: release.contract.surfaceId,
      version: release.version,
      action: 'mutate',
      status: 'refreshFailed',
      mutation: mutationResult,
      refreshError: queryInterfaceErrorDetailFromMessage(message) ?? {
        code: 'INTERFACE_BINDING_REFRESH_FAILED',
        message,
        category: 'runtime',
        retryable: false,
      },
    };
  }
}

async function writeBindingSurfaceAudit(
  input: {
    atlas: string;
    designerWorkspace: string;
    body: ExecuteBindingSurfaceBody;
    getEngine: (atlas: string) => Promise<AuthoringEngine>;
  },
  audit: {
    startedAt: Date;
    durationMs: number;
    status: 'success' | 'refresh_failed' | 'error';
    resolvedVersion?: string;
    rowCount?: number;
    errorCode?: string;
  },
): Promise<void> {
  try {
    const designer = await input.getEngine(input.designerWorkspace);
    ensureAuditCatalog(designer);
    await designer.insert(BINDING_SURFACE_CALL_LOG_MODEL, {
      library_code: input.atlas,
      surface_id: input.body.surfaceId.trim(),
      requested_version: input.body.version ?? '',
      resolved_version: audit.resolvedVersion ?? '',
      action: input.body.action.kind,
      mutation_id: input.body.action.kind === 'mutate' ? input.body.action.mutationId.trim() : '',
      status: audit.status,
      error_code: audit.errorCode ?? '',
      started_at: audit.startedAt.toISOString(),
      duration_ms: Number(audit.durationMs.toFixed(2)),
      parameter_count: Object.keys(input.body.parameters ?? {}).length,
      row_count: audit.rowCount ?? 0,
    });
  } catch {
    // Audit persistence must never change the BindingSurface invocation outcome.
  }
}

function ensureAuditCatalog(designer: AuthoringEngine): void {
  if (auditCatalogReady.has(designer)) {
    return;
  }
  if (!designer.registry.getModel(BINDING_SURFACE_CALL_LOG_MODEL)) {
    designer.registerModel(BINDING_SURFACE_CALL_LOG_MODEL, {
      library_code: 'String',
      surface_id: 'String',
      requested_version: 'String',
      resolved_version: 'String',
      action: 'String',
      mutation_id: 'String',
      status: 'String',
      error_code: 'String',
      started_at: 'String',
      duration_ms: 'Number',
      parameter_count: 'Int',
      row_count: 'Int',
    });
  }
  auditCatalogReady.add(designer);
}

async function resolveBindingSurfaceRelease(input: {
  atlas: string;
  designerWorkspace: string;
  body: ExecuteBindingSurfaceBody;
  getEngine: (atlas: string) => Promise<AuthoringEngine>;
}): Promise<StoredBindingSurfaceRelease> {
  const surfaceId = input.body.surfaceId.trim();
  if (!surfaceId) {
    throw new Error('INTERFACE_BINDING_SURFACE_ID_REQUIRED');
  }
  const designer = await input.getEngine(input.designerWorkspace);
  if (!designer.registry.getModel(BINDING_SURFACE_MODEL)) {
    throw new Error('INTERFACE_REGISTRY_UNAVAILABLE');
  }
  const rows = await designer.persistence.getMergedReader().getAll(BINDING_SURFACE_MODEL);
  const matches = rows
    .filter((row) => row.library_code === input.atlas && row.surface_id === surfaceId)
    .flatMap((row) => releasesForRequest(row, input.body.version))
    .filter(
      (release) =>
        release.contract.surfaceId === surfaceId &&
        release.bindingSurface.status === 'active' &&
        (!input.body.version || release.version === input.body.version),
    );
  if (matches.length === 0) {
    throw new Error(
      input.body.version
        ? `INTERFACE_BINDING_SURFACE_RELEASE_NOT_FOUND:${surfaceId}@${input.body.version}`
        : `INTERFACE_BINDING_SURFACE_RELEASE_NOT_FOUND:${surfaceId}`,
    );
  }
  if (matches.length > 1) {
    throw new Error(`INTERFACE_BINDING_SURFACE_RELEASE_AMBIGUOUS:${surfaceId}`);
  }
  return matches[0]!;
}

async function executeSurfaceQuery(
  input: {
    atlas: string;
    designerWorkspace: string;
    body: ExecuteBindingSurfaceBody;
    getEngine: (atlas: string) => Promise<AuthoringEngine>;
  },
  contract: PublishedBindingSurfaceContract,
  surfaceValues: ReadonlyMap<string, unknown>,
  action: WireBindingSurfaceAction,
): Promise<WireQueryInterfaceResult> {
  const parameters = bindInterfaceParameters(
    contract.query.parameterBindings,
    surfaceValues,
    action,
  );
  return executePublishedQueryInterface({
    atlas: input.atlas,
    designerWorkspace: input.designerWorkspace,
    body: {
      op: 'executeInterface',
      callableName: contract.query.callableName,
      version: contract.query.version,
      parameters,
      ...accessKeyFor(input.body, contract.query),
      ...(action.page !== undefined ? { page: action.page } : {}),
      ...(Object.prototype.hasOwnProperty.call(action, 'cursor')
        ? { cursor: action.cursor ?? null }
        : {}),
      ...(action.limit !== undefined ? { limit: action.limit } : {}),
    },
    getEngine: input.getEngine,
    includeRecordRefs: true,
  });
}

function mutationSuccess(
  release: StoredBindingSurfaceRelease,
  mutation: { readonly mutationId: string; readonly result: WireOperationInterfaceResult },
): WireBindingSurfaceResult {
  return {
    kind: 'bindingSurface',
    surfaceId: release.contract.surfaceId,
    version: release.version,
    action: 'mutate',
    status: 'success',
    mutation,
  };
}

function bindInterfaceParameters(
  bindings: readonly BindingSurfaceParameterBinding[],
  surfaceValues: ReadonlyMap<string, unknown>,
  action: WireBindingSurfaceAction,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    bindings.map((binding) => [binding.parameterId, bindingValue(binding, surfaceValues, action)]),
  );
}

function bindingValue(
  binding: BindingSurfaceParameterBinding,
  surfaceValues: ReadonlyMap<string, unknown>,
  action: WireBindingSurfaceAction,
): unknown {
  const source = binding.source;
  if (source.kind === 'surfaceParameter') {
    return surfaceValues.get(source.parameterId);
  }
  if (source.kind === 'literal') {
    return source.value;
  }
  if (action.kind !== 'mutate') {
    throw new Error(`INTERFACE_BINDING_VALUE_SOURCE_INVALID:${source.kind}`);
  }
  if (source.kind === 'editedValue') {
    return action.editedValue;
  }
  if (source.kind === 'rowRecordRef') {
    return action.recordRefs?.[source.nodeId]?.id;
  }
  return readRowField(action.row, source.fieldPath);
}

function readRowField(
  row: Readonly<Record<string, unknown>> | undefined,
  fieldPath: string,
): unknown {
  if (!row) {
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(row, fieldPath)) {
    return row[fieldPath];
  }
  let value: unknown = row;
  for (const segment of fieldPath.split('.')) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }
    value = (value as Readonly<Record<string, unknown>>)[segment];
  }
  return value;
}

function resolveSurfaceParameters(
  parameters: readonly PublishedQueryParameter[],
  supplied: Readonly<Record<string, unknown>>,
): ReadonlyMap<string, unknown> {
  const knownKeys = new Set(parameters.flatMap((parameter) => [parameter.id, parameter.name]));
  const unknown = Object.keys(supplied).find((key) => !knownKeys.has(key));
  if (unknown) {
    throw new Error(`INTERFACE_PARAMETER_UNKNOWN:${unknown}`);
  }
  return new Map(
    parameters.map((parameter) => [parameter.id, resolveParameter(parameter, supplied)]),
  );
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

function accessKeyFor(
  body: ExecuteBindingSurfaceBody,
  reference: { readonly interfaceId: string; readonly callableName: string },
): { readonly accessKey?: string } {
  const accessKey =
    body.accessKeys?.[reference.interfaceId] ?? body.accessKeys?.[reference.callableName];
  return accessKey ? { accessKey } : {};
}

function releasesForRequest(
  row: Readonly<Record<string, unknown>>,
  requestedVersion: string | undefined,
): StoredBindingSurfaceRelease[] {
  const current = parseRelease(row.release_json);
  if (!requestedVersion) {
    return current ? [current] : [];
  }
  const requested = [
    ...(current ? [current] : []),
    ...parseReleaseHistory(row.release_history_json),
  ].filter((release) => release.version === requestedVersion);
  return requested.filter(
    (release, index) =>
      requested.findIndex(
        (candidate) =>
          candidate.version === release.version && candidate.signature === release.signature,
      ) === index,
  );
}

function parseReleaseHistory(value: unknown): StoredBindingSurfaceRelease[] {
  if (typeof value !== 'string' || !value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed
          .map(parseStoredRelease)
          .filter((release): release is StoredBindingSurfaceRelease => Boolean(release))
      : [];
  } catch {
    return [];
  }
}

function parseRelease(value: unknown): StoredBindingSurfaceRelease | undefined {
  if (typeof value !== 'string' || !value) {
    return undefined;
  }
  try {
    return parseStoredRelease(JSON.parse(value) as unknown);
  } catch {
    return undefined;
  }
}

function parseStoredRelease(value: unknown): StoredBindingSurfaceRelease | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const parsed = value as Partial<StoredBindingSurfaceRelease>;
  if (
    typeof parsed.version !== 'string' ||
    typeof parsed.publishedAt !== 'string' ||
    typeof parsed.signature !== 'string' ||
    !parsed.bindingSurface ||
    !isPublishedBindingSurfaceContract(parsed.contract)
  ) {
    return undefined;
  }
  return parsed as StoredBindingSurfaceRelease;
}

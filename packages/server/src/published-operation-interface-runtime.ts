import { executeDatabaseOperation, type AuthoringEngine } from '@mode-db/core';
import {
  bindPublishedOperationBatchExecutionTemplate,
  bindPublishedOperationExecutionTemplate,
  isPublishedOperationExecutionTemplate,
  queryInterfaceErrorDetailFromMessage,
  type PublishedOperationExecutionTemplate,
  type WireExecuteBody,
  type WireExecuteResultJson,
} from '@mode-db/shared';
import {
  enforcePublishedInterfaceAccess,
  enforcePublishedInterfaceRateLimit,
} from './published-interface-policy.js';
import type { AuthorizationService } from './security/authorization-service.js';

const OPERATION_INTERFACE_MODEL = 'sys_operation_interface';
const OPERATION_INTERFACE_CALL_LOG_MODEL = 'sys_operation_interface_call_log';
const auditCatalogReady = new WeakSet<AuthoringEngine>();

type ExecuteOperationInterfaceBody = Extract<
  WireExecuteBody,
  { readonly op: 'executeOperationInterface' }
>;
type OperationInterfaceWireResult = Extract<
  WireExecuteResultJson,
  { readonly kind: 'operationInterface' }
>;

interface StoredOperationRelease {
  readonly version: string;
  readonly callableName: string;
  readonly signature: string;
  readonly operationInterface: {
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
  readonly executionTemplate: PublishedOperationExecutionTemplate;
}

export async function executePublishedOperationInterface(input: {
  authorization?: AuthorizationService;
  atlas: string;
  designerWorkspace: string;
  body: ExecuteOperationInterfaceBody;
  getEngine: (atlas: string) => Promise<AuthoringEngine>;
}): Promise<OperationInterfaceWireResult> {
  const startedAt = new Date();
  const startedMs = performance.now();
  try {
    const result = await executePublishedOperationInterfaceCore(input);
    await writeOperationAudit(input, {
      startedAt,
      durationMs: performance.now() - startedMs,
      status: 'success',
      resolvedVersion: result.version,
      operationType: result.operation,
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeOperationAudit(input, {
      startedAt,
      durationMs: performance.now() - startedMs,
      status: 'error',
      errorCode: queryInterfaceErrorDetailFromMessage(message)?.code ?? 'INTERFACE_RUNTIME_ERROR',
    });
    throw error;
  }
}

async function executePublishedOperationInterfaceCore(input: {
  authorization?: AuthorizationService;
  atlas: string;
  designerWorkspace: string;
  body: ExecuteOperationInterfaceBody;
  getEngine: (atlas: string) => Promise<AuthoringEngine>;
}): Promise<OperationInterfaceWireResult> {
  input.authorization?.preflight(input.atlas, input.body);
  const callableName = input.body.callableName.trim();
  if (!callableName) {
    throw new Error('INTERFACE_CALLABLE_NAME_REQUIRED');
  }
  const designer = await input.getEngine(input.designerWorkspace);
  if (!designer.registry.getModel(OPERATION_INTERFACE_MODEL)) {
    throw new Error('INTERFACE_REGISTRY_UNAVAILABLE');
  }
  const rows = await designer.persistence.getMergedReader().getAll(OPERATION_INTERFACE_MODEL);
  const matches = rows
    .filter((row) => row.library_code === input.atlas)
    .flatMap((row) => releasesForRequest(row, input.body.version))
    .filter(
      (release) =>
        release.callableName === callableName &&
        release.operationInterface.status === 'active' &&
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
  input.authorization?.release(input.atlas, 'callable.operation', callableName, release);
  const policyRelease = {
    version: release.version,
    callableName: release.callableName,
    interfaceContract: release.operationInterface.contract ?? {},
  };
  enforcePublishedInterfaceAccess(policyRelease, input.body.accessKey);
  enforcePublishedInterfaceRateLimit(input.atlas, 'operation', policyRelease);
  const target = await input.getEngine(input.atlas);
  const reauthorize = (): void =>
    input.authorization?.release(input.atlas, 'callable.operation', callableName, release);
  reauthorize();
  if (release.executionTemplate.batch) {
    return executePublishedOperationBatch({
      callableName,
      version: release.version,
      template: release.executionTemplate,
      parameters: input.body.parameters ?? {},
      target,
      atlas: input.atlas,
      reauthorize,
    });
  }
  const operation = bindPublishedOperationExecutionTemplate(
    release.executionTemplate,
    input.body.parameters ?? {},
  );
  const raw = await executeDatabaseOperation(
    { engine: target, atlas: input.atlas, flush: () => target.flushAll(), reauthorize },
    operation,
  );
  if (raw.kind !== 'mutation') {
    throw new Error(`INTERFACE_RESULT_KIND_MISMATCH:mutation:${raw.kind}`);
  }
  return {
    kind: 'operationInterface',
    callableName,
    version: release.version,
    operation: operationKind(release.executionTemplate),
    output: adaptOperationOutput(release.executionTemplate, raw),
  };
}

async function executePublishedOperationBatch(input: {
  callableName: string;
  version: string;
  template: PublishedOperationExecutionTemplate;
  parameters: Readonly<Record<string, unknown>>;
  target: AuthoringEngine;
  atlas: string;
  reauthorize: () => void;
}): Promise<OperationInterfaceWireResult> {
  const batch = bindPublishedOperationBatchExecutionTemplate(input.template, input.parameters);
  const itemResults: Array<Record<string, unknown>> = [];
  let successCount = 0;
  let failureCount = 0;
  let attemptedCount = 0;
  for (const item of batch.items) {
    attemptedCount += 1;
    if ('error' in item) {
      failureCount += 1;
      itemResults.push(batchFailureResult(item.index, item.error));
    } else {
      try {
        input.reauthorize();
        const raw = await executeDatabaseOperation(
          {
            engine: input.target,
            atlas: input.atlas,
            flush: () => input.target.flushAll(),
            reauthorize: input.reauthorize,
          },
          item.operation,
        );
        if (raw.kind !== 'mutation') {
          throw new Error(`INTERFACE_RESULT_KIND_MISMATCH:mutation:${raw.kind}`);
        }
        successCount += 1;
        itemResults.push(batchSuccessResult(item.index, raw));
      } catch (error) {
        failureCount += 1;
        itemResults.push(
          batchFailureResult(item.index, error instanceof Error ? error.message : String(error)),
        );
      }
    }
    if (failureCount > 0 && batch.failureMode === 'stop') {
      break;
    }
  }
  const skippedCount = batch.requestedCount - attemptedCount;
  const status = failureCount === 0 ? 'success' : successCount > 0 ? 'partial' : 'failed';
  return {
    kind: 'operationInterface',
    callableName: input.callableName,
    version: input.version,
    operation: 'batch',
    output: {
      ok: status === 'success',
      status,
      requestedCount: batch.requestedCount,
      attemptedCount,
      successCount,
      failureCount,
      skippedCount,
      ...(batch.includeItemResults ? { items: itemResults } : {}),
    },
  };
}

function batchSuccessResult(
  index: number,
  raw: Extract<WireExecuteResultJson, { readonly kind: 'mutation' }>,
): Record<string, unknown> {
  const record = raw.record ?? raw.records?.[0];
  const id = record?._id;
  return {
    index,
    ok: true,
    affectedCount: mutationAffectedCount(raw),
    ...(typeof id === 'string' ? { recordRef: { model: raw.model, id } } : {}),
  };
}

function batchFailureResult(index: number, message: string): Record<string, unknown> {
  const detail = queryInterfaceErrorDetailFromMessage(message);
  return {
    index,
    ok: false,
    error: {
      code: /^SECURITY_[A-Z_]+$/.test(message)
        ? message
        : (detail?.code ?? 'INTERFACE_BATCH_ITEM_FAILED'),
      message: detail?.message ?? message,
    },
  };
}

function mutationAffectedCount(
  raw: Extract<WireExecuteResultJson, { readonly kind: 'mutation' }>,
): number {
  return (
    raw.pairsCount ??
    raw.successCount ??
    (raw.ok !== undefined
      ? raw.ok
        ? 1
        : 0
      : raw.record !== null || Boolean(raw.records?.length)
        ? 1
        : 0)
  );
}

function adaptOperationOutput(
  template: PublishedOperationExecutionTemplate,
  raw: Extract<WireExecuteResultJson, { readonly kind: 'mutation' }>,
): unknown {
  if (template.result.returns === 'none') {
    return null;
  }
  if (template.result.returns === 'record') {
    return raw.record ?? raw.records?.[0] ?? null;
  }
  if (template.result.returns === 'recordRef') {
    const record = raw.record ?? raw.records?.[0];
    const id = record?._id;
    return typeof id === 'string' ? { model: raw.model, id } : null;
  }
  return {
    ok:
      raw.ok ??
      (raw.successCount !== undefined ? (raw.failureCount ?? 0) === 0 : raw.record !== null),
    affectedCount:
      raw.pairsCount ??
      raw.successCount ??
      (raw.ok !== undefined
        ? raw.ok
          ? 1
          : 0
        : raw.record !== null || raw.records?.length
          ? 1
          : 0),
    ...(raw.insertedCount !== undefined ? { insertedCount: raw.insertedCount } : {}),
    ...(raw.updatedCount !== undefined ? { updatedCount: raw.updatedCount } : {}),
    ...(raw.failureCount !== undefined ? { failureCount: raw.failureCount } : {}),
  };
}

function operationKind(
  template: PublishedOperationExecutionTemplate,
): 'create' | 'update' | 'delete' | 'upsert' | 'bind' | 'unbind' | 'rebind' | 'batch' {
  if (template.batch) {
    return 'batch';
  }
  if (template.operation.op === 'insert') {
    return 'create';
  }
  if (template.operation.op === 'bindPair') {
    return 'bind';
  }
  if (template.operation.op === 'unlinkPair') {
    return 'unbind';
  }
  if (template.operation.op === 'rebindPair') {
    return 'rebind';
  }
  if (template.operation.op === 'insertMany') {
    return 'upsert';
  }
  return template.operation.op;
}

function releasesForRequest(
  row: Readonly<Record<string, unknown>>,
  requestedVersion: string | undefined,
): StoredOperationRelease[] {
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
          candidate.version === release.version &&
          candidate.callableName === release.callableName &&
          candidate.signature === release.signature,
      ) === index,
  );
}

function parseReleaseHistory(value: unknown): StoredOperationRelease[] {
  if (typeof value !== 'string' || !value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed
          .map(parseStoredRelease)
          .filter((release): release is StoredOperationRelease => Boolean(release))
      : [];
  } catch {
    return [];
  }
}

function parseRelease(value: unknown): StoredOperationRelease | undefined {
  if (typeof value !== 'string' || !value) {
    return undefined;
  }
  try {
    return parseStoredRelease(JSON.parse(value) as unknown);
  } catch {
    return undefined;
  }
}

function parseStoredRelease(value: unknown): StoredOperationRelease | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const parsed = value as Partial<StoredOperationRelease>;
  if (
    typeof parsed.version !== 'string' ||
    typeof parsed.callableName !== 'string' ||
    typeof parsed.signature !== 'string' ||
    !parsed.operationInterface ||
    !isPublishedOperationExecutionTemplate(parsed.executionTemplate)
  ) {
    return undefined;
  }
  return parsed as StoredOperationRelease;
}

async function writeOperationAudit(
  input: {
    atlas: string;
    designerWorkspace: string;
    body: ExecuteOperationInterfaceBody;
    getEngine: (atlas: string) => Promise<AuthoringEngine>;
  },
  audit: {
    startedAt: Date;
    durationMs: number;
    status: 'success' | 'error';
    resolvedVersion?: string;
    operationType?: string;
    errorCode?: string;
  },
): Promise<void> {
  try {
    const designer = await input.getEngine(input.designerWorkspace);
    ensureAuditCatalog(designer);
    await designer.insert(OPERATION_INTERFACE_CALL_LOG_MODEL, {
      library_code: input.atlas,
      callable_name: input.body.callableName.trim(),
      requested_version: input.body.version ?? '',
      resolved_version: audit.resolvedVersion ?? '',
      operation_type: audit.operationType ?? '',
      status: audit.status,
      error_code: audit.errorCode ?? '',
      started_at: audit.startedAt.toISOString(),
      duration_ms: Number(audit.durationMs.toFixed(2)),
      parameter_count: Object.keys(input.body.parameters ?? {}).length,
    });
  } catch {
    // Audit persistence must never change the operation invocation outcome.
  }
}

function ensureAuditCatalog(designer: AuthoringEngine): void {
  if (auditCatalogReady.has(designer)) {
    return;
  }
  if (!designer.registry.getModel(OPERATION_INTERFACE_CALL_LOG_MODEL)) {
    designer.registerModel(OPERATION_INTERFACE_CALL_LOG_MODEL, {
      library_code: 'String',
      callable_name: 'String',
      requested_version: 'String',
      resolved_version: 'String',
      operation_type: 'String',
      status: 'String',
      error_code: 'String',
      started_at: 'String',
      duration_ms: 'Number',
      parameter_count: 'Int',
    });
  }
  auditCatalogReady.add(designer);
}

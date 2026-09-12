import type {
  BindingSurfaceParameterBinding,
  BindingSurfaceValueSource,
  PublishedBindingSurfaceContract,
} from '@mode-db/sdk';
import type { OperationInterfaceRelease } from './operation-interface-publication.js';
import type { QueryInterfaceRelease } from './query-interface-publication.js';
import type {
  BindingSurface,
  BindingSurfaceMutationBinding,
  InterfaceParameter,
  InterfacePermissionPolicy,
  OperationInterface,
  OperationType,
  QueryInterface,
  QueryResultField,
} from './types.js';

export interface BindingSurfaceCompilationDiagnostic {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  path?: string;
}

export interface BindingSurfaceCompilationResult {
  contract?: PublishedBindingSurfaceContract;
  diagnostics: BindingSurfaceCompilationDiagnostic[];
}

type QueryReleaseSource = Pick<
  QueryInterfaceRelease,
  'version' | 'callableName' | 'queryInterface'
>;
type OperationReleaseSource = Pick<
  OperationInterfaceRelease,
  'version' | 'callableName' | 'operationInterface'
>;

export function compileBindingSurface(input: {
  surface: BindingSurface;
  queryReleases: readonly QueryReleaseSource[];
  operationReleases: readonly OperationReleaseSource[];
}): BindingSurfaceCompilationResult {
  const { surface } = input;
  const diagnostics: BindingSurfaceCompilationDiagnostic[] = [];
  const error = (code: string, message: string, path?: string): void => {
    diagnostics.push({ code, severity: 'error', message, ...(path ? { path } : {}) });
  };

  if (!surface.id.trim()) {
    error('binding_surface_id_required', 'BindingSurface id is required.', 'id');
  }
  if (!surface.name.trim()) {
    error('binding_surface_name_required', 'BindingSurface name is required.', 'name');
  }
  if (!surface.version.current.trim()) {
    error(
      'binding_surface_version_required',
      'BindingSurface version is required.',
      'version.current',
    );
  }
  validateSurfaceParameters(surface.parameters, error);
  validateSurfacePermissions(surface.permissions, error);

  const queryRelease = input.queryReleases.find(
    (release) =>
      release.queryInterface.id === surface.query.interfaceId &&
      release.version === surface.query.version,
  );
  if (!queryRelease) {
    error(
      'binding_surface_query_release_missing',
      `QueryInterface release ${surface.query.interfaceId}@${surface.query.version} was not found.`,
      'query',
    );
  } else if (queryRelease.queryInterface.status !== 'active') {
    error(
      'binding_surface_query_release_inactive',
      'BindingSurface requires an active QueryInterface release.',
      'query',
    );
  }

  if (queryRelease) {
    validateParameterBindings({
      bindings: surface.query.parameterBindings,
      targetParameters: queryRelease.queryInterface.contract.parameters,
      surface,
      queryInterface: queryRelease.queryInterface,
      allowedSources: new Set(['surfaceParameter', 'literal']),
      path: 'query.parameterBindings',
      error,
    });
  }

  if (surface.writeback.mode === 'readonly' && surface.writeback.mutations.length > 0) {
    error(
      'binding_surface_readonly_mutations',
      'Readonly BindingSurface cannot declare mutation bindings.',
      'writeback.mutations',
    );
  }
  if (surface.writeback.mode === 'explicit' && surface.writeback.mutations.length === 0) {
    diagnostics.push({
      code: 'binding_surface_explicit_without_mutations',
      severity: 'warning',
      message: 'Explicit writeback mode has no mutation bindings.',
      path: 'writeback.mutations',
    });
  }

  const mutationIds = new Set<string>();
  const triggerKeys = new Set<string>();
  const resolvedMutations: Array<{
    binding: BindingSurfaceMutationBinding;
    release: OperationReleaseSource;
  }> = [];
  for (const [index, binding] of surface.writeback.mutations.entries()) {
    const path = `writeback.mutations.${index}`;
    if (!binding.id.trim()) {
      error(
        'binding_surface_mutation_id_required',
        'Mutation binding id is required.',
        `${path}.id`,
      );
    } else if (mutationIds.has(binding.id)) {
      error(
        'binding_surface_mutation_id_duplicate',
        `Mutation binding id "${binding.id}" is duplicated.`,
        `${path}.id`,
      );
    }
    mutationIds.add(binding.id);

    const triggerKey = bindingTriggerKey(binding);
    if (triggerKeys.has(triggerKey)) {
      error(
        'binding_surface_trigger_duplicate',
        `Writeback trigger "${triggerKey}" is mapped more than once.`,
        `${path}.trigger`,
      );
    }
    triggerKeys.add(triggerKey);

    const release = input.operationReleases.find(
      (candidate) =>
        candidate.operationInterface.id === binding.operation.interfaceId &&
        candidate.version === binding.operation.version,
    );
    if (!release) {
      error(
        'binding_surface_operation_release_missing',
        `OperationInterface release ${binding.operation.interfaceId}@${binding.operation.version} was not found.`,
        `${path}.operation`,
      );
      continue;
    }
    if (release.operationInterface.status !== 'active') {
      error(
        'binding_surface_operation_release_inactive',
        'BindingSurface requires active OperationInterface releases.',
        `${path}.operation`,
      );
    }
    if (!operationMatchesTrigger(release.operationInterface.operation.operationType, binding)) {
      error(
        'binding_surface_operation_type_mismatch',
        `Operation type "${release.operationInterface.operation.operationType}" cannot handle a "${binding.trigger.kind}" trigger.`,
        `${path}.operation`,
      );
    }
    if (queryRelease) {
      validateMutationTarget(
        binding,
        release.operationInterface,
        queryRelease.queryInterface,
        path,
        error,
      );
      validateParameterBindings({
        bindings: binding.parameterBindings,
        targetParameters: release.operationInterface.contract.parameters,
        surface,
        queryInterface: queryRelease.queryInterface,
        allowedSources: new Set([
          'surfaceParameter',
          'literal',
          'rowField',
          'rowRecordRef',
          ...(binding.trigger.kind === 'update' ? (['editedValue'] as const) : []),
        ]),
        path: `${path}.parameterBindings`,
        error,
      });
    }
    resolvedMutations.push({ binding, release });
  }

  if (diagnostics.some((diagnostic) => diagnostic.severity === 'error') || !queryRelease) {
    return { diagnostics };
  }

  return {
    contract: {
      format: 1,
      surfaceId: surface.id,
      name: surface.name,
      version: surface.version.current,
      ...(surface.permissions
        ? {
            permissions: {
              mode: surface.permissions.mode as 'none' | 'key' | 'disabled',
              ...(surface.permissions.accessKeyDigest
                ? { accessKeyDigest: surface.permissions.accessKeyDigest }
                : {}),
              ...(surface.permissions.rateLimit
                ? { rateLimit: structuredClone(surface.permissions.rateLimit) }
                : {}),
            },
          }
        : {}),
      parameters: structuredClone(surface.parameters),
      query: {
        interfaceId: queryRelease.queryInterface.id,
        callableName: queryRelease.callableName,
        version: queryRelease.version,
        parameterBindings: structuredClone(surface.query.parameterBindings),
      },
      writeback: {
        mode: surface.writeback.mode,
        refresh: surface.writeback.refresh,
        mutations: resolvedMutations.map(({ binding, release }) => ({
          id: binding.id,
          trigger: structuredClone(binding.trigger),
          operation: {
            interfaceId: release.operationInterface.id,
            callableName: release.callableName,
            version: release.version,
            operationType: release.operationInterface.operation.operationType as Exclude<
              OperationType,
              'batch'
            >,
          },
          parameterBindings: structuredClone(binding.parameterBindings),
        })),
      },
    },
    diagnostics,
  };
}

function validateSurfacePermissions(
  permissions: InterfacePermissionPolicy | undefined,
  error: (code: string, message: string, path?: string) => void,
): void {
  if (!permissions) {
    return;
  }
  if (!['none', 'key', 'disabled'].includes(permissions.mode)) {
    error(
      'binding_surface_permission_mode_unsupported',
      `BindingSurface permission mode "${permissions.mode}" is not supported.`,
      'permissions.mode',
    );
  }
  if (permissions.mode === 'key' && !permissions.accessKeyDigest?.trim()) {
    error(
      'binding_surface_access_key_required',
      'Key-protected BindingSurface requires an access key digest.',
      'permissions.accessKeyDigest',
    );
  }
  const rateLimit = permissions.rateLimit;
  if (
    rateLimit &&
    (!Number.isInteger(rateLimit.maxRequests) ||
      rateLimit.maxRequests < 1 ||
      rateLimit.maxRequests > 1_000_000)
  ) {
    error(
      'binding_surface_rate_limit_requests_invalid',
      'BindingSurface rate limit requests must be between 1 and 1,000,000.',
      'permissions.rateLimit.maxRequests',
    );
  }
  if (
    rateLimit &&
    (!Number.isInteger(rateLimit.windowSeconds) ||
      rateLimit.windowSeconds < 1 ||
      rateLimit.windowSeconds > 86_400)
  ) {
    error(
      'binding_surface_rate_limit_window_invalid',
      'BindingSurface rate limit window must be between 1 and 86,400 seconds.',
      'permissions.rateLimit.windowSeconds',
    );
  }
}

function validateSurfaceParameters(
  parameters: readonly InterfaceParameter[],
  error: (code: string, message: string, path?: string) => void,
): void {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const [index, parameter] of parameters.entries()) {
    const path = `parameters.${index}`;
    if (!parameter.id.trim() || !parameter.name.trim()) {
      error(
        'binding_surface_parameter_invalid',
        'BindingSurface parameters require non-empty ids and names.',
        path,
      );
    }
    if (ids.has(parameter.id) || names.has(parameter.name)) {
      error(
        'binding_surface_parameter_duplicate',
        `BindingSurface parameter "${parameter.name}" is duplicated.`,
        path,
      );
    }
    ids.add(parameter.id);
    names.add(parameter.name);
  }
}

function validateParameterBindings(input: {
  bindings: readonly BindingSurfaceParameterBinding[];
  targetParameters: readonly InterfaceParameter[];
  surface: BindingSurface;
  queryInterface: QueryInterface;
  allowedSources: ReadonlySet<BindingSurfaceValueSource['kind']>;
  path: string;
  error: (code: string, message: string, path?: string) => void;
}): void {
  const targetParameters = new Map(
    input.targetParameters.map((parameter) => [parameter.id, parameter]),
  );
  const surfaceParameters = new Set(input.surface.parameters.map((parameter) => parameter.id));
  const resultFields = flattenResultFields(input.queryInterface.query.result.schema);
  const nodeIds = new Set(input.queryInterface.designGraph.nodes.map((node) => node.id));
  const bound = new Set<string>();

  for (const [index, binding] of input.bindings.entries()) {
    const path = `${input.path}.${index}`;
    if (!targetParameters.has(binding.parameterId)) {
      input.error(
        'binding_surface_target_parameter_unknown',
        `Referenced interface parameter "${binding.parameterId}" does not exist.`,
        `${path}.parameterId`,
      );
    }
    if (bound.has(binding.parameterId)) {
      input.error(
        'binding_surface_target_parameter_duplicate',
        `Interface parameter "${binding.parameterId}" is bound more than once.`,
        `${path}.parameterId`,
      );
    }
    bound.add(binding.parameterId);

    if (!input.allowedSources.has(binding.source.kind)) {
      input.error(
        'binding_surface_value_source_not_allowed',
        `Value source "${binding.source.kind}" is not allowed in this binding.`,
        `${path}.source`,
      );
    }
    if (
      binding.source.kind === 'surfaceParameter' &&
      !surfaceParameters.has(binding.source.parameterId)
    ) {
      input.error(
        'binding_surface_parameter_source_unknown',
        `BindingSurface parameter "${binding.source.parameterId}" does not exist.`,
        `${path}.source.parameterId`,
      );
    }
    if (binding.source.kind === 'rowField' && !resultFields.has(binding.source.fieldPath)) {
      input.error(
        'binding_surface_row_field_unknown',
        `Query result field "${binding.source.fieldPath}" does not exist.`,
        `${path}.source.fieldPath`,
      );
    }
    if (binding.source.kind === 'rowRecordRef') {
      if (!input.queryInterface.query.result.includesRecordRefs) {
        input.error(
          'binding_surface_record_refs_required',
          'QueryInterface must include record references for row writeback.',
          `${path}.source`,
        );
      }
      if (!nodeIds.has(binding.source.nodeId)) {
        input.error(
          'binding_surface_row_node_unknown',
          `Query node "${binding.source.nodeId}" does not exist.`,
          `${path}.source.nodeId`,
        );
      }
    }
  }

  for (const parameter of input.targetParameters) {
    if (parameter.required && parameter.defaultValue === undefined && !bound.has(parameter.id)) {
      input.error(
        'binding_surface_required_parameter_unbound',
        `Required interface parameter "${parameter.name}" is not bound.`,
        input.path,
      );
    }
  }
}

function validateMutationTarget(
  binding: BindingSurfaceMutationBinding,
  operationInterface: OperationInterface,
  queryInterface: QueryInterface,
  path: string,
  error: (code: string, message: string, path?: string) => void,
): void {
  if (binding.trigger.kind === 'update') {
    const field = flattenResultFields(queryInterface.query.result.schema).get(
      binding.trigger.fieldPath,
    );
    if (!field?.source) {
      error(
        'binding_surface_update_field_not_writable',
        `Update field "${binding.trigger.fieldPath}" is missing or has no source field.`,
        `${path}.trigger.fieldPath`,
      );
      return;
    }
    const projection = queryInterface.query.projection.fields.find(
      (candidate) =>
        candidate.source.nodeId === field.source!.nodeId &&
        candidate.source.fieldId === field.source!.fieldId,
    );
    if (projection?.readonly) {
      error(
        'binding_surface_update_field_readonly',
        `Update field "${binding.trigger.fieldPath}" is readonly.`,
        `${path}.trigger.fieldPath`,
      );
    }
    if (!operationTargetsNode(operationInterface, queryInterface, field.source.nodeId)) {
      error(
        'binding_surface_operation_target_mismatch',
        'OperationInterface target does not match the query field node.',
        `${path}.operation`,
      );
    }
    return;
  }

  if (binding.trigger.kind === 'create' || binding.trigger.kind === 'delete') {
    const trigger = binding.trigger;
    if (!queryInterface.designGraph.nodes.some((node) => node.id === trigger.nodeId)) {
      error(
        'binding_surface_trigger_node_unknown',
        `Query node "${trigger.nodeId}" does not exist.`,
        `${path}.trigger.nodeId`,
      );
    } else if (!operationTargetsNode(operationInterface, queryInterface, trigger.nodeId)) {
      error(
        'binding_surface_operation_target_mismatch',
        'OperationInterface target does not match the query trigger node.',
        `${path}.operation`,
      );
    }
    return;
  }

  const trigger = binding.trigger;
  const queryEdge = queryInterface.designGraph.edges.find((edge) => edge.id === trigger.edgeId);
  if (!queryEdge) {
    error(
      'binding_surface_trigger_edge_unknown',
      `Query edge "${trigger.edgeId}" does not exist.`,
      `${path}.trigger.edgeId`,
    );
  } else if (operationTargetRelationId(operationInterface) !== queryEdge.relationId) {
    error(
      'binding_surface_operation_target_mismatch',
      'OperationInterface target does not match the query trigger relation.',
      `${path}.operation`,
    );
  }
}

function operationTargetsNode(
  operationInterface: OperationInterface,
  queryInterface: QueryInterface,
  queryNodeId: string,
): boolean {
  const queryModelId = queryInterface.designGraph.nodes.find(
    (node) => node.id === queryNodeId,
  )?.modelId;
  const target = operationInterface.operation.target;
  const targetModelId =
    target.kind === 'model'
      ? target.modelId
      : target.kind === 'node'
        ? operationInterface.designGraph.nodes.find((node) => node.id === target.nodeId)?.modelId
        : undefined;
  return Boolean(queryModelId && targetModelId === queryModelId);
}

function operationTargetRelationId(operationInterface: OperationInterface): string | undefined {
  const target = operationInterface.operation.target;
  if (target.kind === 'relation') {
    return target.relationId;
  }
  if (target.kind === 'edge') {
    return operationInterface.designGraph.edges.find((edge) => edge.id === target.edgeId)
      ?.relationId;
  }
  return undefined;
}

function operationMatchesTrigger(
  operationType: OperationType,
  binding: BindingSurfaceMutationBinding,
): boolean {
  if (operationType === 'batch') {
    return false;
  }
  if (binding.trigger.kind === 'create') {
    return operationType === 'create' || operationType === 'upsert';
  }
  if (binding.trigger.kind === 'update') {
    return operationType === 'update' || operationType === 'upsert';
  }
  return operationType === binding.trigger.kind;
}

function bindingTriggerKey(binding: BindingSurfaceMutationBinding): string {
  if (binding.trigger.kind === 'update') {
    return `update:${binding.trigger.fieldPath}`;
  }
  if (binding.trigger.kind === 'create' || binding.trigger.kind === 'delete') {
    return `${binding.trigger.kind}:${binding.trigger.nodeId}`;
  }
  return `${binding.trigger.kind}:${binding.trigger.edgeId}`;
}

function flattenResultFields(
  fields: readonly QueryResultField[],
  prefix = '',
): ReadonlyMap<string, QueryResultField> {
  const result = new Map<string, QueryResultField>();
  for (const field of fields) {
    const path = prefix ? `${prefix}.${field.name}` : field.name;
    result.set(path, field);
    for (const [childPath, child] of flattenResultFields(field.children ?? [], path)) {
      result.set(childPath, child);
    }
  }
  return result;
}

import type { PublishedQueryParameter } from './published-query-interface.js';

export type BindingSurfaceMutationKind =
  | 'create'
  | 'update'
  | 'delete'
  | 'bind'
  | 'unbind'
  | 'rebind';

export type BindingSurfaceOperationType = BindingSurfaceMutationKind | 'upsert';

export interface BindingSurfaceInterfaceReference {
  readonly interfaceId: string;
  readonly callableName: string;
  readonly version: string;
}

export type BindingSurfaceMutationTrigger =
  | { readonly kind: 'create'; readonly nodeId: string }
  | { readonly kind: 'update'; readonly fieldPath: string }
  | { readonly kind: 'delete'; readonly nodeId: string }
  | { readonly kind: 'bind' | 'unbind' | 'rebind'; readonly edgeId: string };

export type BindingSurfaceValueSource =
  | { readonly kind: 'surfaceParameter'; readonly parameterId: string }
  | { readonly kind: 'rowField'; readonly fieldPath: string }
  | { readonly kind: 'rowRecordRef'; readonly nodeId: string }
  | { readonly kind: 'editedValue' }
  | { readonly kind: 'literal'; readonly value: unknown };

export interface BindingSurfaceParameterBinding {
  readonly parameterId: string;
  readonly source: BindingSurfaceValueSource;
}

export interface PublishedBindingSurfaceMutation {
  readonly id: string;
  readonly trigger: BindingSurfaceMutationTrigger;
  readonly operation: BindingSurfaceInterfaceReference & {
    readonly operationType: BindingSurfaceOperationType;
  };
  readonly parameterBindings: readonly BindingSurfaceParameterBinding[];
}

export interface PublishedBindingSurfaceContract {
  readonly format: 1;
  readonly surfaceId: string;
  readonly name: string;
  readonly version: string;
  readonly permissions?: PublishedBindingSurfacePermissionPolicy;
  readonly parameters: readonly PublishedQueryParameter[];
  readonly query: BindingSurfaceInterfaceReference & {
    readonly parameterBindings: readonly BindingSurfaceParameterBinding[];
  };
  readonly writeback: {
    readonly mode: 'readonly' | 'explicit';
    readonly mutations: readonly PublishedBindingSurfaceMutation[];
    readonly refresh: 'manual' | 'afterMutation';
  };
}

export interface PublishedBindingSurfacePermissionPolicy {
  readonly mode: 'none' | 'key' | 'disabled';
  readonly accessKeyDigest?: string;
  readonly rateLimit?: {
    readonly maxRequests: number;
    readonly windowSeconds: number;
  };
}

export function isPublishedBindingSurfaceContract(
  value: unknown,
): value is PublishedBindingSurfaceContract {
  if (!isRecord(value) || value.format !== 1) {
    return false;
  }
  if (
    !nonEmptyString(value.surfaceId) ||
    !nonEmptyString(value.name) ||
    !nonEmptyString(value.version) ||
    !isPermissionPolicy(value.permissions) ||
    !Array.isArray(value.parameters) ||
    !value.parameters.every(isPublishedParameter) ||
    !isRecord(value.query) ||
    !isInterfaceReference(value.query) ||
    !Array.isArray(value.query.parameterBindings) ||
    !value.query.parameterBindings.every(isParameterBinding) ||
    !isRecord(value.writeback) ||
    !['readonly', 'explicit'].includes(String(value.writeback.mode)) ||
    !['manual', 'afterMutation'].includes(String(value.writeback.refresh)) ||
    !Array.isArray(value.writeback.mutations) ||
    !value.writeback.mutations.every(isMutation)
  ) {
    return false;
  }
  return value.writeback.mode === 'explicit' || value.writeback.mutations.length === 0;
}

function isPermissionPolicy(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (!isRecord(value) || !['none', 'key', 'disabled'].includes(String(value.mode))) {
    return false;
  }
  if (value.mode === 'key' && !nonEmptyString(value.accessKeyDigest)) {
    return false;
  }
  if (value.rateLimit === undefined) {
    return true;
  }
  return (
    isRecord(value.rateLimit) &&
    Number.isInteger(value.rateLimit.maxRequests) &&
    Number(value.rateLimit.maxRequests) > 0 &&
    Number.isInteger(value.rateLimit.windowSeconds) &&
    Number(value.rateLimit.windowSeconds) > 0
  );
}

function isMutation(value: unknown): boolean {
  return (
    isRecord(value) &&
    nonEmptyString(value.id) &&
    isMutationTrigger(value.trigger) &&
    isRecord(value.operation) &&
    isInterfaceReference(value.operation) &&
    ['create', 'update', 'delete', 'bind', 'unbind', 'rebind', 'upsert'].includes(
      String(value.operation.operationType),
    ) &&
    Array.isArray(value.parameterBindings) &&
    value.parameterBindings.every(isParameterBinding)
  );
}

function isMutationTrigger(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (value.kind === 'update') {
    return nonEmptyString(value.fieldPath);
  }
  if (value.kind === 'create' || value.kind === 'delete') {
    return nonEmptyString(value.nodeId);
  }
  if (value.kind === 'bind' || value.kind === 'unbind' || value.kind === 'rebind') {
    return nonEmptyString(value.edgeId);
  }
  return false;
}

function isParameterBinding(value: unknown): boolean {
  if (!isRecord(value) || !nonEmptyString(value.parameterId) || !isRecord(value.source)) {
    return false;
  }
  const source = value.source;
  if (source.kind === 'surfaceParameter') {
    return nonEmptyString(source.parameterId);
  }
  if (source.kind === 'rowField') {
    return nonEmptyString(source.fieldPath);
  }
  if (source.kind === 'rowRecordRef') {
    return nonEmptyString(source.nodeId);
  }
  if (source.kind === 'editedValue') {
    return true;
  }
  return source.kind === 'literal' && 'value' in source;
}

function isInterfaceReference(value: Readonly<Record<string, unknown>>): boolean {
  return (
    nonEmptyString(value.interfaceId) &&
    nonEmptyString(value.callableName) &&
    nonEmptyString(value.version)
  );
}

function isPublishedParameter(value: unknown): boolean {
  return (
    isRecord(value) &&
    nonEmptyString(value.id) &&
    nonEmptyString(value.name) &&
    [
      'string',
      'number',
      'boolean',
      'date',
      'datetime',
      'enum',
      'json',
      'recordRef',
      'relationRef',
    ].includes(String(value.type)) &&
    typeof value.required === 'boolean'
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

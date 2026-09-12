import type {
  BindingSurface,
  DesignerInterfaceAsset,
  OperationInterface,
  QueryInterface,
} from './types.js';
import {
  assessBindingSurfaceReleaseImpact,
  type BindingSurfaceRelease,
  type BindingSurfaceReleaseImpact,
} from './binding-surface-publication.js';
import {
  assessOperationInterfaceReleaseImpact,
  type OperationInterfaceRelease,
  type OperationInterfaceReleaseImpact,
} from './operation-interface-publication.js';
import {
  assessQueryInterfaceReleaseImpact,
  type QueryInterfaceRelease,
  type QueryInterfaceReleaseImpact,
} from './query-interface-publication.js';

export interface ContractMigrationResult<T extends DesignerInterfaceAsset> {
  value: T;
  changed: boolean;
  applied: string[];
}

export interface ReleaseRollbackPlan<T extends DesignerInterfaceAsset, TImpact> {
  targetVersion: string;
  draft: T;
  migration: ContractMigrationResult<T>;
  impact: TImpact;
}

export function migrateQueryInterfaceContract(
  asset: QueryInterface,
): ContractMigrationResult<QueryInterface> {
  const value = structuredClone(asset);
  const applied: string[] = [];
  applyDefault(value.contract, 'parameters', [], 'contract.parameters', applied);
  applyDefault(value.contract, 'errors', [], 'contract.errors', applied);
  if (value.contract.invocation.method !== 'query') {
    value.contract.invocation.method = 'query';
    applied.push('contract.invocation.method');
  }
  applyDefault(value.designGraph, 'nodes', [], 'designGraph.nodes', applied);
  applyDefault(value.designGraph, 'edges', [], 'designGraph.edges', applied);
  applyDefault(value.query.traversal, 'branches', [], 'query.traversal.branches', applied);
  applyDefault(value.query, 'filters', [], 'query.filters', applied);
  applyDefault(value.query, 'sorts', [], 'query.sorts', applied);
  applyDefault(value.query.projection, 'fields', [], 'query.projection.fields', applied);
  applyDefault(value.query.result, 'schema', [], 'query.result.schema', applied);
  applyDefault(
    value.query.result,
    'includesRecordRefs',
    false,
    'query.result.includesRecordRefs',
    applied,
  );
  migrateDependencies(value, applied);
  migrateVersion(value, applied);
  return migrationResult(value, applied);
}

export function migrateOperationInterfaceContract(
  asset: OperationInterface,
): ContractMigrationResult<OperationInterface> {
  const value = structuredClone(asset);
  const applied: string[] = [];
  applyDefault(value.contract, 'parameters', [], 'contract.parameters', applied);
  applyDefault(value.contract, 'errors', [], 'contract.errors', applied);
  if (value.contract.invocation.method !== 'mutation') {
    value.contract.invocation.method = 'mutation';
    applied.push('contract.invocation.method');
  }
  applyDefault(value.designGraph, 'nodes', [], 'designGraph.nodes', applied);
  applyDefault(value.designGraph, 'edges', [], 'designGraph.edges', applied);
  applyDefault(value.operation, 'inputMapping', [], 'operation.inputMapping', applied);
  applyDefault(value.operation, 'validationRules', [], 'operation.validationRules', applied);
  if (!value.operation.transactionPolicy) {
    value.operation.transactionPolicy =
      value.operation.operationType === 'batch'
        ? { mode: 'batch', rollbackOnFailure: false, failureMode: 'continue' }
        : { mode: 'single', rollbackOnFailure: true };
    applied.push('operation.transactionPolicy');
  } else if (
    value.operation.operationType === 'batch' &&
    !value.operation.transactionPolicy.failureMode
  ) {
    value.operation.transactionPolicy.failureMode = 'continue';
    applied.push('operation.transactionPolicy.failureMode');
  }
  migrateDependencies(value, applied);
  migrateVersion(value, applied);
  return migrationResult(value, applied);
}

export function migrateBindingSurfaceContract(
  asset: BindingSurface,
): ContractMigrationResult<BindingSurface> {
  const value = structuredClone(asset);
  const applied: string[] = [];
  applyDefault(value, 'parameters', [], 'parameters', applied);
  applyDefault(value.query, 'parameterBindings', [], 'query.parameterBindings', applied);
  if (!value.writeback) {
    value.writeback = { mode: 'readonly', mutations: [], refresh: 'manual' };
    applied.push('writeback');
  } else {
    applyDefault(value.writeback, 'mutations', [], 'writeback.mutations', applied);
    applyDefault(value.writeback, 'refresh', 'manual', 'writeback.refresh', applied);
  }
  migrateVersion(value, applied);
  return migrationResult(value, applied);
}

export function prepareQueryInterfaceRollback(input: {
  current: QueryInterfaceRelease;
  target: QueryInterfaceRelease;
  now?: string;
}): ReleaseRollbackPlan<QueryInterface, QueryInterfaceReleaseImpact> {
  const migration = migrateQueryInterfaceContract(input.target.queryInterface);
  const draft = rollbackDraft(migration.value, input.current.queryInterface, input.now);
  return {
    targetVersion: input.target.version,
    draft,
    migration,
    impact: assessQueryInterfaceReleaseImpact(draft, input.current),
  };
}

export function prepareOperationInterfaceRollback(input: {
  current: OperationInterfaceRelease;
  target: OperationInterfaceRelease;
  now?: string;
}): ReleaseRollbackPlan<OperationInterface, OperationInterfaceReleaseImpact> {
  const migration = migrateOperationInterfaceContract(input.target.operationInterface);
  const draft = rollbackDraft(migration.value, input.current.operationInterface, input.now);
  return {
    targetVersion: input.target.version,
    draft,
    migration,
    impact: assessOperationInterfaceReleaseImpact(draft, input.current),
  };
}

export function prepareBindingSurfaceRollback(input: {
  current: BindingSurfaceRelease;
  target: BindingSurfaceRelease;
  now?: string;
}): ReleaseRollbackPlan<BindingSurface, BindingSurfaceReleaseImpact> {
  const migration = migrateBindingSurfaceContract(input.target.bindingSurface);
  const draft = rollbackDraft(migration.value, input.current.bindingSurface, input.now);
  return {
    targetVersion: input.target.version,
    draft,
    migration,
    impact: assessBindingSurfaceReleaseImpact(draft, input.current),
  };
}

function rollbackDraft<T extends DesignerInterfaceAsset>(
  target: T,
  current: T,
  now = new Date().toISOString(),
): T {
  return {
    ...target,
    id: current.id,
    status: 'draft',
    version: {
      current: current.version.current,
      compatibility: 'draft',
      ...(current.version.history ? { history: structuredClone(current.version.history) } : {}),
    },
    lifecycle: {
      ...target.lifecycle,
      createdAt: current.lifecycle.createdAt,
      updatedAt: now,
      publishedAt: undefined,
      deprecatedAt: undefined,
    },
  };
}

function migrateDependencies(asset: QueryInterface | OperationInterface, applied: string[]): void {
  applyDefault(asset.dependencies, 'models', [], 'dependencies.models', applied);
  applyDefault(asset.dependencies, 'fields', [], 'dependencies.fields', applied);
  applyDefault(asset.dependencies, 'relations', [], 'dependencies.relations', applied);
}

function migrateVersion(asset: DesignerInterfaceAsset, applied: string[]): void {
  if (!['draft', 'compatible', 'breaking'].includes(asset.version.compatibility)) {
    asset.version.compatibility = asset.status === 'draft' ? 'draft' : 'compatible';
    applied.push('version.compatibility');
  }
}

function applyDefault<T extends object, K extends keyof T>(
  target: T,
  key: K,
  fallback: NonNullable<T[K]>,
  path: string,
  applied: string[],
): void {
  if (target[key] === undefined || target[key] === null) {
    target[key] = structuredClone(fallback) as T[K];
    applied.push(path);
  }
}

function migrationResult<T extends DesignerInterfaceAsset>(
  value: T,
  applied: string[],
): ContractMigrationResult<T> {
  return { value, changed: applied.length > 0, applied };
}

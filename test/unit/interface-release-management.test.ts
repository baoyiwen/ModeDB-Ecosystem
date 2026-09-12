import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assessBindingSurfaceReleaseImpact,
  assessOperationInterfaceReleaseImpact,
  customerOrdersQueryFixture,
  migrateBindingSurfaceContract,
  migrateOperationInterfaceContract,
  migrateQueryInterfaceContract,
  prepareOperationInterfaceRollback,
  type BindingSurface,
  type BindingSurfaceRelease,
  type OperationInterface,
  type OperationInterfaceRelease,
  type QueryInterface,
} from '../../apps/model-designer/src/query-designer/index.js';

const now = '2026-07-23T03:00:00.000Z';

describe('interface contract migration', () => {
  it('normalizes legacy query, operation, and BindingSurface defaults without mutating input', () => {
    const query = structuredClone(customerOrdersQueryFixture);
    delete (query.contract as Partial<QueryInterface['contract']>).errors;
    delete (query.query.traversal as Partial<QueryInterface['query']['traversal']>).branches;
    delete (query.query.result as Partial<QueryInterface['query']['result']>).includesRecordRefs;

    const operation = operationFixture('batch');
    delete operation.operation.transactionPolicy.failureMode;

    const surface = bindingSurfaceFixture();
    delete (surface.writeback as Partial<BindingSurface['writeback']>).refresh;

    const migratedQuery = migrateQueryInterfaceContract(query);
    const migratedOperation = migrateOperationInterfaceContract(operation);
    const migratedSurface = migrateBindingSurfaceContract(surface);

    assert.deepEqual(migratedQuery.value.contract.errors, []);
    assert.deepEqual(migratedQuery.value.query.traversal.branches, []);
    assert.equal(migratedQuery.value.query.result.includesRecordRefs, false);
    assert.equal(migratedOperation.value.operation.transactionPolicy.failureMode, 'continue');
    assert.equal(migratedSurface.value.writeback.refresh, 'manual');
    assert.equal(migratedQuery.changed, true);
    assert.equal(migratedOperation.changed, true);
    assert.equal(migratedSurface.changed, true);
    assert.equal('errors' in query.contract, false);
  });
});

describe('release compatibility and rollback planning', () => {
  it('uses minor for optional operation parameters and major for executable contract changes', () => {
    const current = operationRelease(operationFixture('update'), '1.2.3');
    const additive = structuredClone(current.operationInterface);
    additive.contract.parameters.push({
      id: 'optional_note',
      name: 'note',
      type: 'string',
      required: false,
    });
    const additiveImpact = assessOperationInterfaceReleaseImpact(additive, current);
    assert.equal(additiveImpact.level, 'minor');
    assert.equal(additiveImpact.compatibility, 'compatible');
    assert.equal(additiveImpact.recommendedVersion, '1.3.0');

    const breaking = structuredClone(current.operationInterface);
    breaking.operation.operationType = 'delete';
    const breakingImpact = assessOperationInterfaceReleaseImpact(breaking, current);
    assert.equal(breakingImpact.level, 'major');
    assert.equal(breakingImpact.compatibility, 'breaking');
    assert.equal(breakingImpact.recommendedVersion, '2.0.0');
  });

  it('classifies BindingSurface route additions separately from pinned-query changes', () => {
    const current = bindingSurfaceRelease(bindingSurfaceFixture(), '2.4.0');
    const additive = structuredClone(current.bindingSurface);
    additive.writeback = {
      mode: 'explicit',
      refresh: 'manual',
      mutations: [
        {
          id: 'update_status',
          trigger: { kind: 'update', fieldPath: 'status' },
          operation: { interfaceId: 'operation_update', version: '1.0.0' },
          parameterBindings: [],
        },
      ],
    };
    const additiveImpact = assessBindingSurfaceReleaseImpact(additive, current);
    assert.equal(additiveImpact.level, 'major');
    assert.equal(additiveImpact.recommendedVersion, '3.0.0');

    const pinnedQuery = structuredClone(current.bindingSurface);
    pinnedQuery.query.version = '2.0.0';
    const queryImpact = assessBindingSurfaceReleaseImpact(pinnedQuery, current);
    assert.equal(queryImpact.level, 'major');
    assert.equal(queryImpact.compatibility, 'breaking');
  });

  it('migrates a historical release into a draft and recommends a new rollback version', () => {
    const current = operationRelease(operationFixture('update'), '1.5.0');
    const historicalAsset = operationFixture('batch');
    delete historicalAsset.operation.transactionPolicy.failureMode;
    const target = operationRelease(historicalAsset, '1.1.0');

    const plan = prepareOperationInterfaceRollback({ current, target, now });

    assert.equal(plan.targetVersion, '1.1.0');
    assert.equal(plan.draft.status, 'draft');
    assert.equal(plan.draft.version.current, '1.5.0');
    assert.equal(plan.draft.lifecycle.updatedAt, now);
    assert.equal(plan.draft.operation.transactionPolicy.failureMode, 'continue');
    assert.equal(plan.migration.changed, true);
    assert.equal(plan.impact.level, 'major');
    assert.equal(plan.impact.recommendedVersion, '2.0.0');
  });
});

function operationFixture(type: 'update' | 'batch'): OperationInterface {
  const batch = type === 'batch';
  return {
    id: 'operation_update_item',
    kind: 'operation',
    name: 'updateItem',
    status: 'draft',
    version: { current: '0.1.0', compatibility: 'draft' },
    contract: {
      parameters: [
        { id: 'id', name: 'id', type: 'recordRef', required: true },
        { id: 'status', name: 'status', type: 'string', required: true },
      ],
      output: { shape: batch ? 'summary' : 'single' },
      errors: [],
      invocation: { method: 'mutation', callableName: 'updateItem' },
    },
    designGraph: {
      rootNodeId: 'item',
      nodes: [{ id: 'item', modelId: 'Item', alias: 'item', role: 'root' }],
      edges: [],
    },
    operation: {
      operationType: type,
      target: { kind: 'node', nodeId: 'item' },
      inputMapping: [],
      validationRules: [],
      transactionPolicy: batch
        ? { mode: 'batch', rollbackOnFailure: false, failureMode: 'continue' }
        : { mode: 'single', rollbackOnFailure: true },
      result: { returns: batch ? 'summary' : 'record' },
      ...(batch ? { batch: { itemOperationType: 'update', maxItems: 100 } } : {}),
    },
    dependencies: { models: ['Item'], fields: ['Item.status'], relations: [] },
    lifecycle: { createdAt: now, updatedAt: now },
  };
}

function operationRelease(
  operationInterface: OperationInterface,
  version: string,
): OperationInterfaceRelease {
  const active = structuredClone(operationInterface);
  active.status = 'active';
  active.version = { current: version, compatibility: 'compatible' };
  return {
    version,
    publishedAt: now,
    callableName: active.name,
    signature: JSON.stringify(active.operation),
    operationInterface: active,
    executionTemplate: {} as OperationInterfaceRelease['executionTemplate'],
  };
}

function bindingSurfaceFixture(): BindingSurface {
  return {
    id: 'surface_items',
    kind: 'binding',
    name: 'itemsSurface',
    status: 'draft',
    version: { current: '0.1.0', compatibility: 'draft' },
    parameters: [],
    query: { interfaceId: 'query_items', version: '1.0.0', parameterBindings: [] },
    writeback: { mode: 'readonly', mutations: [], refresh: 'manual' },
    lifecycle: { createdAt: now, updatedAt: now },
  };
}

function bindingSurfaceRelease(
  bindingSurface: BindingSurface,
  version: string,
): BindingSurfaceRelease {
  const active = structuredClone(bindingSurface);
  active.status = 'active';
  active.version = { current: version, compatibility: 'compatible' };
  return {
    version,
    publishedAt: now,
    signature: JSON.stringify(active),
    bindingSurface: active,
    contract: {} as BindingSurfaceRelease['contract'],
  };
}

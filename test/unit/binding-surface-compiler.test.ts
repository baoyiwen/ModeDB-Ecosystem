import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isPublishedBindingSurfaceContract } from '@mode-db/sdk';
import {
  compileBindingSurface,
  customerOrdersQueryFixture,
  type BindingSurface,
  type OperationInterface,
  type QueryInterface,
} from '../../apps/model-designer/src/query-designer/index.js';

const now = '2026-07-22T10:00:00.000Z';

describe('BindingSurface compiler', () => {
  it('pins query and operation releases in a serializable writeback contract', () => {
    const surface = editableSurface();
    surface.permissions = {
      mode: 'key',
      accessKeyDigest: 'digest',
      rateLimit: { maxRequests: 30, windowSeconds: 60 },
    };
    const result = compileBindingSurface({
      surface,
      queryReleases: [queryRelease()],
      operationReleases: [operationRelease()],
    });

    assert.deepEqual(result.diagnostics, []);
    assert.ok(result.contract);
    assert.equal(isPublishedBindingSurfaceContract(result.contract), true);
    assert.deepEqual(result.contract?.permissions, surface.permissions);
    assert.deepEqual(result.contract?.query, {
      interfaceId: 'query_customer_orders',
      callableName: 'customerOrders',
      version: '1.2.0',
      parameterBindings: [
        {
          parameterId: 'param_status',
          source: { kind: 'surfaceParameter', parameterId: 'surface_status' },
        },
      ],
    });
    assert.deepEqual(result.contract?.writeback.mutations[0]?.operation, {
      interfaceId: 'operation_update_order_status',
      callableName: 'updateOrderStatus',
      version: '2.0.1',
      operationType: 'update',
    });

    const malformed = {
      ...structuredClone(result.contract!),
      writeback: { ...structuredClone(result.contract!.writeback), mode: 'readonly' as const },
    };
    assert.equal(isPublishedBindingSurfaceContract(malformed), false);
  });

  it('rejects unsupported or incomplete surface policies', () => {
    const surface = editableSurface();
    surface.permissions = { mode: 'key', rateLimit: { maxRequests: 0, windowSeconds: 60 } };
    const result = compileBindingSurface({
      surface,
      queryReleases: [queryRelease()],
      operationReleases: [operationRelease()],
    });

    assert.equal(result.contract, undefined);
    assert.equal(
      result.diagnostics.some(
        (diagnostic) => diagnostic.code === 'binding_surface_access_key_required',
      ),
      true,
    );
    assert.equal(
      result.diagnostics.some(
        (diagnostic) => diagnostic.code === 'binding_surface_rate_limit_requests_invalid',
      ),
      true,
    );
  });

  it('blocks required operation parameters that have no value source', () => {
    const surface = editableSurface();
    surface.writeback.mutations[0]!.parameterBindings = surface.writeback.mutations[0]!.parameterBindings.filter(
      (binding) => binding.parameterId !== 'value',
    );

    const result = compileBindingSurface({
      surface,
      queryReleases: [queryRelease()],
      operationReleases: [operationRelease()],
    });

    assert.equal(result.contract, undefined);
    assert.equal(
      result.diagnostics.some(
        (diagnostic) => diagnostic.code === 'binding_surface_required_parameter_unbound',
      ),
      true,
    );
  });

  it('requires query record references for row writeback', () => {
    const release = queryRelease();
    release.queryInterface.query.result.includesRecordRefs = false;

    const result = compileBindingSurface({
      surface: editableSurface(),
      queryReleases: [release],
      operationReleases: [operationRelease()],
    });

    assert.equal(result.contract, undefined);
    assert.equal(
      result.diagnostics.some(
        (diagnostic) => diagnostic.code === 'binding_surface_record_refs_required',
      ),
      true,
    );
  });

  it('rejects operation types that do not match the UI trigger', () => {
    const release = operationRelease();
    release.operationInterface.operation.operationType = 'delete';

    const result = compileBindingSurface({
      surface: editableSurface(),
      queryReleases: [queryRelease()],
      operationReleases: [release],
    });

    assert.equal(result.contract, undefined);
    assert.equal(
      result.diagnostics.some(
        (diagnostic) => diagnostic.code === 'binding_surface_operation_type_mismatch',
      ),
      true,
    );
  });

  it('keeps readonly surfaces free of mutation routes', () => {
    const surface = editableSurface();
    surface.writeback = { mode: 'readonly', mutations: [], refresh: 'manual' };

    const result = compileBindingSurface({
      surface,
      queryReleases: [queryRelease()],
      operationReleases: [],
    });

    assert.ok(result.contract);
    assert.equal(result.contract?.writeback.mode, 'readonly');
    assert.deepEqual(result.contract?.writeback.mutations, []);
  });
});

function editableSurface(): BindingSurface {
  return {
    id: 'binding_customer_orders',
    kind: 'binding',
    name: 'customerOrdersEditor',
    status: 'draft',
    version: { current: '0.1.0', compatibility: 'draft' },
    parameters: [
      {
        id: 'surface_status',
        name: 'status',
        type: 'string',
        required: false,
      },
    ],
    query: {
      interfaceId: 'query_customer_orders',
      version: '1.2.0',
      parameterBindings: [
        {
          parameterId: 'param_status',
          source: { kind: 'surfaceParameter', parameterId: 'surface_status' },
        },
      ],
    },
    writeback: {
      mode: 'explicit',
      refresh: 'afterMutation',
      mutations: [
        {
          id: 'update_order_status',
          trigger: { kind: 'update', fieldPath: 'orders.orderStatus' },
          operation: {
            interfaceId: 'operation_update_order_status',
            version: '2.0.1',
          },
          parameterBindings: [
            {
              parameterId: 'record_id',
              source: { kind: 'rowRecordRef', nodeId: 'node_order' },
            },
            { parameterId: 'value', source: { kind: 'editedValue' } },
          ],
        },
      ],
    },
    lifecycle: { createdAt: now, updatedAt: now },
  };
}

function queryRelease(): {
  version: string;
  callableName: string;
  queryInterface: QueryInterface;
} {
  const queryInterface = structuredClone(customerOrdersQueryFixture);
  queryInterface.status = 'active';
  queryInterface.version = { current: '1.2.0', compatibility: 'compatible' };
  return { version: '1.2.0', callableName: 'customerOrders', queryInterface };
}

function operationRelease(): {
  version: string;
  callableName: string;
  operationInterface: OperationInterface;
} {
  return {
    version: '2.0.1',
    callableName: 'updateOrderStatus',
    operationInterface: {
      id: 'operation_update_order_status',
      kind: 'operation',
      name: 'updateOrderStatus',
      status: 'active',
      version: { current: '2.0.1', compatibility: 'compatible' },
      contract: {
        parameters: [
          {
            id: 'record_id',
            name: 'recordId',
            type: 'recordRef',
            required: true,
          },
          { id: 'value', name: 'value', type: 'string', required: true },
        ],
        output: { shape: 'summary' },
        errors: [],
        invocation: { method: 'mutation', callableName: 'updateOrderStatus' },
      },
      designGraph: {
        rootNodeId: 'operation_order',
        nodes: [
          {
            id: 'operation_order',
            modelId: 'Order',
            alias: 'order',
            role: 'root',
          },
        ],
        edges: [],
      },
      operation: {
        operationType: 'update',
        target: { kind: 'model', modelId: 'Order' },
        inputMapping: [
          {
            parameterId: 'record_id',
            target: { kind: 'model', modelId: 'Order' },
            mode: 'lookup',
            role: 'recordIdentity',
          },
          {
            parameterId: 'value',
            target: {
              nodeId: 'operation_order',
              modelId: 'Order',
              fieldId: 'status',
            },
            mode: 'set',
          },
        ],
        validationRules: [],
        transactionPolicy: { mode: 'single', rollbackOnFailure: true },
        result: { returns: 'summary' },
      },
      dependencies: {
        models: ['Order'],
        fields: ['Order.status'],
        relations: [],
      },
      lifecycle: { createdAt: now, updatedAt: now, publishedAt: now },
    },
  };
}

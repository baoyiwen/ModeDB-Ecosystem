import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { AuthoringEngine, executeDatabaseOperation } from '@mode-db/core';
import {
  compilePublishedOperationExecutionTemplate,
  operationInterfacePublicationSignature,
  publishOperationInterface,
  validateEngineInterface,
  type OperationInterface,
} from '../../apps/model-designer/src/query-designer/index.js';
import type {
  EngineModelNode,
  EngineRelationEdge,
} from '../../apps/model-designer/src/types/engine-schema.js';
import {
  bindPublishedOperationBatchExecutionTemplate,
  bindPublishedOperationExecutionTemplate,
  isInterfaceParameterPlaceholder,
} from '@mode-db/shared';

const models: EngineModelNode[] = [
  {
    id: 'Item',
    model_name: 'ItemRecord',
    parent_id: null,
    props_objects_array: [
      {
        id: 'name',
        name: 'item_name',
        type: 'string',
        is_primary: false,
        encrypt_level: 0,
        metadata: {},
      },
      {
        id: 'score',
        name: 'score',
        type: 'number',
        is_primary: false,
        encrypt_level: 0,
        metadata: {},
      },
    ],
  },
];

const relations: EngineRelationEdge[] = [
  {
    id: 'item_children_relation',
    source_model_id: 'Item',
    target_model_id: 'Item',
    forward_name: 'childrenLabel',
    reverse_name: 'parentLabel',
    engine_forward_name: 'children',
    engine_reverse_name: 'parent',
    kind: 'modelLinksOut',
    self_loop_policy: 'deny',
  },
];

describe('OperationInterface compiler', () => {
  it('compiles create field mappings to an insert template', () => {
    const asset = operationFixture('create');
    const result = compilePublishedOperationExecutionTemplate({ operationInterface: asset, models });

    assert.equal(result.diagnostics.length, 0);
    assert.deepEqual(result.template?.operation, {
      op: 'insert',
      model: 'ItemRecord',
      data: {
        item_name: { $interfaceParameter: 'param_name' },
        score: { $interfaceParameter: 'param_score' },
      },
      sync: true,
    });
    assert.equal(
      isInterfaceParameterPlaceholder(
        result.template?.operation.op === 'insert'
          ? result.template.operation.data.item_name
          : undefined,
      ),
      true,
    );
  });

  it('compiles update with one identity lookup and field patches', () => {
    const asset = operationFixture('update');
    const result = compilePublishedOperationExecutionTemplate({ operationInterface: asset, models });

    assert.equal(result.diagnostics.length, 0);
    assert.deepEqual(result.template?.operation, {
      op: 'update',
      model: 'ItemRecord',
      id: { $interfaceParameter: 'param_id' },
      partial: { item_name: { $interfaceParameter: 'param_name' } },
      sync: true,
    });
  });

  it('compiles delete to a target identity template', () => {
    const asset = operationFixture('delete');
    const result = compilePublishedOperationExecutionTemplate({ operationInterface: asset, models });

    assert.equal(result.diagnostics.length, 0);
    assert.deepEqual(result.template?.operation, {
      op: 'delete',
      model: 'ItemRecord',
      id: { $interfaceParameter: 'param_id' },
      sync: true,
    });
  });

  it('compiles a single-record upsert with explicit match fields', () => {
    const asset = upsertOperationFixture();
    const result = compilePublishedOperationExecutionTemplate({ operationInterface: asset, models });

    assert.equal(result.diagnostics.length, 0);
    assert.deepEqual(result.template?.operation, {
      op: 'insertMany',
      model: 'ItemRecord',
      rows: [
        {
          item_name: { $interfaceParameter: 'param_name' },
          score: { $interfaceParameter: 'param_score' },
        },
      ],
      sync: true,
      returning: true,
      upsert: { matchFields: ['item_name'], updateExisting: true },
    });
  });

  it('blocks an upsert without a match field', () => {
    const asset = upsertOperationFixture();
    asset.operation.inputMapping = asset.operation.inputMapping.filter(
      (mapping) => mapping.mode !== 'lookup',
    );
    const result = compilePublishedOperationExecutionTemplate({ operationInterface: asset, models });
    const validation = validateEngineInterface(asset, models);

    assert.equal(result.template, undefined);
    assert.equal(
      result.diagnostics.some((issue) => issue.code === 'operation_execution_upsert_match_required'),
      true,
    );
    assert.equal(
      validation.issues.some((issue) => issue.code === 'operation_upsert_match_required'),
      true,
    );
  });

  it('compiles a non-atomic batch wrapper and binds item parameters independently', () => {
    const asset = batchOperationFixture();
    const result = compilePublishedOperationExecutionTemplate({ operationInterface: asset, models });

    assert.equal(result.diagnostics.length, 0);
    assert.deepEqual(result.template?.batch, {
      itemsParameter: 'items',
      maxItems: 25,
      failureMode: 'continue',
    });
    assert.deepEqual(result.template?.transaction, {
      mode: 'batch',
      rollbackOnFailure: false,
    });
    assert.equal(result.template?.result.includeItemResults, true);
    assert.ok(result.template);
    const bound = bindPublishedOperationBatchExecutionTemplate(result.template, {
      items: [
        { id: 'row-1', name: 'First' },
        { id: '', name: 'Invalid' },
      ],
    });
    assert.equal(bound.items.length, 2);
    assert.deepEqual(bound.items[0], {
      index: 0,
      operation: {
        op: 'update',
        model: 'ItemRecord',
        id: 'row-1',
        partial: { item_name: 'First' },
        sync: true,
      },
    });
    assert.match('error' in bound.items[1]! ? bound.items[1].error : '', /BATCH_ITEM_INVALID:1/);
  });

  it('rejects atomic rollback claims for batch operations', () => {
    const asset = batchOperationFixture();
    asset.operation.transactionPolicy.rollbackOnFailure = true;
    const validation = validateEngineInterface(asset, models);
    const compilation = compilePublishedOperationExecutionTemplate({ operationInterface: asset, models });

    assert.equal(validation.ok, false);
    assert.equal(
      validation.issues.some((issue) => issue.code === 'operation_batch_transaction_unsupported'),
      true,
    );
    assert.equal(compilation.template, undefined);
  });

  it('compiles bind, unbind and rebind with explicit endpoint roles and stable engine names', () => {
    const expected = {
      bind: 'bindPair',
      unbind: 'unlinkPair',
      rebind: 'rebindPair',
    } as const;
    for (const type of ['bind', 'unbind', 'rebind'] as const) {
      const asset = relationshipOperationFixture(type);
      const result = compilePublishedOperationExecutionTemplate({
        operationInterface: asset,
        models,
        relations,
      });
      assert.equal(result.diagnostics.length, 0);
      assert.equal(result.template?.operation.op, expected[type]);
      assert.equal(result.template?.operation.forward, 'children');
      assert.equal(result.template?.operation.reverse, 'parent');
    }
  });

  it('validates that update and delete operations identify exactly one target record', () => {
    const asset = operationFixture('update');
    asset.operation.inputMapping = asset.operation.inputMapping.filter(
      (mapping) => mapping.mode !== 'lookup',
    );
    const validation = validateEngineInterface(asset, models);

    assert.equal(validation.ok, false);
    assert.equal(
      validation.issues.some((issue) => issue.code === 'operation_identity_mapping_required'),
      true,
    );
  });

  it('binds invocation parameters and executes the compiled insert operation', async () => {
    const asset = operationFixture('create');
    const compiled = compilePublishedOperationExecutionTemplate({ operationInterface: asset, models });
    assert.ok(compiled.template);
    const operation = bindPublishedOperationExecutionTemplate(compiled.template, {
      name: 'First item',
      score: '7',
    });
    assert.deepEqual(operation, {
      op: 'insert',
      model: 'ItemRecord',
      data: { item_name: 'First item', score: 7 },
      sync: true,
    });

    const root = mkdtempSync(join(tmpdir(), 'modedb-operation-interface-'));
    const engine = new AuthoringEngine({
      atlas: 'operation-interface',
      storageRoot: root,
      connectToken: 'test-token',
    });
    try {
      engine.registerModel('ItemRecord', { item_name: 'String', score: 'Number' });
      const result = await executeDatabaseOperation({ engine }, operation);
      assert.equal(result.kind, 'mutation');
      assert.equal(result.kind === 'mutation' ? result.record?.item_name : undefined, 'First item');
      assert.equal(result.kind === 'mutation' ? result.record?.score : undefined, 7);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inserts then updates the same record through a compiled upsert', async () => {
    const compiled = compilePublishedOperationExecutionTemplate({
      operationInterface: upsertOperationFixture(),
      models,
    });
    assert.ok(compiled.template);
    const root = mkdtempSync(join(tmpdir(), 'modedb-operation-upsert-'));
    const engine = new AuthoringEngine({
      atlas: 'operation-upsert',
      storageRoot: root,
      connectToken: 'test-token',
    });
    try {
      engine.registerModel('ItemRecord', { item_name: 'String', score: 'Number' });
      const first = await executeDatabaseOperation(
        { engine },
        bindPublishedOperationExecutionTemplate(compiled.template, {
          name: 'Stable key',
          score: 1,
        }),
      );
      const second = await executeDatabaseOperation(
        { engine },
        bindPublishedOperationExecutionTemplate(compiled.template, {
          name: 'Stable key',
          score: 2,
        }),
      );
      assert.equal(first.kind === 'mutation' ? first.insertedCount : undefined, 1);
      assert.equal(second.kind === 'mutation' ? second.updatedCount : undefined, 1);
      const rows = await engine.persistence.getMergedReader().getAll('ItemRecord');
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.score, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('restores the previous edge when rebind rejects the replacement pair', async () => {
    const root = mkdtempSync(join(tmpdir(), 'modedb-operation-rebind-'));
    const engine = new AuthoringEngine({
      atlas: 'operation-rebind',
      storageRoot: root,
      connectToken: 'test-token',
    });
    try {
      engine.registerModel('Node', { name: 'String' });
      engine.registerRelation('Node', 'Node', 'children', 'parent', 'one-to-many');
      const source = await engine.insert('Node', { name: 'Source' }, { sync: true });
      const previous = await engine.insert('Node', { name: 'Previous' }, { sync: true });
      await executeDatabaseOperation(
        { engine },
        {
          op: 'bindPair',
          forward: 'children',
          reverse: 'parent',
          source: { model: 'Node', id: source._id },
          target: { model: 'Node', id: previous._id },
        },
      );
      await assert.rejects(
        executeDatabaseOperation(
          { engine },
          {
            op: 'rebindPair',
            forward: 'children',
            reverse: 'parent',
            source: { model: 'Node', id: source._id },
            previousTarget: { model: 'Node', id: previous._id },
            nextTarget: { model: 'Node', id: source._id },
          },
        ),
        /replacement relation pair was rejected/,
      );
      const relation = engine.registry.getRelations().find((entry) => entry.forward === 'children');
      assert.ok(relation);
      assert.deepEqual(await engine.indexer.getForward(relation, source._id), [previous._id]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('publishes a compiled operation as an immutable active release', () => {
    const asset = operationFixture('create');
    const compiled = compilePublishedOperationExecutionTemplate({ operationInterface: asset, models });
    assert.ok(compiled.template);
    const published = publishOperationInterface({
      operationInterface: asset,
      signature: operationInterfacePublicationSignature(asset),
      executionTemplate: compiled.template,
      models,
      now: '2026-07-21T10:00:00.000Z',
    });

    assert.equal(published.ok, true);
    if (!published.ok) {
      return;
    }
    assert.equal(published.operationInterface.status, 'active');
    assert.equal(published.release.operationInterface.kind, 'operation');
    assert.equal(published.release.executionTemplate.operation.op, 'insert');
    assert.notEqual(published.release.operationInterface, published.operationInterface);
  });

  it('rejects a publication template that does not match the operation asset', () => {
    const asset = operationFixture('create');
    const compiled = compilePublishedOperationExecutionTemplate({ operationInterface: asset, models });
    assert.ok(compiled.template);
    const mismatched = {
      ...structuredClone(compiled.template),
      operation: { ...compiled.template.operation, model: 'AnotherModel' },
    };
    const published = publishOperationInterface({
      operationInterface: asset,
      signature: operationInterfacePublicationSignature(asset),
      executionTemplate: mismatched,
      models,
    });

    assert.equal(published.ok, false);
    if (!published.ok) {
      assert.equal(
        published.issues.some((issue) => issue.code === 'operation_publication_template_mismatch'),
        true,
      );
    }
  });
});

function operationFixture(type: 'create' | 'update' | 'delete'): OperationInterface {
  const now = '2026-07-21T00:00:00.000Z';
  const parameters: OperationInterface['contract']['parameters'] = [
    { id: 'param_id', name: 'id', type: 'recordRef', required: type !== 'create' },
    { id: 'param_name', name: 'name', type: 'string', required: type !== 'delete' },
    { id: 'param_score', name: 'score', type: 'number', required: false },
  ];
  const inputMapping: OperationInterface['operation']['inputMapping'] =
    type === 'create'
      ? [
          {
            parameterId: 'param_name',
            target: { nodeId: 'node_item', modelId: 'Item', fieldId: 'name' },
            mode: 'set',
          },
          {
            parameterId: 'param_score',
            target: { nodeId: 'node_item', modelId: 'Item', fieldId: 'score' },
            mode: 'set',
          },
        ]
      : [
          {
            parameterId: 'param_id',
            target: { kind: 'node', nodeId: 'node_item' },
            mode: 'lookup',
          },
          ...(type === 'update'
            ? [
                {
                  parameterId: 'param_name',
                  target: { nodeId: 'node_item', modelId: 'Item', fieldId: 'name' },
                  mode: 'set' as const,
                },
              ]
            : []),
        ];
  return {
    id: `operation_item_${type}`,
    kind: 'operation',
    name: `item${type}`,
    status: 'draft',
    version: { current: '0.1.0', compatibility: 'draft' },
    contract: {
      parameters,
      output: { shape: type === 'delete' ? 'summary' : 'single' },
      errors: [],
      invocation: { method: 'mutation', callableName: `item${type}` },
    },
    designGraph: {
      rootNodeId: 'node_item',
      nodes: [{ id: 'node_item', modelId: 'Item', alias: 'item', role: 'root' }],
      edges: [],
    },
    operation: {
      operationType: type,
      target: { kind: 'node', nodeId: 'node_item' },
      inputMapping,
      validationRules: [],
      transactionPolicy: { mode: 'single', rollbackOnFailure: true },
      result: { returns: type === 'delete' ? 'summary' : 'record' },
    },
    dependencies: { models: ['Item'], fields: ['Item.name', 'Item.score'], relations: [] },
    lifecycle: { createdAt: now, updatedAt: now },
  };
}

function relationshipOperationFixture(type: 'bind' | 'unbind' | 'rebind'): OperationInterface {
  const asset = operationFixture('create');
  const edgeTarget = { kind: 'edge' as const, edgeId: 'edge_items' };
  const source = {
    id: 'param_source',
    name: 'sourceId',
    type: 'recordRef' as const,
    required: true,
  };
  const target = {
    id: 'param_target',
    name: 'targetId',
    type: 'recordRef' as const,
    required: true,
  };
  const previousTarget = {
    id: 'param_previous_target',
    name: 'previousTargetId',
    type: 'recordRef' as const,
    required: true,
  };
  const nextTarget = {
    id: 'param_next_target',
    name: 'nextTargetId',
    type: 'recordRef' as const,
    required: true,
  };
  asset.contract.parameters =
    type === 'rebind' ? [source, previousTarget, nextTarget] : [source, target];
  asset.contract.output = { shape: 'summary' };
  asset.designGraph = {
    rootNodeId: 'node_source',
    nodes: [
      { id: 'node_source', modelId: 'Item', alias: 'source', role: 'root' },
      { id: 'node_target', modelId: 'Item', alias: 'target', role: 'joined' },
    ],
    edges: [
      {
        id: 'edge_items',
        relationId: 'item_children_relation',
        fromNodeId: 'node_source',
        toNodeId: 'node_target',
        alias: 'childrenLabel',
        required: true,
        cardinality: 'many',
        traversal: 'forward',
      },
    ],
  };
  asset.operation = {
    operationType: type,
    target: edgeTarget,
    inputMapping:
      type === 'rebind'
        ? [
            {
              parameterId: source.id,
              target: edgeTarget,
              mode: 'lookup',
              role: 'relationSource',
            },
            {
              parameterId: previousTarget.id,
              target: edgeTarget,
              mode: 'disconnect',
              role: 'relationPreviousTarget',
            },
            {
              parameterId: nextTarget.id,
              target: edgeTarget,
              mode: 'connect',
              role: 'relationNextTarget',
            },
          ]
        : [
            {
              parameterId: source.id,
              target: edgeTarget,
              mode: type === 'bind' ? 'connect' : 'disconnect',
              role: 'relationSource',
            },
            {
              parameterId: target.id,
              target: edgeTarget,
              mode: type === 'bind' ? 'connect' : 'disconnect',
              role: 'relationTarget',
            },
          ],
    validationRules: [],
    transactionPolicy: { mode: 'single', rollbackOnFailure: true },
    result: { returns: 'summary' },
  };
  asset.dependencies = { models: ['Item'], fields: [], relations: ['item_children_relation'] };
  return asset;
}

function upsertOperationFixture(): OperationInterface {
  const asset = operationFixture('create');
  asset.operation.operationType = 'upsert';
  asset.operation.inputMapping.push({
    parameterId: 'param_name',
    target: { nodeId: 'node_item', modelId: 'Item', fieldId: 'name' },
    mode: 'lookup',
  });
  return asset;
}

function batchOperationFixture(): OperationInterface {
  const asset = operationFixture('update');
  asset.operation = {
    ...asset.operation,
    operationType: 'batch',
    batch: { itemOperationType: 'update', maxItems: 25 },
    transactionPolicy: {
      mode: 'batch',
      rollbackOnFailure: false,
      failureMode: 'continue',
    },
    result: { returns: 'summary', includeItemResults: true },
  };
  asset.contract.output = { shape: 'summary' };
  return asset;
}
